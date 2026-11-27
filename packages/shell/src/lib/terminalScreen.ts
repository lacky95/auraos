/**
 * `GET /api/terminal/sessions/screen?id=<session>`: what a Terminal session's
 * screen shows, for an app holding `terminal.sessions.list` AND
 * `terminal.screen.read` (5.16: programmatic screen access is its own grant).
 *
 * Only derived facts leave the Terminal, never the rows: whether the program
 * in the session says it is working (`busy`) and which agent CLI it is
 * (`agent`, a label or null). TerminalX's fallback for an agent without hooks
 * needs just that. The Terminal app derives both from its own program
 * profiles (it owns the PTY, D96); this route checks the caller and forwards
 * the two facts, so no product string lives in the shell.
 *
 *   200 { id, busy, agent }   (plus `[agent]: true`, the per-agent flag the
 *                              first consumer read before `agent`; one release)
 *   400 bad-session-id   401 caller-invalid   403 not-granted
 *   404 instance-not-running | unknown-session (not in its instance's list)
 *   429 rate-limited     502 instance-unreachable
 *
 * The session must be in its Terminal instance's own list, so a name that was
 * never created (or has ended) reads nothing. Nothing is audited per call: it
 * is polled. Each caller (each app, the owner, the operator, each API key:
 * L1) gets `SCREEN_READS_PER_MINUTE` instead. A caller without an app
 * identity (the owner's desktop, the CLI) is left to the manifest rule, as on
 * `/api/terminal/sessions`; the System Terminal is not limited by grants.
 */

/** Per caller (TerminalX polls each agent session every 5 s). */
export const SCREEN_READS_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

/** What the Terminal app derives from a session's screen. */
export interface ScreenFacts { busy: boolean; agent: string | null }
export interface ScreenState extends ScreenFacts { id: string; [legacyAgentFlag: string]: unknown }

export interface ScreenStateDeps {
  /** The proved app making the call; null without an app identity; 'invalid' for a claim that does not verify. */
  /** The caller (lib/terminalCaller.ts): the app it is held to, and its own rate-limit key (L1). */
  caller(request: Request): Promise<{ app: { appId: string } | null; key: string } | 'invalid'>;
  isSystemTerminal(appId: string): Promise<boolean>;
  /** Both grants: `terminal.sessions.list` and `terminal.screen.read`. */
  mayReadScreens(appId: string): Promise<boolean>;
  /** The Terminal instance a session id names, or null. */
  sessionInstance(sessionId: string | null): string | null;
  /** The session ids its instance lists now, or null when that instance is not running. */
  listed(instanceId: string): Promise<string[] | null>;
  /** The session's screen facts, as the Terminal instance derives them. */
  facts(instanceId: string, sessionId: string): Promise<ScreenFacts>;
  /** D69: whether the caller acts for the instance's user (terminalCaller `callerOwnsTerminal`); another's is not running. */
  owns?(request: Request, instanceId: string): Promise<boolean>;
  now?: () => number;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const FIELDS = new Set(['id', 'busy', 'agent']);
/** An agent label: a program name, nothing a response field could be confused with. */
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The response for one session: only the two facts, whatever the Terminal sent. */
export function screenState(id: string, facts: ScreenFacts): ScreenState {
  const agent = typeof facts.agent === 'string' && AGENT_RE.test(facts.agent) ? facts.agent : null;
  const out: ScreenState = { id, busy: facts.busy === true, agent };
  if (agent && !FIELDS.has(agent)) out[agent] = true;
  return out;
}

export function createScreenStateRoute(deps: ScreenStateDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  /** False once `key` used up its reads in this window. */
  function take(key: string): boolean {
    const t = now();
    for (const [k, w] of windows) if (t - w.start >= WINDOW_MS) windows.delete(k);
    const w = windows.get(key) ?? { start: t, count: 0 };
    windows.set(key, w);
    if (w.count >= SCREEN_READS_PER_MINUTE) return false;
    w.count++;
    return true;
  }

  return async (request) => {
    const who = await deps.caller(request);
    if (who === 'invalid') return json({ error: 'caller-invalid' }, 401);
    let caller = who.app;
    if (caller && await deps.isSystemTerminal(caller.appId)) caller = null;
    if (caller && !(await deps.mayReadScreens(caller.appId))) {
      return json({ error: 'not-granted', message: `${caller.appId} was not granted terminal.sessions.list and terminal.screen.read` }, 403);
    }
    const id = new URL(request.url).searchParams.get('id');
    const instanceId = deps.sessionInstance(id);
    if (!id || !instanceId) return json({ error: 'bad-session-id' }, 400);
    if (!take(who.key)) {
      return json({ error: 'rate-limited', message: `at most ${SCREEN_READS_PER_MINUTE} screen reads a minute` }, 429, { 'retry-after': '60' });
    }
    if (deps.owns && !(await deps.owns(request, instanceId))) {
      return json({ error: 'instance-not-running', message: `${instanceId} is not a running Terminal instance` }, 404);
    }
    try {
      const ids = await deps.listed(instanceId);
      if (!ids) return json({ error: 'instance-not-running', message: `${instanceId} is not a running Terminal instance` }, 404);
      if (!ids.includes(id)) return json({ error: 'unknown-session', message: `${id} is not a session of ${instanceId}` }, 404);
      return json(screenState(id, await deps.facts(instanceId, id)));
    } catch (err) {
      return json({ error: 'instance-unreachable', message: `${instanceId}: ${(err as Error).message}` }, 502);
    }
  };
}
