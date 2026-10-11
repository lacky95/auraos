import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reserveSessionName } from './pty-server.ts';
import { inputLocal } from './session-service.ts';
import { captureScreen, liveTmuxSessionsAsync, newSession, requireTmux, tmuxName } from './tmux-control.ts';
import { screenSettled } from './launch-intent.ts';

/**
 * The one-shot `command` of an OPEN_TERMINAL intent (see launch-intent.ts).
 *
 * A windowed launch can't type the command when the intent arrives: the
 * window doesn't exist yet, and "fully loaded" is something only the page
 * knows. So the command waits here, keyed by the window (activity id), until
 * the page reports its terminal is live (`POST /api/sessions/launch`). Then
 * it is TAKEN — removed before it is typed — so a reconnect, a reload or a
 * second browser rendering the same window can never run it twice. The
 * typing itself happens server-side into tmux, not over the page's socket,
 * so a socket that drops at that moment can't lose it either.
 *
 * Kept on /data (per-instance) like window-session.ts, so a dev-server
 * reload between the intent and the window's first paint doesn't drop it.
 */
const FILE = join(process.env['AURA_DATA_DIR'] ?? '/data', 'launch-commands.json');

/** A window nobody ever opened must not fire a command hours later. */
export const PENDING_TTL_MS = 30 * 60_000;

interface Pending { sessionId: string; command: string; at: number }

function read(): Record<string, Pending> {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, Pending> : {};
  } catch { return {}; }
}

function write(map: Record<string, Pending>): void {
  mkdirSync(join(FILE, '..'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(map), 'utf-8');
}

function fresh(p: Pending | undefined, now = Date.now()): p is Pending {
  return !!p && typeof p.command === 'string' && typeof p.sessionId === 'string' && now - p.at < PENDING_TTL_MS;
}

export function queueLaunchCommand(windowId: string, sessionId: string, command: string): void {
  const map = read();
  for (const [k, v] of Object.entries(map)) if (!fresh(v)) delete map[k];
  map[windowId] = { sessionId, command, at: Date.now() };
  write(map);
}

/** Server-rendered into the page so only windows with a command ask for it. */
export function hasLaunchCommand(windowId: string | null): boolean {
  return !!windowId && fresh(read()[windowId]);
}

/** Remove and return the window's command. Synchronous ⇒ atomic in this process. */
export function takeLaunchCommand(windowId: string): Pending | null {
  const map = read();
  const p = map[windowId];
  if (!p) return null;
  delete map[windowId];
  write(map);
  return fresh(p) ? p : null;
}

/** The window closed before its terminal ever came up. */
export function dropLaunchCommand(windowId: string): void {
  const map = read();
  if (!(windowId in map)) return;
  delete map[windowId];
  write(map);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait until the session's shell has drawn its prompt and gone quiet, so the
 * command lands at the prompt instead of racing the rc files. Gives up after
 * `timeoutMs` and lets the caller type anyway — a busy screen (a TUI on an
 * existing session) never settles, and the tty buffers the input regardless.
 */
export async function waitForShellReady(sessionId: string, { quietMs = 250, timeoutMs = 4_000 } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let prev: string[] | null = null;
  while (Date.now() < deadline) {
    let next: string[];
    try { next = await captureScreen(sessionId); } catch { next = []; }
    if (screenSettled(prev, next)) return true;
    prev = next;
    await sleep(quietMs);
  }
  return false;
}

/** Type `command` + Enter into the session once its shell is ready. */
export async function runLaunchCommand(sessionId: string, command: string): Promise<{ settled: boolean }> {
  const settled = await waitForShellReady(sessionId);
  await inputLocal(sessionId, { text: command, keys: ['Enter'] });
  return { settled };
}

export async function sessionIsLive(sessionId: string): Promise<boolean> {
  return (await liveTmuxSessionsAsync()).has(tmuxName(sessionId));
}

/**
 * A shell with no window (a background launch), under a name the caller
 * chose. Same steps as the MCP's open_session (session-service openLocal):
 * reserve the name so pickers list it, then start it in tmux.
 */
export async function openHeadlessSession(sessionId: string, cols = 120, rows = 32): Promise<void> {
  requireTmux();
  reserveSessionName(sessionId);
  if (await sessionIsLive(sessionId)) return;
  await newSession(sessionId, cols, rows);
}
