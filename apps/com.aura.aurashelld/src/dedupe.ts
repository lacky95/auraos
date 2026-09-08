/**
 * Call guard: duplicate absorption, and a brake on read-loops.
 *
 * Some models emit the same tool call many times in one turn — one agent
 * asked for the overview 24 times in six seconds. Each of those would have
 * been a round trip into the user's browser, and for a tool that changes
 * something (new_workspace!) it would have been 24 changes. So an identical
 * call — same tool, same arguments — inside a short window gets the FIRST
 * call's answer back, marked so the model can see it already had it.
 * Concurrent duplicates share one in-flight execution.
 *
 * The second half is for a different failure: an agent that alternates
 * between read-only tools and never answers — one client asked for the time
 * and the overview in turn, twenty times, each round trip a couple of
 * milliseconds. Absorption alone cannot stop that (the answers ARE what it
 * asked for), so after a few reads of the same tool with nothing changed in
 * between, the tool stops returning data and returns a short instruction to
 * stop and answer instead. A mutating call clears the counters — once the
 * desktop has changed, re-reading is exactly right.
 *
 * Module scope, like the challenge table: MCP servers here are per-request.
 */
export const DEDUPE_WINDOW_MS = 3_000;

interface Entry { at: number; result: Promise<unknown> }
const recent = new Map<string, Entry>();

/** A stable key: argument order must not defeat the match. */
export function callKey(tool: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args).sort().map((k) => [k, args[k]]);
  return `${tool}:${JSON.stringify(sorted)}`;
}

/**
 * Run `exec` unless the same call ran within the window; then hand back that
 * run's promise. `duplicate` tells the caller which case it was.
 */
export function dedupe<T>(tool: string, args: Record<string, unknown>, exec: () => Promise<T>, now = Date.now())
  : { duplicate: boolean; result: Promise<T> } {
  for (const [k, e] of recent) if (now - e.at > DEDUPE_WINDOW_MS) recent.delete(k);
  const key = callKey(tool, args);
  const hit = recent.get(key);
  if (hit) return { duplicate: true, result: hit.result as Promise<T> };
  const result = exec();
  recent.set(key, { at: now, result });
  // A failure must not be replayed: the next identical call should try again.
  result.catch(() => recent.delete(key));
  return { duplicate: false, result };
}

export function _resetForTests(): void { recent.clear(); reads.clear(); }

// ── Read-loop brake ─────────────────────────────────────────────────────────

/** How far back repeated reads count. */
export const LOOP_WINDOW_MS = 30_000;
/** Reads of one tool allowed in the window before the brake engages. */
export const LOOP_LIMIT = 3;

interface ReadState { times: number[]; lastAnswer?: string }
const reads = new Map<string, ReadState>();

/**
 * Note a read-only call. `tripped` means this one is over the limit: answer
 * with `stopMessage` rather than more data.
 */
export function recordRead(tool: string, now = Date.now()): { count: number; tripped: boolean } {
  const st = reads.get(tool) ?? { times: [] };
  st.times = st.times.filter((t) => now - t < LOOP_WINDOW_MS);
  st.times.push(now);
  reads.set(tool, st);
  return { count: st.times.length, tripped: st.times.length > LOOP_LIMIT };
}

/** Keep the headline of a tool's answer, so the brake can repeat it back. */
export function rememberAnswer(tool: string, firstLine: string): void {
  const st = reads.get(tool);
  if (st) st.lastAnswer = firstLine.slice(0, 400);
}

/** The desktop changed: reading again is legitimate, so forget the counts. */
export function noteMutation(): void {
  reads.clear();
}

/** What the brake says. Short on purpose — a wall of data is what it is replacing. */
export function stopMessage(tool: string, count: number, seconds: number): string {
  const st = reads.get(tool);
  return (
    `You have called ${tool} ${count} times in the last ${seconds} seconds and nothing has changed in between.`
    + (st?.lastAnswer ? `\nThe answer is still: ${st.lastAnswer}` : '')
    + '\nStop calling tools and answer the user with what you already have.'
  );
}
