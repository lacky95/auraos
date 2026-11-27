/**
 * Who may use the owner's System Terminal from another app (D25, D29, 5.16).
 * One place for the decision, read by the App Host router (frame-ancestors),
 * the intents route (OPEN_TERMINAL) and the Terminal routes under /api/terminal.
 *
 *   terminal.embed          privileged, owner-granted per app (GrantStore). The
 *                           app may create sessions (OPEN_TERMINAL `background`)
 *                           and show and close the ones it created. Each such
 *                           session also gets a grant of its own, scoped to it,
 *                           which counts only while the app's grant does, and
 *                           only in the life of the Terminal instance it was
 *                           made in (`binding`): session names are reused.
 *   terminal.sessions.list  privileged, separate: read every session's metadata.
 *   terminal.screen.read    privileged, separate (5.16 programmatic access): with
 *                           the list grant, what a listed session's screen shows,
 *                           as derived facts only (lib/terminalScreen.ts).
 *
 * The System Terminal itself (system scope) keeps full control. A caller that
 * is not a verified app (the owner's desktop, the CLI, an agent, anyone who
 * can POST) needs the owner proved for the OPEN_TERMINAL extras that reach a
 * session: `command` types as the owner, `sessionId` opens a window on an
 * existing session, `background` creates one an app never asked for. A plain
 * OPEN_TERMINAL stays open to it. The private Terminal ingress is Phase 5.
 *
 * Plain ESM: the router loads it beside the Astro build. @aura/core is
 * imported lazily, and its services are globalThis singletons, so both copies
 * of this file see the same grants and apps.
 */
import { RELAY_CLAIM_HEADER } from '@aura/core/relay-claim';
import { SESSION_HOST_APPS, TERMINAL_APP_ID, isInstanceIdOf } from './session-hosts.mjs';

// The ids live in a dependency-free leaf (session-hosts.mjs); re-exported for this module's importers.
export { TERMINAL_APP_ID, SESSION_HOST_APPS };
export const OPEN_TERMINAL_ACTION = 'aura.intent.action.OPEN_TERMINAL';
/** Query parameter naming the App Host label that frames an `embed=1` page. */
export const EMBEDDER_PARAM = '_aura_embedder';

const SESSION_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,199})#([A-Za-z0-9._-]{1,64})$/;

/** The Terminal instance a session id names (`com.aura.terminal-2#a3` → `com.aura.terminal-2`), or null. */
export function terminalSessionInstance(sessionId) {
  const m = typeof sessionId === 'string' ? SESSION_RE.exec(sessionId) : null;
  if (!m || !isInstanceIdOf(m[1], TERMINAL_APP_ID)) return null;
  return m[1];
}

/**
 * The decisions over a grant store. `deps` (tests pass fakes):
 *   systemCopy(appId)              whether the copy the app id resolves to is the trusted
 *                                  system app: its active `system` copy (core AppManager
 *                                  `isTrustedSystemCopy`)
 *   authorize(appId, permission)   core's Authorizer for an instance of the app
 *   sessionGrant(appId, sessionId) the session's own `terminal.embed` record, or null
 *   sessionLife(sessionId)         the current life of the session's Terminal
 *                                  instance (`InstanceTokens.lifetimeId`), or null
 */
export function createTerminalAccess(deps) {
  /**
   * The System Terminal: its own id, in the `system` scope. A same-id copy
   * from anywhere else is an ordinary app.
   */
  async function isSystemTerminal(appId) {
    if (appId !== TERMINAL_APP_ID) return false;
    try { return (await deps.systemCopy(appId)) === true; } catch { return false; }
  }

  /** Whether the owner granted `appId` Terminal embedding at all (requested in its manifest and granted). */
  async function holdsEmbedGrant(appId) {
    try { return await deps.authorize(appId, 'terminal.embed'); } catch { return false; }
  }

  /** Whether `appId` may read every session's metadata. */
  async function holdsListGrant(appId) {
    try { return await deps.authorize(appId, 'terminal.sessions.list'); } catch { return false; }
  }

  /** Whether `appId` may read the screen state of the sessions it may list (both grants). */
  async function mayReadScreens(appId) {
    if (!(await holdsListGrant(appId))) return false;
    try { return await deps.authorize(appId, 'terminal.screen.read'); } catch { return false; }
  }

  /**
   * Whether `appId` may show and close this one session: its app grant, plus
   * the session's own, made in the instance life that runs now.
   */
  async function mayUseSession(appId, sessionId) {
    if (!terminalSessionInstance(sessionId)) return false;
    try {
      if (!(await holdsEmbedGrant(appId))) return false;
      const grant = await deps.sessionGrant(appId, sessionId);
      const life = await deps.sessionLife(sessionId);
      return !!grant && typeof grant.binding === 'string' && !!life && grant.binding === life;
    } catch {
      return false;
    }
  }

  return { isSystemTerminal, holdsEmbedGrant, holdsListGrant, mayReadScreens, mayUseSession };
}

