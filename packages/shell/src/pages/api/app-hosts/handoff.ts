import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { issueAppHostHandoff } from '../../../lib/appHostHandoff.ts';
import { currentOwnerSession, loginEnabled } from '../../../lib/authSurface.js';
import { LOGIN_DARK_SID, loadAppHostServices, safeReturnPath } from '../../../../server/app-host-auth.mjs';
import { classifyHost, edgeView } from '../../../../server/host-policy.mjs';

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

    // The body only names a window. Each id is checked against what is running.
    if (activityId !== null) {
      const activity = mgr.getActivity(activityId);
      if (!activity || activity.appId !== appId || activity.parentInstanceId !== instanceId) return json({ error: 'not-found' }, 404);
    }
    const issued = await issueAppHostHandoff({
      services, mgr, appId, instanceId, returnPath, scheme: edge.scheme, desktopHost: edge.host, identity,
    });
    if ('error' in issued) return json({ error: issued.error }, issued.status);
    return json(issued);
  } catch (err) {
    console.warn(`[app-hosts] handoff failed: ${(err as Error)?.name ?? 'error'}`);
    return json({ error: 'unavailable' }, 503);
  }
};
