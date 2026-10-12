/**
 * Which session a window moves to when its own session ended (`exit` in the
 * root shell — see SHELL_LOOP in tmux-control.ts).
 *
 * - The ended session itself is never a candidate (the list may still name it:
 *   it is fetched right after the session went away).
 * - A session no other window is rendering (`!inUse`) beats one that is: moving
 *   onto a busy one takes it from that window. Only when every remaining
 *   session is in use is one of those picked.
 * - Within that pool, the next one after the ended id in the session menu's
 *   order (numeric: `#a2` < `#a10`), wrapping round to the first.
 *
 * Returns null when nothing is left — the window then shows "No session".
 */
export interface SessionRow {
  id: string;
  inUse?: boolean;
}

const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

export function pickNextSession<T extends SessionRow>(rows: readonly T[], endedId: string): T | null {
  const rest = rows.filter((r) => r && typeof r.id === 'string' && r.id && r.id !== endedId);
  if (rest.length === 0) return null;
  const free = rest.filter((r) => !r.inUse);
  const pool = (free.length > 0 ? free : rest).slice().sort((a, b) => byId(a.id, b.id));
  return pool.find((r) => byId(r.id, endedId) > 0) ?? pool[0] ?? null;
}