const core = () => import('@aura/core');

/** The life of a Terminal instance (`InstanceTokens.lifetimeId`), or null. */
async function instanceLife(instanceId) {
  if (!instanceId) return null;
  return (await core()).getAppManager().tokens.lifetimeId?.(instanceId) ?? null;
}

/**
 * Where to reach a running Terminal instance's own API, or null. One answer
 * for the shell's session routes and the grant sweep.
 */
export function terminalUpstream(mgr, instanceId) {
  if (!instanceId) return null;
  const inst = mgr.getInstance(instanceId);
  if (!inst || inst.appId !== TERMINAL_APP_ID || inst.port == null) return null;
  if (inst.state === 'error' || inst.state === 'destroyed' || inst.state === 'destroying') return null;
  const up = mgr.getUpstreamUrl?.(instanceId);
  return { inst, base: `http://${up?.host ?? 'localhost'}:${up?.port ?? inst.port}` };
}

/**
 * D89 B4: the shell's relay claim on its own call to a Terminal instance
 * (AppManager.relayClaim, as `system`), or no header when there is none.
 *
 * @param {any} mgr
 * @param {string} instanceId
 * @param {string} method
 * @param {string} path
 * @returns {Record<string, string>}
 */
export function shellRelayHeader(mgr, instanceId, method, path) {
  let claim = null;
  try { claim = mgr.relayClaim?.(instanceId, { method, path, caller: 'system' }) ?? null; } catch { claim = null; }
  return claim ? { [RELAY_CLAIM_HEADER]: claim } : {};
}

/**
 * A request to a running Terminal instance's own API, sent as the OS (the
 * instance's identity headers), or null when it is not running. Throws when
 * the instance does not answer in `timeoutMs`; with `timeoutMs` null (a
 * stream) it ends only on `init.signal`.
 *
 * @param {any} mgr
 * @param {string} instanceId
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {number | null} [timeoutMs]
 */
export async function fetchTerminal(mgr, instanceId, path, init = {}, timeoutMs = 10_000) {
  const up = terminalUpstream(mgr, instanceId);
  if (!up) return null;
  return fetch(`${up.base}${path}`, {
    ...init,
    headers: { 'x-aura-app-id': up.inst.appId, 'x-aura-instance-id': up.inst.instanceId, ...shellRelayHeader(mgr, instanceId, init.method ?? 'GET', path) },
    signal: timeoutMs === null ? init.signal : AbortSignal.timeout(timeoutMs),
  });
}

const live = createTerminalAccess({
  systemCopy: async (appId) => (await core()).getAppManager().isTrustedSystemCopy(appId),
  authorize: async (appId, permission) => {
    const principal = { kind: 'instance', appId, instanceId: `${appId}-grant-check`, verification: 'verified' };
    return (await (await core()).getAuthServices().authorizer.authorize(principal, permission)).allow;
  },
  sessionGrant: async (appId, sessionId) => {
    const c = await core();
    return c.getAuthServices().grants.get({ kind: 'app', id: appId }, 'terminal.embed', c.terminalSessionScope(sessionId));
  },
  sessionLife: (sessionId) => instanceLife(terminalSessionInstance(sessionId)),
});
export const { isSystemTerminal, holdsEmbedGrant, holdsListGrant, mayReadScreens, mayUseSession } = live;

/**
 * Record that `appId` created (or was shown) `sessionId`, so it may show and
 * close it, in this life of its Terminal instance only.
 */
export async function grantSession(appId, sessionId) {
  const c = await core();
  const binding = await instanceLife(terminalSessionInstance(sessionId));
  if (!binding) throw new Error(`${terminalSessionInstance(sessionId) ?? sessionId} has no instance identity`);
  const appScope = c.getAppManager().registry.getScopeId(appId);
  await c.getAuthServices().grants.grant({ kind: 'app', id: appId }, 'terminal.embed', {
    by: { kind: 'system' }, ...(appScope ? { appScope } : {}), scope: c.terminalSessionScope(sessionId), binding,
  });
}

/**
 * A session ended or was deleted: every app's grant of it goes, so a new
 * session under the reused name starts with none. The Terminal reports each
 * end (/api/terminal/sessions/ended); a whole instance ends here too.
 */
export async function forgetSessionGrants(sessionId) {
  const c = await core();
  return c.getAuthServices().grants.revokeScopes('terminal.embed', (sc) => sc.kind === 'terminal-session' && sc.id === sessionId);
}

