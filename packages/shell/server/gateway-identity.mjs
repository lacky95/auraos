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
    groups: Object.freeze(['activities', 'admin', 'apps', 'instances', 'interfaces', 'kv', 'os', 'scopes']),
    routes: Object.freeze([]),
  }),
  'com.aura.nexus': Object.freeze({
    groups: Object.freeze(['apps', 'nexus']),
    routes: Object.freeze(['/api/os/ui/command']),
  }),
});

/** The trusted system UI entry for an app id, or null. */
export function ownerUiApp(appId) {
  return Object.hasOwn(OWNER_UI_APPS, appId) ? OWNER_UI_APPS[appId] : null;
}

/**
 * Whether this app and installation may act for the owner: an allowlisted id
 * whose host record belongs to the active `system` installation. A same-id
 * app installed in `global` or `user` has its own installation and never passes.
 */
export async function isOwnerUiInstallation(registry, { appId, installationId }) {
  if (!ownerUiApp(appId) || typeof installationId !== 'string' || !installationId) return false;
  const inst = await registry?.getInstallation?.(installationId);
  return !!inst && inst.appId === appId && inst.scope === 'system' && inst.state === 'active';
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
