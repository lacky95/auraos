/**
 * Who may use the owner's System Terminal from another app (D25, D29, 5.16).
 * One place for the decision, read by the App Host router (frame-ancestors),
 * the intents route (OPEN_TERMINAL) and the Terminal routes under /api/terminal.
 *
 *   terminal.embed          privileged, owner-granted per app (GrantStore). The
 *                           app may create sessions (OPEN_TERMINAL `background`)
 *                           and show and close the ones it created. Each such
 *                           session also gets a grant of its own, scoped to it,
 *                           which counts only while the app's grant does.
 *   terminal.sessions.list  privileged, separate: read every session's metadata.
 *
 * The System Terminal itself (system scope) keeps full control, and an
 * unverified caller (the owner's desktop, the CLI, an agent) is not an app, so
 * nothing here limits it: deny-by-default for those is Phase 3 and the private
 * Terminal ingress Phase 5.
 *
 * Plain ESM: the router loads it beside the Astro build. @aura/core is
 * imported lazily, and its services are globalThis singletons, so both copies
 * of this file see the same grants and apps.
 */

export const TERMINAL_APP_ID = 'com.aura.terminal';
export const OPEN_TERMINAL_ACTION = 'aura.intent.action.OPEN_TERMINAL';
/** Query parameter naming the App Host label that frames an `embed=1` page. */
export const EMBEDDER_PARAM = '_aura_embedder';

const SESSION_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,199})#([A-Za-z0-9._-]{1,64})$/;

/** The Terminal instance a session id names (`com.aura.terminal-2#a3` → `com.aura.terminal-2`), or null. */
export function terminalSessionInstance(sessionId) {
  const m = typeof sessionId === 'string' ? SESSION_RE.exec(sessionId) : null;
  if (!m || !(m[1] === TERMINAL_APP_ID || m[1].startsWith(`${TERMINAL_APP_ID}-`))) return null;
  return m[1];
}

/**
 * The decisions over a grant store. `deps` (tests pass fakes):
 *   scopeOf(appId)                 the install scope the app id resolves to
 *   authorize(appId, permission)   core's Authorizer for an instance of the app
 *   sessionGrant(appId, sessionId) the session's own `terminal.embed` record, or null
 */
export function createTerminalAccess(deps) {
  /** The System Terminal: its own id in the `system` scope. A same-id copy elsewhere is an ordinary app. */
  async function isSystemTerminal(appId) {
    if (appId !== TERMINAL_APP_ID) return false;
    try { return (await deps.scopeOf(appId)) === 'system'; } catch { return false; }
  }

  /** Whether the owner granted `appId` Terminal embedding at all (requested in its manifest and granted). */
  async function holdsEmbedGrant(appId) {
    try { return await deps.authorize(appId, 'terminal.embed'); } catch { return false; }
  }

  /** Whether `appId` may read every session's metadata. */
  async function holdsListGrant(appId) {
    try { return await deps.authorize(appId, 'terminal.sessions.list'); } catch { return false; }
  }

  /** Whether `appId` may show and close this one session: its app grant, plus the session's own. */
  async function mayUseSession(appId, sessionId) {
    if (!terminalSessionInstance(sessionId)) return false;
    try {
      return (await holdsEmbedGrant(appId)) && !!(await deps.sessionGrant(appId, sessionId));
    } catch {
      return false;
    }
  }

  return { isSystemTerminal, holdsEmbedGrant, holdsListGrant, mayUseSession };
}

const core = () => import('@aura/core');

const live = createTerminalAccess({
  scopeOf: async (appId) => (await core()).getAppManager().registry.getScopeId(appId),
  authorize: async (appId, permission) => {
    const principal = { kind: 'instance', appId, instanceId: `${appId}-grant-check`, verification: 'verified' };
    return (await (await core()).getAuthServices().authorizer.authorize(principal, permission)).allow;
  },
  sessionGrant: async (appId, sessionId) => {
    const c = await core();
    return c.getAuthServices().grants.get({ kind: 'app', id: appId }, 'terminal.embed', c.terminalSessionScope(sessionId));
  },
});
export const { isSystemTerminal, holdsEmbedGrant, holdsListGrant, mayUseSession } = live;

/** Record that `appId` created `sessionId`, so it may show and close it. */
export async function grantSession(appId, sessionId) {
  const c = await core();
  const appScope = c.getAppManager().registry.getScopeId(appId);
  await c.getAuthServices().grants.grant({ kind: 'app', id: appId }, 'terminal.embed', {
    by: { kind: 'system' }, ...(appScope ? { appScope } : {}), scope: c.terminalSessionScope(sessionId),
  });
}

/** The session is gone: its grant goes with it. */
export async function forgetSession(appId, sessionId) {
  try {
    const c = await core();
    await c.getAuthServices().grants.revoke({ kind: 'app', id: appId }, 'terminal.embed', c.terminalSessionScope(sessionId));
  } catch { /* nothing to drop */ }
}

/**
 * Why an app may not send this intent, or null. Applies to a verified app
 * caller only (`caller` = {appId}); see the file header for the others.
 *   `command` types a line as the owner (5.16 safeguard 2): the System
 *             Terminal's own, never an embedder's.
 *   `sessionId` opens a window on an existing session: a session the app was granted.
 *   `background` creates one: the app's embed grant.
 */
export async function openTerminalRefusal(intent, caller, access = live) {
  if (!caller || intent?.action !== OPEN_TERMINAL_ACTION) return null;
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