/** Every session grant of one Terminal instance (it was destroyed). */
export async function forgetInstanceGrants(instanceId) {
  const c = await core();
  const prefix = `${instanceId}#`;
  return c.getAuthServices().grants.revokeScopes('terminal.embed', (sc) => sc.kind === 'terminal-session' && sc.id.startsWith(prefix));
}

/**
 * Drop the session grants whose session is gone (5.16), for every Terminal
 * instance or only `onlyInstance`. The end reports and the instance watch need
 * the shell to be up when a session or instance ends; this catches what they
 * missed. A grant goes when its instance is unknown, runs another life than
 * the grant's `binding`, or answers that the session is not live. An instance
 * that can't answer keeps its grants until the next sweep. `deps` (tests pass
 * fakes):
 *   listGrants()             every grant record
 *   instance(instanceId)     {running, life} of a known Terminal instance, or null
 *   liveSessions(instanceId) the ids its own API lists as live (throws when unreachable)
 *   revokeSessions(ids)      drop every grant of these session ids
 * Returns the session ids it dropped.
 *
 * @param {string | null} [onlyInstance]
 * @param {{
 *   listGrants: () => Promise<any[]>,
 *   instance: (instanceId: string) => Promise<{ running: boolean, life: string | null } | null>,
 *   liveSessions: (instanceId: string) => Promise<Set<string>>,
 *   revokeSessions: (ids: Set<string>) => Promise<unknown>,
 * }} [deps]
 * @returns {Promise<string[]>}
 */
export async function sweepSessionGrants(onlyInstance = null, deps = liveSweep) {
  const stale = new Set();
  const lists = new Map();
  for (const rec of await deps.listGrants()) {
    if (rec?.permission !== 'terminal.embed' || rec.scope?.kind !== 'terminal-session') continue;
    const sessionId = rec.scope.id;
    const instanceId = terminalSessionInstance(sessionId);
    if (onlyInstance && instanceId !== onlyInstance) continue;
    const info = instanceId ? await deps.instance(instanceId) : null;
    if (!info || !info.life || rec.binding !== info.life) { stale.add(sessionId); continue; }
    if (!info.running) continue;
    if (!lists.has(instanceId)) lists.set(instanceId, deps.liveSessions(instanceId).catch(() => null));
    const live = await lists.get(instanceId);
    if (live && !live.has(sessionId)) stale.add(sessionId);
  }
  if (stale.size) await deps.revokeSessions(stale);
  return [...stale];
}

const SWEEP_TIMEOUT_MS = 10_000;

