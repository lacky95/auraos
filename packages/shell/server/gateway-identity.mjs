/**
 * The signed claim the App Host gateway (./app-gateway.mjs) sends to the shell
 * API in `GATEWAY_IDENTITY_HEADER`, and its verification. Both run in this one
 * process, so the key is random per boot, held on globalThis (the Astro build
 * bundles its own copy of this module) and never written anywhere.
 *
 *   agw1.<b64url(json GatewayIdentityClaim)>.<b64url(HMAC-SHA256(key, payload))>
 *
 * A claim is bound to one method and path and lives for seconds. No request
 * from outside can produce one, and shell-credentials.mjs removes it from
 * anything leaving for an app.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';

const KEY = Symbol.for('aura.gateway.key');
const PREFIX = 'agw1';
export const GATEWAY_CLAIM_TTL_S = 30;

/**
 * Trusted system UIs (D45): the owner acts through these apps, and through no
 * other. Fixed here, never configurable, and only their `system` scope copy
 * qualifies. Each lists the API groups (first segment after `/api`) and exact
 * routes where the owner rule may apply; anything else stays on instance rules.
 */
export const OWNER_UI_APPS = Object.freeze({
  'com.aura.settings': Object.freeze({
    // `notifications`: the owner reads them through Settings (core notifications `OwnerCaller`).
    groups: Object.freeze(['activities', 'admin', 'apps', 'instances', 'interfaces', 'kv', 'notifications', 'os', 'scopes']),
    // Users & Identities. Never the `auth` group: password routes stay in the shell's dialog.
    routes: Object.freeze(['/api/auth/account', '/api/auth/sessions/revoke-others']),
  }),
  'com.aura.nexus': Object.freeze({
    groups: Object.freeze(['apps', 'nexus']),
    routes: Object.freeze(['/api/os/ui/command']),
  }),
  // The Terminal's instance and session picker (D29: the owner in the desktop has full control).
  'com.aura.terminal': Object.freeze({
    groups: Object.freeze([]),
    routes: Object.freeze(['/api/apps/[id]/instances', '/api/apps/[id]/start', '/api/instances/[instanceId]/activities']),
  }),
});

/** The trusted system UI entry for an app id, or null. */
export function ownerUiApp(appId) {
  return Object.hasOwn(OWNER_UI_APPS, appId) ? OWNER_UI_APPS[appId] : null;
}

/**
 * Whether this installation is the app's active `system` one (D45). The one
 * rule for "this is the built-in app": a same-id app installed in `global` or
 * `user` (a store update, `aura dev clone`) has its own installation and
 * never passes. The desktop marks such frames from it too (auraChannelShell).
 */
export async function isSystemInstallation(registry, { appId, installationId }) {
  if (typeof appId !== 'string' || !appId || typeof installationId !== 'string' || !installationId) return false;
  const inst = await registry?.getInstallation?.(installationId);
  return !!inst && inst.appId === appId && inst.scope === 'system' && inst.state === 'active';
}

/** Whether this app and installation may act for the owner: an allowlisted id on its system installation. */
export async function isOwnerUiInstallation(registry, ref) {
  return !!ownerUiApp(ref?.appId) && isSystemInstallation(registry, ref);
}

const routeRegexes = new Map();
/** An Astro route pattern (`/api/apps/[id]/start`) as a regex over concrete paths. */
function routeRegex(route) {
  let re = routeRegexes.get(route);
  if (!re) {
    const body = route.split('/').map((seg) => {
      if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return '.+';
      if (/^\[[^\]]+\]$/.test(seg)) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    re = new RegExp(`^${body}$`);
    routeRegexes.set(route, re);
  }
  return re;
}

/**
 * Whether the owner may act through `appId` on this shell path: an API group
 * (first segment after `/api`) or exact route its OWNER_UI_APPS entry lists.
 * Takes the concrete path, so the gateway, the route manifest check and
 * `authenticate()` all answer from what was actually called.
 */
export function ownerUiCovers(appId, path) {
  const entry = ownerUiApp(appId);
  if (!entry) return false;
  const p = String(path ?? '').split(/[?#]/, 1)[0];
  if (!p.startsWith('/api/')) return false;
  const group = p.split('/')[2] ?? '';
  return entry.groups.includes(group) || entry.routes.some((route) => routeRegex(route).test(p));
}

/**
 * D45, the one scope decision: the owner acts through this app on this path.
 * An allowlisted app, a path its entry covers, its active `system`
 * installation, and a live owner session. The gateway signs an owner claim
 * only when this holds, and the shell checks it again (identify.ts
 * `gatewayOwner`, used by the route manifest check and `authenticate()`).
 * Throws when the registry can't be read; callers fail closed.
 */
export async function ownerUiActs({ appId, installationId, sid, userId, path }, { registry, sessionLive }) {
  if (!ownerUiCovers(appId, path)) return false;
  if (!(await isOwnerUiInstallation(registry, { appId, installationId }))) return false;
  return typeof sid === 'string' && !!sid && !!(await sessionLive(sid, userId));
}

export function gatewayKey() {
  globalThis[KEY] ??= randomBytes(32);
  return globalThis[KEY];
}

const mac = (payload) => createHmac('sha256', gatewayKey()).update(payload).digest();

/** `/a/../b?x` and `/b?x` are one path: compare what the router will see. */
function canonicalPath(path) {
  const u = new URL(path, 'http://gateway');
  return `${u.pathname}${u.search}`;
}

export function signGatewayClaim(claim) {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${PREFIX}.${payload}.${mac(payload).toString('base64url')}`;
}

const validOwner = (o) => !!o && typeof o === 'object'
  && typeof o.userId === 'string' && !!o.userId && typeof o.sid === 'string' && !!o.sid;

/** The claim, if the token is genuine, current and for this method and path. Never throws. */
export function verifyGatewayClaim(token, { method, path, now = Date.now() }) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    const given = Buffer.from(parts[2], 'base64url');
    const want = mac(parts[1]);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const claim = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (claim?.v !== 1 || typeof claim.appId !== 'string' || !claim.appId) return null;
    if (claim.owner !== undefined && !validOwner(claim.owner)) return null;
    const seconds = now / 1000;
    if (typeof claim.exp !== 'number' || claim.exp < seconds || claim.iat > seconds + 5) return null;
    if (claim.method !== method || canonicalPath(claim.path) !== canonicalPath(path)) return null;
    return claim;
  } catch {
    return null;
  }
}

const verified = new WeakMap();

/**
 * The claim on a web `Request`: null without the header, false when it doesn't
 * verify. Cached per request, because the middleware and the route both ask.
 */
export function gatewayClaimOf(request) {
  const token = request.headers.get(GATEWAY_IDENTITY_HEADER);
  if (token === null) return null;
  if (verified.has(request)) return verified.get(request);
  let claim = false;
  try {
    const u = new URL(request.url);
    claim = verifyGatewayClaim(token, { method: request.method, path: `${u.pathname}${u.search}` }) ?? false;
  } catch { /* unparsable URL: not verified */ }
  verified.set(request, claim);
  return claim;
}
