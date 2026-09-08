/**
 * Duplicate-call absorption.
 *
 * Some models emit the same tool call many times in one turn — one agent
 * asked for the overview 24 times in six seconds. Each of those would have
 * been a round trip into the user's browser, and for a tool that changes
 * something (new_workspace!) it would have been 24 changes. So an identical
 * call — same tool, same arguments — inside a short window gets the FIRST
 * call's answer back, marked so the model can see it already had it.
 * Concurrent duplicates share one in-flight execution.
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

export function _resetForTests(): void { recent.clear(); }
