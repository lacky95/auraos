import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { buildAppHost } from '@aura/core/host-rules';
import { currentOwnerSession, loginEnabled } from '../../../lib/authSurface.js';
import {
  appHostAuth, LOGIN_DARK_SID, loadAppHostServices, safeReturnPath,
} from '../../../../server/app-host-auth.mjs';
import { classifyHost, edgeView, originOf } from '../../../../server/host-policy.mjs';

const MAX_BODY_BYTES = 4 * 1024;
const HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._#:-]{1,256}$/.test(v);
const peerOf = (ctx: { clientAddress?: string }) => {
  try { return ctx.clientAddress; } catch { return undefined; }
};

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * A one-time code that signs this browser in to one App Host. Shell origin
 * only: App Hosts are same-site with the shell, so an exact Origin is what
 * stops one app from asking for a code to another.
 *
 * Body `{appId, instanceId, activityId, returnPath}`, answer `{code, origin, slot}`.
 * The label and slot come from the registry, never from the body.
 */
export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
  const edge = edgeView({ peer: peerOf(ctx), header: (name) => request.headers.get(name) });
  const site = request.headers.get('sec-fetch-site');
  if ((site !== null && site !== 'same-origin') || request.headers.get('origin') !== edge.origin) {
    return json({ error: 'forbidden-origin' }, 403);
  }
  const shell = classifyHost(edge.host);
  if (shell.kind !== 'shell' || shell.internal) return json({ error: 'no-app-hosts' }, 409);

  const body = await readBody(request);
  if (!body) return json({ error: 'invalid-request' }, 400);
  const returnPath = safeReturnPath(body['returnPath'] ?? '/');
  const { appId, instanceId } = body;
  const activityId = body['activityId'] ?? null;
  if (!returnPath || !isId(appId) || !isId(instanceId) || (activityId !== null && !isId(activityId))) {
    return json({ error: 'invalid-request' }, 400);
  }

  try {
    let identity: { sid: string; userId: string | null; sessionExpiresAt: number | null };
    if (loginEnabled()) {
      const current = await currentOwnerSession(ctx);
      if (!current) return json({ error: 'login-required' }, 401);
      identity = { sid: current.sessionId, userId: current.userId, sessionExpiresAt: current.expiresAt };
    } else {
      identity = { sid: LOGIN_DARK_SID, userId: null, sessionExpiresAt: null };
    }

    const services = await loadAppHostServices();
    if (!services) return json({ error: 'unavailable' }, 503);
    const mgr = core.getAppManager();
    const manifest = mgr.getManifest(appId);
    if (!manifest || manifest.componentType === 'service') return json({ error: 'not-found' }, 404);
    if (await services.frameRoute(appId) !== 'host') return json({ error: 'not-host-routed' }, 409);

    // The body only names a window. Each id is checked against what is running.
    const instance = mgr.getInstance(instanceId);
    if (!instance || instance.appId !== appId || instance.inPool) return json({ error: 'not-found' }, 404);
    if (activityId !== null) {
      const activity = mgr.getActivity(activityId);
      if (!activity || activity.appId !== appId || activity.parentInstanceId !== instanceId) return json({ error: 'not-found' }, 404);
    }

    const held = (await services.registry.listForApp(appId))
      .filter((r) => r.state === 'active')
      .flatMap((r) => r.slots.filter((s) => s.instanceId === instanceId));
    if (held.length !== 1) return json({ error: 'slot-not-assigned' }, 409);
    const label = held[0]!.label;
    const resolved = await services.registry.resolveLabel(label);
    if (resolved.status === 'retired') return json({ error: 'retired' }, 410);
    if (resolved.status !== 'active' || resolved.record.appId !== appId || resolved.slot.instanceId !== instanceId) {
      return json({ error: 'slot-not-assigned' }, 409);
    }
    const { record, slot } = resolved;
    const host = buildAppHost(label, edge.host);
    if (!host) return json({ error: 'no-app-hosts' }, 409);

    const scopeUser = record.instanceScope.kind === 'user' ? record.instanceScope.userId : 'default';
    const origin = originOf(edge.scheme, host);
    const { code } = appHostAuth().issueCode({
      aud: origin, label, installationId: record.installationId, appId, slot: slot.slot,
      userId: identity.userId ?? scopeUser, sid: identity.sid, returnPath,
      sessionExpiresAt: identity.sessionExpiresAt,
    });
    return json({ code, origin, slot: slot.slot });
  } catch (err) {
    console.warn(`[app-hosts] handoff failed: ${(err as Error)?.name ?? 'error'}`);
    return json({ error: 'unavailable' }, 503);
  }
};
