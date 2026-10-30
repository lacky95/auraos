import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { TMUX_SOCKET, tmuxBin, tmuxName } from './tmux-control.ts';

/**
 * The working directory of every session, so a shell that has to be
 * recreated starts where the old one was.
 *
 * tmux keeps shells across a pty-server restart and an OS restart (the
 * container is re-adopted), but not across the end of this container. Then
 * the session comes back under its old name with its scrollback replayed —
 * and, with this, in its old directory (`new-session -c`). Recorded every
 * few seconds from `#{pane_current_path}`; `/data` is per-instance and
 * persistent.
 */
const FILE = join(process.env['AURA_DATA_DIR'] ?? '/data', 'session-cwd.json');
const RECORD_MS = 10_000;

function read(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}
function write(map: Record<string, string>): void {
  try {
    mkdirSync(join(FILE, '..'), { recursive: true });
    writeFileSync(FILE, JSON.stringify(map), 'utf-8');
  } catch { /* read-only /data: nothing to keep */ }
}

/** The directory `sessionId` was last in, when it still exists. */
export function savedCwd(sessionId: string): string | null {
  const dir = read()[sessionId];
  if (!dir) return null;
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/** Something is known about this session beyond a live shell. */
export function hasSavedCwd(sessionId: string): boolean {
  return !!read()[sessionId];
}

export function forgetCwd(sessionId: string): void {
  const map = read();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  write(map);
}

function currentCwd(sessionId: string): string | null {
  if (!tmuxBin) return null;
  try {
    const r = spawnSync(tmuxBin, ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', tmuxName(sessionId), '#{pane_current_path}'],
      { encoding: 'utf-8', timeout: 2_000 });
    const dir = r.status === 0 ? r.stdout.trim() : '';
    return dir && existsSync(dir) ? dir : null;
  } catch { return null; }
}

/** Record the cwd of these sessions now (changed ones only). */
export function recordCwds(sessionIds: Iterable<string>): void {
  const map = read();
  let changed = false;
  for (const id of sessionIds) {
    const dir = currentCwd(id);
    if (dir && map[id] !== dir) { map[id] = dir; changed = true; }
  }
  if (changed) write(map);
}

/** Record every RECORD_MS; one timer per process (module reloads replace it). */
export function startCwdRecorder(liveIds: () => Iterable<string>): void {
  const KEY = '__auraTermCwdRecorder';
  const g = globalThis as Record<string, unknown>;
  clearInterval(g[KEY] as NodeJS.Timeout | undefined);
  const t = setInterval(() => { try { recordCwds(liveIds()); } catch { /* next tick */ } }, RECORD_MS);
  if (typeof t.unref === 'function') t.unref();
  g[KEY] = t;
}