const liveSweep = {
  listGrants: async () => (await core()).getAuthServices().grants.listAll(),
  instance: async (instanceId) => {
    const mgr = (await core()).getAppManager();
    const inst = mgr.getInstance(instanceId);
    if (!inst || inst.appId !== TERMINAL_APP_ID || inst.state === 'destroyed') return null;
    return {
      running: !!terminalUpstream(mgr, instanceId) && (inst.state === 'started' || inst.state === 'resumed'),
      life: mgr.tokens.lifetimeId?.(instanceId) ?? null,
    };
  },
  liveSessions: async (instanceId) => {
    const c = await core();
    const up = terminalUpstream(c.getAppManager(), instanceId);
    if (!up) throw new Error('not running');
    const res = await fetch(`${up.base}/api/sessions`, {
      headers: { 'x-aura-app-id': up.inst.appId, 'x-aura-instance-id': up.inst.instanceId, ...shellRelayHeader(c.getAppManager(), instanceId, 'GET', '/api/sessions') },
      signal: AbortSignal.timeout(SWEEP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return new Set((Array.isArray(body?.sessions) ? body.sessions : []).filter((s) => s?.live === true).map((s) => s.id));
  },
  revokeSessions: async (ids) => (await core()).getAuthServices().grants.revokeScopes(
    'terminal.embed', (sc) => sc.kind === 'terminal-session' && ids.has(sc.id),
  ),
};

/** The sweep against the live system. Logs, never throws. */
export async function sweepLiveSessionGrants(onlyInstance = null) {
  try {
    const dropped = await sweepSessionGrants(onlyInstance);
    if (dropped.length) console.log(`[terminal] dropped ${dropped.length} grant(s) of ended Terminal sessions`);
  } catch (err) {
    console.warn(`[terminal] session grant sweep failed: ${err?.message ?? err}`);
  }
}

const WATCH = Symbol.for('aura.terminalEmbed.watch');

/**
 * Once per process: a destroyed Terminal instance takes its sessions' grants
 * along, and a Terminal that starts or resumes has its grants swept.
 */
export async function watchTerminalInstances() {
  if (globalThis[WATCH]) return;
  globalThis[WATCH] = true;
  const c = await core();
  c.OsEventBus.on('app:stateChanged', (ev) => {
    if (ev?.appId !== TERMINAL_APP_ID) return;
    if (ev.state === 'destroyed') {
      forgetInstanceGrants(ev.instanceId).catch(() => { /* KV down: the next sweep drops them */ });
    } else if (ev.state === 'started' || ev.state === 'resumed') {
      void sweepLiveSessionGrants(ev.instanceId);
    }
  });
}

/**
 * The owner chose to show an existing session in an app (D25), on a trusted
 * surface: the Shell's own dialog. Only for an app that holds `terminal.embed`.
 */
export async function shareSession(appId, sessionId, { access = live, grant = grantSession } = {}) {
  if (!terminalSessionInstance(sessionId)) return 'bad-session-id';
  if (await access.isSystemTerminal(appId)) return 'not-an-embedder';
  if (!(await access.holdsEmbedGrant(appId))) return 'not-granted';
  try { await grant(appId, sessionId); } catch { return 'unavailable'; }
  return null;
}

/** Whether this intent carries OPEN_TERMINAL's `command`, which types as the owner. */
export function openTerminalCommand(intent) {
  return intent?.action === OPEN_TERMINAL_ACTION && !!intent.extras && typeof intent.extras === 'object'
    && Object.hasOwn(intent.extras, 'command');
}

/**
 * Whether this OPEN_TERMINAL reaches a session: `command`, `sessionId`, or
 * `background: true`. Such an intent needs a proved caller: the System
 * Terminal, a granted app, or the owner.
 */
export function openTerminalNeedsProof(intent) {
  if (intent?.action !== OPEN_TERMINAL_ACTION || !intent.extras || typeof intent.extras !== 'object') return false;
  const extras = intent.extras;
  return Object.hasOwn(extras, 'command') || Object.hasOwn(extras, 'sessionId') || extras.background === true;
}

/**
 * Why this caller may not send this intent, or null. `caller` is a verified
 * app ({appId}), the proved owner ({owner: true}: the desktop's own page or the
 * host operator), or null (nothing proved).
 *   `command` types a line as the owner (5.16 safeguard 2): the System
 *             Terminal's own or the owner's, never an embedder's, and never
 *             an unproved caller's (any site can POST a no-cors text/plain body).
 *   `sessionId` opens a window on an existing session: a session the app was granted.
 *   `background` creates one: the app's embed grant.
 * The owner may use all three; an unproved caller none (see the file header).
 */
export async function openTerminalRefusal(intent, caller, access = live) {
  if (intent?.action !== OPEN_TERMINAL_ACTION) return null;
  if (!caller?.appId) {
    if (caller?.owner === true || !openTerminalNeedsProof(intent)) return null;
    return openTerminalCommand(intent)
      ? 'the OPEN_TERMINAL command extra needs the owner or the System Terminal'
      : 'the OPEN_TERMINAL sessionId and background extras need the owner or an app granted terminal.embed';
  }
  if (await access.isSystemTerminal(caller.appId)) return null;
  const extras = intent.extras && typeof intent.extras === 'object' ? intent.extras : {};
  if (Object.hasOwn(extras, 'command')) return 'the OPEN_TERMINAL command extra is the System Terminal\'s own';
  if (Object.hasOwn(extras, 'sessionId') && !(await access.mayUseSession(caller.appId, extras.sessionId))) {
    return 'this app was not granted that Terminal session';
  }
  if (extras.background === true && !(await access.holdsEmbedGrant(caller.appId))) {
    return 'this app was not granted terminal.embed';
  }
  return null;
}

/**
 * `frame-ancestors` origins for a Terminal `embed=1` page (router seam), on top
 * of the Shell. Exactly the embedder the URL names, and only when that app may
 * show this session and the session lives on the instance behind this host.
 */
export async function terminalEmbedAncestors({ record, slot, url, edge, base, registry, buildOrigin }, access = live) {
  if (record?.appId !== TERMINAL_APP_ID || !slot?.instanceId) return [];
  let params;
  try { params = new URL(url, 'http://h').searchParams; } catch { return []; }
  const sessionId = params.get('session');
  const label = params.get(EMBEDDER_PARAM);
  if (!label || terminalSessionInstance(sessionId) !== slot.instanceId) return [];
  if (!(await access.isSystemTerminal(record.appId))) return [];
  try {
    const found = await registry.resolveLabel(label);
    if (found?.status !== 'active') return [];
    if (!(await access.mayUseSession(found.record.appId, sessionId))) return [];
    const origin = buildOrigin(edge.scheme, label, base);
    return origin ? [origin] : [];
  } catch {
    return [];
  }
}
