import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { AURA_RESERVED_PATHS, parseAppHost } from '@aura/core/host-rules';
import { issueAppHostHandoff } from '../../../lib/appHostHandoff.ts';
import { jsonResponse } from '../../../lib/appResponse.js';
import { loadAppHostServices } from '../../../../server/app-host-auth.mjs';
import { gatewayClaimOf } from '../../../../server/gateway-identity.mjs';
import { EMBEDDER_PARAM, TERMINAL_APP_ID, mayUseSession, terminalSessionInstance } from '../../../../server/terminal-embed.mjs';
import { gatewayInstance } from '../../../lib/access/identify.ts';

/**
 * Show a Terminal session inside an app (D25, 5.16). App Host gateway only:
 * the answer signs THIS browser in to the Terminal instance that holds the
 * session, bound to the same owner session as the caller's own host cookie.
 *
 *   POST {sessionId} → {url, origin}
 *
 * `url` is the Terminal's `/_aura/handoff`, continuing to
 * `/?embed=1&session=<id>&_aura_embedder=<caller's label>`. The router lets
 * exactly that embedder frame it (`frame-ancestors`), and only while the app
 * still holds `terminal.embed` and the session's own grant. A session the app
 * did not create is refused.
 */
export const POST: APIRoute = async ({ request }) => {
  const mgr = core.getAppManager();
  const claim = gatewayClaimOf(request);
  const inst = gatewayInstance(request, mgr);
  if (!claim || !inst || inst === 'invalid' || typeof claim.sid !== 'string' || !claim.sid) {
    return jsonResponse({ error: 'app-host-only', message: 'Open the session from an App Host page.' }, 403);
  }
  const body = await request.json().catch(() => null) as { sessionId?: unknown } | null;
  const sessionId = body?.sessionId;
  const terminalInstance = terminalSessionInstance(sessionId);
  if (!terminalInstance || typeof sessionId !== 'string') return jsonResponse({ error: 'bad-session-id' }, 400);
  if (!(await mayUseSession(inst.appId, sessionId))) {
    return jsonResponse({ error: 'not-granted', message: 'This app was not granted that Terminal session. Open it in a Terminal window.' }, 403);
  }

  const services = await loadAppHostServices();
  if (!services) return jsonResponse({ error: 'unavailable' }, 503);
  if (!(await services.sessionLive(claim.sid))) return jsonResponse({ error: 'session-ended' }, 401);
  let desktop: { scheme: string; host: string } | null = null;
  try {
    const u = new URL(claim.origin);
    const parsed = parseAppHost(u.host);
    if (parsed) desktop = { scheme: u.protocol.slice(0, -1), host: parsed.base };
  } catch { desktop = null; }
  if (!desktop) return jsonResponse({ error: 'no-app-hosts' }, 409);

  const returnPath = `/?embed=1&session=${encodeURIComponent(sessionId)}&${EMBEDDER_PARAM}=${encodeURIComponent(claim.label)}`;
  try {
    const issued = await issueAppHostHandoff({
      services, mgr, appId: TERMINAL_APP_ID, instanceId: terminalInstance, returnPath,
      scheme: desktop.scheme, desktopHost: desktop.host,
      identity: { sid: claim.sid, userId: claim.userId, sessionExpiresAt: null },
    });
    if ('error' in issued) return jsonResponse({ error: issued.error }, issued.status);
    const url = new URL(AURA_RESERVED_PATHS.handoff, issued.origin);
    url.searchParams.set('code', issued.code);
    url.searchParams.set('next', returnPath);
    return jsonResponse({ url: url.href, origin: issued.origin });
  } catch (err) {
    console.warn(`[terminal] embed handoff failed: ${(err as Error)?.name ?? 'error'}`);
    return jsonResponse({ error: 'unavailable' }, 503);
  }
};
