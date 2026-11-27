import { defineMiddleware } from 'astro:middleware';
// Namespace import: a live reload of this file must not 500 every request
// when the running shell still caches a core build without the export.
import * as core from '@aura/core';
import { noteClientConnected } from './lib/onboarding/index.js';
import { startFlightService } from './lib/flight/service.js';
import { compositionOf } from './integrations/composition.mjs';
import { captureAccess, createAccessReporter } from './lib/access/guard.ts';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { shellFramePolicy } from './lib/desktop/shellFramePolicy.ts';
import { runAfterResponse } from './lib/afterResponse.ts';

/**
 * Readiness (Phase 6 K): the kernel boots eagerly (lib/bootHooks.ts, started by
 * server.mjs or the dev plugin), never on a request. A request that arrives
 * while it boots waits a bounded time, then gets 503 `starting`; the health
 * probe `/api/auth/status` answers 503 at once.
 */
const READY_WAIT_MS = 15_000;
const starting = (body: Record<string, string>) => new Response(JSON.stringify(body), {
  status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '2' },
});

async function kernelReady(path: string): Promise<Response | null> {
  const sys = core.getSystem();
  if (sys?.isReady()) return null;
  // The health probe (the updater, the Headless test) answers at once.
  if (path === '/api/auth/status') return starting({ login: 'starting' });
  if (!sys) return starting({ error: 'starting', detail: 'the kernel was not started (server.mjs or the dev plugin starts it)' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    sys.ready.then(() => true, () => false),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(false), READY_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  return waited && sys.isReady() ? null : starting({ error: 'starting' });
}

let flightServiceStarted = false;

// The access report (lib/access/observer.ts): loaded on first use, and nothing it does can reach a response.
const reportAccess = createAccessReporter(() => import('./lib/access/observer.ts'));

// Fails closed: the access check itself failed, which is not a policy refusal.
const accessUnavailable = () => new Response(JSON.stringify({
  error: 'access-unavailable',
  message: 'AuraOS could not check this request, so it is refused (fails closed).',
  category: 'unavailable',
  hint: 'Retry; if it persists, the owner checks aura status.',
}), {
  status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

// The `server` composition (D76, Phase 6 W) has no desktop: its root names the system, nothing more.
const SERVER_ROOT = JSON.stringify({ system: 'aura', composition: 'server' });

export const onRequest = defineMiddleware(async (ctx, next) => {
  if (ctx.url.pathname === '/' && compositionOf(process.env) === 'server') {
    return new Response(SERVER_ROOT, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  const access = captureAccess(ctx);
  const notReady = await kernelReady(ctx.url.pathname);
  if (notReady) {
    reportAccess(access, notReady.status);
    return notReady;
  }
  core.getSystem()?.noteFirstRequest();
  // Free-flight activities (lib/flight/service.ts), a Web Shell feature: once per shell
  // build — a hot-swapped build takes over the previous one's listeners + notifications.
  if (!flightServiceStarted && compositionOf(process.env) !== 'server') {
    flightServiceStarted = true;
    try { startFlightService(); }
    catch (err) { console.warn(`[middleware] flight service start failed: ${(err as Error).message}`); }
  }
  // App Host gateway calls: the manifest decides here, in every access mode.
  if (ctx.request.headers.has(GATEWAY_IDENTITY_HEADER)) {
    let refused: Response | null;
    try {
      refused = await (await import('./lib/access/gatewayCaller.ts')).enforceGateway(ctx);
    } catch {
      // The check failed, not the policy: fails closed, as the gate below does.
      refused = accessUnavailable();
    }
    if (refused) {
      // The report counts the variant the body settles (the gate below never sees this request).
      if (access) {
        try {
          const v = await (await import('./lib/access/enforce.ts')).reportBodyVariant(ctx);
          if (v !== undefined) access.bodyVariant = v;
        } catch { /* the report only */ }
      }
      reportAccess(access, refused.status);
      return refused;
    }
  }
  // Every /api route (lib/access/enforce.ts): the whole manifest in `enforce`,
  // a rule's `guard` in every mode. Fails closed.
  let gate: Awaited<ReturnType<typeof import('./lib/access/enforce.ts')['liveAccessGate']>>;
  try {
    gate = await (await import('./lib/access/enforce.ts')).liveAccessGate(ctx);
  } catch {
    reportAccess(access, 503);
    return accessUnavailable();
  }
  if (gate.identity) {
    // One verdict: the route reads it, and the report counts it.
    ctx.locals.access = gate.identity;
    if (access) access.identity.verified = gate.identity;
  }
  if (access && gate.bodyVariant !== undefined) access.bodyVariant = gate.bodyVariant;
  if (gate.refused) {
    reportAccess(access, gate.refused.status);
    return gate.refused;
  }
  reportAccess.identify(access, ctx.request);
  let res: Response;
  let status = 500;
  try {
    res = await next();
    status = res.status;
  } catch (err) {
    reportAccess(access, 500);
    throw err;
  } finally {
    // PHASE3-C: the post-response hook point (lib/afterResponse.ts), e.g. the
    // gateway's owner-action audit, with the route's final status.
    runAfterResponse(ctx.request, status);
  }
  reportAccess(access, res.status);
  // A shell tab registering itself: onboarding cards wait for the first one,
  // because only notifications that arrive while a tab listens pop up.
  if (ctx.request.method === 'POST' && ctx.url.pathname === '/api/os/clients' && res.ok) noteClientConnected();
  // The shell's own documents can't be framed (lib/desktop/shellFramePolicy.ts).
  const framePolicy = shellFramePolicy(ctx.url.pathname, res.headers.get('content-type'), res.headers.get('content-security-policy'));
  if (framePolicy) {
    try { res.headers.set('Content-Security-Policy', framePolicy); }
    catch { /* immutable headers: not a page this shell rendered */ }
  }
  return res;
});
