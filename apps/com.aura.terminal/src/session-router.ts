/**
 * One MCP for every terminal instance.
 *
 * A session id carries the instance it lives in — `com.aura.terminal-2#a3`
 * is shell `#a3` inside container `-2` — so any instance can serve a call
 * for any session: its own directly (session-service.ts), another's by
 * forwarding to that instance's `/api/sessions/*` routes through the OS
 * proxy. The agent connects to whichever instance the Interface Registry
 * resolves and never has to know there are several.
 *
 * Ids travel in `?id=` and never in a path segment: the shell proxy rebuilds
 * the upstream URL from the DECODED path, so a `%23` would come back as `#`
 * and `fetch` would drop everything after it as a fragment.
 */
import {
  SessionError, dialogGetLocal, dialogOpLocal, inputLocal, killLocal, listLocal, localInstanceId, openLocal, screenLocal,
} from './session-service.ts';
import type {
  DialogOpBody, DialogView, InputBody, InputResult, ScreenOptions, ScreenView, SessionView,
} from './session-service.ts';

export const APP_ID  = 'com.aura.terminal';
/** The OS shell as reachable from inside the sandbox; same fallback the SDK uses. */
export const OS_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

export function parseSessionId(id: string): { instanceId: string; label: string } {
  const m = /^([^#\s]+)#([^#\s]+)$/.exec(id ?? '');
  if (!m || !m[1]!.startsWith(APP_ID)) {
    throw new SessionError(400, 'bad-session-id',
      `"${id}" is not a session id — expected <instanceId>#a<n>, e.g. ${APP_ID}-2#a3. Call list_sessions.`);
  }
  return { instanceId: m[1]!, label: m[2]! };
}

export function isLocal(instanceId: string): boolean {
  return instanceId === localInstanceId();
}

export function proxyUrl(instanceId: string, path: string): string {
  return `${OS_BASE}/api/proxy/${encodeURIComponent(instanceId)}${path}`;
}

/**
 * Call another instance's route through the OS proxy. Every failure becomes a
 * SessionError whose message names the instance, so an agent reading the
 * error knows WHICH container is the problem.
 */
export async function remoteJson<T>(instanceId: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(proxyUrl(instanceId, path), { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new SessionError(502, 'unreachable', `${instanceId}: ${(err as Error).message}`,
      'The instance did not answer — it may be restarting. Retry in ~3 s; do NOT open a new instance.', 3_000);
  }
  const text = await res.text();
  let body: { error?: string; message?: string; hint?: string } | null = null;
  try { body = JSON.parse(text) as typeof body; } catch { /* not JSON — a proxy stub or an Astro 404 page */ }
  if (res.ok) return (body ?? {}) as T;

  let message = body?.message ?? text.slice(0, 200);
  let hint = body?.hint;
  let retryAfterMs: number | undefined;
  // The proxy answers 503 while an instance boots (or its dev server reloads)
  // and 499 when the upstream connection itself failed. Keep the upstream
  // text: "the instance died" is an inference the agent must not be pushed to.
  if (res.status === 503) {
    const upstream = (body?.message ?? text).replace(/\s+/g, ' ').trim().slice(0, 160);
    message = `instance is starting or not reachable${upstream ? ` (upstream: ${upstream})` : ''}`;
    hint = 'Most likely restarting or reloading — retry in ~3 s. Do NOT open a new session or a new instance; the sessions come back with it.';
    retryAfterMs = 3_000;
  } else if (res.status === 499) {
    message = 'instance is not reachable (its container may be gone)';
    hint = 'Call list_sessions to see the instance state. Do NOT open a new instance unless the user asked.';
    retryAfterMs = 3_000;
  } else if (res.status === 404 && !body) {
    message = 'instance runs an older build without the /api/sessions/* routes; restart it';
  }
  const code = res.status === 503 ? 'instance-unavailable' : res.status === 499 ? 'instance-gone' : body?.error ?? 'proxy-error';
  throw new SessionError(res.status, code, `${instanceId}: HTTP ${res.status} ${message}`, hint, retryAfterMs);
}

async function withSession<T>(
  id: string,
  local: (id: string) => Promise<T> | T,
  remote: (instanceId: string, id: string) => Promise<T>,
): Promise<T> {
  const { instanceId } = parseSessionId(id);
  return isLocal(instanceId) ? local(id) : remote(instanceId, id);
}

const q = (id: string) => `?id=${encodeURIComponent(id)}`;

export function screenFor(id: string, opts: ScreenOptions = {}): Promise<ScreenView> {
  return withSession(id, (s) => screenLocal(s, opts), (inst, s) => {
    const p = new URLSearchParams({ id: s });
    if (opts.scrollback !== undefined) p.set('scrollback', String(opts.scrollback));
    if (opts.settleMs   !== undefined) p.set('settle_ms',  String(opts.settleMs));
    if (opts.timeoutMs  !== undefined) p.set('timeout_ms', String(opts.timeoutMs));
    // The remote call itself may legitimately take up to timeoutMs to settle.
    return remoteJson<ScreenView>(inst, `/api/sessions/screen?${p}`, { timeoutMs: (opts.timeoutMs ?? 5_000) + 5_000 });
  });
}

export function inputFor(id: string, body: InputBody): Promise<InputResult> {
  return withSession(id, (s) => inputLocal(s, body), (inst, s) =>
    remoteJson<InputResult>(inst, `/api/sessions/input${q(s)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
}

export function dialogGetFor(id: string): Promise<DialogView> {
  return withSession(id, (s) => dialogGetLocal(s), (inst, s) =>
    remoteJson<DialogView>(inst, `/api/sessions/dialog${q(s)}`));
}

export function dialogOpFor(id: string, body: DialogOpBody): Promise<DialogView> {
  return withSession(id, (s) => dialogOpLocal(s, body), (inst, s) =>
    remoteJson<DialogView>(inst, `/api/sessions/dialog${q(s)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
}

export function killFor(id: string): Promise<{ id: string; killed: boolean }> {
  return withSession(id, (s) => killLocal(s), (inst, s) =>
    remoteJson(inst, `/api/sessions${q(s)}`, { method: 'DELETE' }));
}

export interface InstanceSummary {
  instanceId: string;
  state: string;
  /** Its session list answered; when false `error` says why and `sessions` is empty (or `stale`). */
  reachable: boolean;
  error?: string;
  /** The instance did not answer in time; `sessions` is its last known list. */
  stale?: boolean;
  sessions: SessionView[];
}

export interface Listing {
  instances: InstanceSummary[];
  /** The OS API did not answer: only this instance is listed, others may exist. */
  degraded?: boolean;
  degradedReason?: string;
}

interface AppInstanceDto { instanceId: string; state: string; inPool?: boolean }

/** States in which an instance can answer for its sessions. */
const SERVING = new Set(['started', 'resuming', 'resumed', 'paused']);

/** States in which asking an instance for its sessions would wake it: the
 *  proxy resumes a paused instance on the first request (the 3.1 s list). */
const DORMANT = new Set(['paused']);

const OS_CACHE_MS = 3_000;
/** Per-instance budget; a slower instance is reported with its last known sessions (`stale`). */
const LIST_TIMEOUT_MS = 1_200;
let osCache: { at: number; value: { instances: AppInstanceDto[]; degraded?: string } } | null = null;
const lastGood = new Map<string, SessionView[]>();

/** Forget the cached instance list (after open/kill or a new instance). */
export function invalidateListing(): void { osCache = null; }

/**
 * The terminal instances the OS knows, minus the warm pool — INCLUDING ones
 * that are not serving (starting, stopping …), so nothing silently vanishes
 * from the agent's view. Cached for 3 s. Falls back to just this instance,
 * flagged `degraded`, when the OS API is not reachable (standalone runs, tests).
 */
async function osInstances(): Promise<{ instances: AppInstanceDto[]; degraded?: string }> {
  if (osCache && Date.now() - osCache.at < OS_CACHE_MS) return osCache.value;
  let value: { instances: AppInstanceDto[]; degraded?: string };
  try {
    const res = await fetch(`${OS_BASE}/api/apps/${APP_ID}/instances`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json() as AppInstanceDto[];
    value = { instances: all.filter((i) => !i.inPool) };
  } catch (err) {
    value = { instances: [{ instanceId: localInstanceId(), state: 'resumed' }], degraded: `OS API unreachable (${(err as Error).message}); only this instance is listed` };
  }
  osCache = { at: Date.now(), value };
  return value;
}

/** Sessions on every instance. One unreachable or slow container is reported
 *  as such in its own row (with its last known sessions, `stale: true`) — it
 *  never hides or delays the others for long. A paused instance is not asked
 *  (that would resume it) unless `includePaused`; its row carries the last
 *  known sessions, if any, as `stale`. */
export async function listAll(opts: { includePaused?: boolean } = {}): Promise<Listing> {
  const { instances, degraded } = await osInstances();
  const rows = await Promise.all(instances.map(async ({ instanceId, state }): Promise<InstanceSummary> => {
    if (!SERVING.has(state)) {
      return { instanceId, state, reachable: false, error: `instance is ${state} — not serving right now`, sessions: [] };
    }
    if (DORMANT.has(state) && !opts.includePaused && !isLocal(instanceId)) {
      const prev = lastGood.get(instanceId);
      return {
        instanceId, state, reachable: false, error: `instance is ${state} — not queried; pass include_paused:true to list it (wakes it)`,
        ...(prev ? { stale: true } : {}), sessions: prev ?? [],
      };
    }
    try {
      const { sessions } = isLocal(instanceId)
        ? await listLocal()
        : await remoteJson<{ sessions: SessionView[] }>(instanceId, '/api/sessions', { timeoutMs: LIST_TIMEOUT_MS });
      lastGood.set(instanceId, sessions);
      return { instanceId, state, reachable: true, sessions };
    } catch (err) {
      const prev = lastGood.get(instanceId);
      return { instanceId, state, reachable: false, error: (err as Error).message, ...(prev ? { stale: true } : {}), sessions: prev ?? [] };
    }
  }));
  return { instances: rows, ...(degraded ? { degraded: true, degradedReason: degraded } : {}) };
}

/** Back-compat: the rows of `listAll()`. */
export async function listInstances(): Promise<InstanceSummary[]> {
  return (await listAll()).instances;
}

/**
 * Start another terminal container and wait until its routes answer. The
 * proxy replies 503 while an instance boots; the warm pool usually makes this
 * instant. `maxInstances` surfaces as the OS's own error text.
 */
export async function startInstance(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${OS_BASE}/api/apps/${APP_ID}/start`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new SessionError(502, 'unreachable', `OS API: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => ({})) as { instanceId?: string; error?: string };
  if (!res.ok || !body.instanceId) {
    throw new SessionError(res.status === 200 ? 500 : res.status, 'start-failed', body.error ?? `HTTP ${res.status}`);
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { await remoteJson(body.instanceId, '/api/sessions', { timeoutMs: 3_000 }); return body.instanceId; }
    catch (err) {
      if (Date.now() > deadline) throw new SessionError(504, 'start-timeout', `${body.instanceId} started but its API did not answer in 20s: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Open a session on `instance` — this one by default, `"new"` for a fresh container. */
export async function openOn(instance: string | undefined, opts: { cols?: number; rows?: number }): Promise<{ instanceId: string; session: SessionView }> {
  let instanceId = instance ?? localInstanceId();
  if (instance === 'new') { instanceId = await startInstance(); invalidateListing(); }
  else if (!instanceId.startsWith(APP_ID)) {
    throw new SessionError(400, 'bad-instance', `"${instance}" is not a terminal instance id (expected ${APP_ID}-<n>, or "new")`);
  }
  const session = isLocal(instanceId)
    ? await openLocal(opts)
    : (await remoteJson<{ session: SessionView }>(instanceId, '/api/sessions/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts),
      })).session;
  return { instanceId, session };
}
