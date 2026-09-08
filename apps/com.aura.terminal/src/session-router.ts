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
  SessionError, inputLocal, killLocal, listLocal, localInstanceId, openLocal, screenLocal,
} from './session-service.ts';
import type { InputBody, InputResult, ScreenOptions, ScreenView, SessionView } from './session-service.ts';

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
    throw new SessionError(502, 'unreachable', `${instanceId}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: { error?: string; message?: string } | null = null;
  try { body = JSON.parse(text) as typeof body; } catch { /* not JSON — a proxy stub or an Astro 404 page */ }
  if (res.ok) return (body ?? {}) as T;

  let message = body?.message ?? text.slice(0, 200);
  // The proxy answers 503 while an instance boots and 499 when the upstream
  // connection itself failed (the container is gone or not listening).
  if (res.status === 503) message = 'instance is starting or not reachable';
  else if (res.status === 499) message = 'instance is not reachable (its container may be gone)';
  else if (res.status === 404 && !body) message = 'instance runs an older build without the /api/sessions/* routes; restart it';
  throw new SessionError(res.status, body?.error ?? 'proxy-error', `${instanceId}: HTTP ${res.status} ${message}`);
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

export function killFor(id: string): Promise<{ id: string; killed: boolean }> {
  return withSession(id, (s) => killLocal(s), (inst, s) =>
    remoteJson(inst, `/api/sessions${q(s)}`, { method: 'DELETE' }));
}

export interface InstanceSummary {
  instanceId: string;
  state: string;
  /** Its session list answered; when false `error` says why and `sessions` is empty. */
  reachable: boolean;
  error?: string;
  sessions: SessionView[];
}

interface AppInstanceDto { instanceId: string; state: string; inPool?: boolean }

/** States in which an instance can answer for its sessions. */
const SERVING = new Set(['started', 'resuming', 'resumed', 'paused']);

/** The terminal instances the OS knows, minus the warm pool. Falls back to
 *  just this instance when the OS API is not reachable (standalone runs, tests). */
async function osInstances(): Promise<AppInstanceDto[]> {
  try {
    const res = await fetch(`${OS_BASE}/api/apps/${APP_ID}/instances`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json() as AppInstanceDto[];
    return all.filter((i) => !i.inPool && SERVING.has(i.state));
  } catch {
    return [{ instanceId: localInstanceId(), state: 'resumed' }];
  }
}

/** Sessions on every instance. One unreachable container is reported as such
 *  in its own row — it never hides the others. */
export async function listInstances(): Promise<InstanceSummary[]> {
  const instances = await osInstances();
  return Promise.all(instances.map(async ({ instanceId, state }): Promise<InstanceSummary> => {
    try {
      const { sessions } = isLocal(instanceId)
        ? await listLocal()
        : await remoteJson<{ sessions: SessionView[] }>(instanceId, '/api/sessions');
      return { instanceId, state, reachable: true, sessions };
    } catch (err) {
      return { instanceId, state, reachable: false, error: (err as Error).message, sessions: [] };
    }
  }));
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
  if (instance === 'new') instanceId = await startInstance();
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
