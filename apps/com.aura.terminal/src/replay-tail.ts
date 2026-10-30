/**
 * How much scrollback a newly granted window gets replayed.
 *
 * The session keeps up to 256 KiB (pty-server SCROLLBACK_BYTES, also what is
 * saved for restarts). Replaying all of it on every attach made a reload of a
 * desktop with many terminals slow: the browser parses every replay on its one
 * main thread (~0.2–1 s per 256 KiB under load, measured 2026-10-30). Windows
 * now get the newest REPLAY_BYTES; the shell itself keeps the full history
 * (tmux scrollback), so `tmux copy-mode` / scrolling in the pane still reaches it.
 *
 * The cut is moved forward to the next line start, so the replay never begins
 * in the middle of an escape sequence or a multi-byte character run.
 */
export const DEFAULT_REPLAY_BYTES = 64 * 1024;

/** Replay budget from TERMINAL_REPLAY_BYTES (bytes; 0 or invalid → default). */
export function replayBudget(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env['TERMINAL_REPLAY_BYTES']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_REPLAY_BYTES;
}

/** Look this far past the cut for a line start before cutting mid-line. */
const MAX_SEEK = 4096;

/** The newest `budget` characters of `text`, starting at a line start when one is near. */
export function replayTail(text: string, budget: number = DEFAULT_REPLAY_BYTES): string {
  if (text.length <= budget) return text;
  let start = text.length - budget;
  const nl = text.indexOf('\n', start);
  if (nl >= 0 && nl - start < MAX_SEEK) start = nl + 1;
  return text.slice(start);
}
