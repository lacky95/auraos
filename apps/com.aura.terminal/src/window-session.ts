import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSessions } from './pty-server.ts';

/**
 * Which session each WINDOW last picked, so a reload lands back on it.
 *
 * A window's default session is its activity id; the picker re-points it
 * without the OS knowing, and that choice used to live only in the page's
 * memory — so reloading the OS UI put every window back on its default shell.
 *
 * Kept here rather than in the browser because the pick has the window's
 * lifetime, and only this container sees that end: `onActivityDestroy` drops
 * the entry. localStorage would outlive the window, and since activity ids are
 * recycled (the OS counter restarts with the instance) a new window would
 * inherit a dead one's pick.
 *
 * `/data` is per-instance, so the file only ever names this container's windows.
 */
const FILE = join(process.env['AURA_DATA_DIR'] ?? '/data', 'window-sessions.json');

function read(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function write(map: Record<string, string>): void {
  mkdirSync(join(FILE, '..'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(map), 'utf-8');
}

/**
 * The session `windowId` should open on, or null for its default.
 *
 * Only a shell that still exists counts. A pick whose session was closed from
 * another window or the MCP would otherwise be recreated empty under the old
 * name — and a container rebuilt under a recycled instance id has no live
 * shells at all, which is what retires a pick the destroy hook never saw.
 */
export function pickedSession(windowId: string | null): string | null {
  if (!windowId) return null;
  const want = read()[windowId];
  if (!want) return null;
  return listSessions().some((s) => s.id === want) ? want : null;
}

/** Remember `sessionId` for `windowId`; its own default (or null) forgets. */
export function pickSession(windowId: string, sessionId: string | null): void {
  const map = read();
  if (!sessionId || sessionId === windowId) delete map[windowId];
  else map[windowId] = sessionId;
  write(map);
}

/** The window closed. */
export function forgetWindow(windowId: string): void {
  const map = read();
  if (!(windowId in map)) return;
  delete map[windowId];
  write(map);
}

/** A session was killed: no window should reopen onto its name. */
export function forgetSessionPicks(sessionId: string): void {
  const map = read();
  const windows = Object.keys(map).filter((w) => map[w] === sessionId);
  if (windows.length === 0) return;
  for (const w of windows) delete map[w];
  write(map);
}
