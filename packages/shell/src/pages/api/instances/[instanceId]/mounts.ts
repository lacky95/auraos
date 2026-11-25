import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { authenticate } from '../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../lib/approvals/admin.ts';
import { liveAppSourceDeps, mountAppVolume } from '../../../../lib/appSource.ts';

/**
 * Cross-app mounts for one instance.
 *
 *   GET  → { capable, reason?, mounts[] }      (?includeSidecars=1 → + sidecarMounts[])
 *   POST → { targetAppId, mode?: 'ro'|'rw', data?: boolean } → { ok, mount }
 *          { targetAppId, kind: 'patches' }            the installation's patch repo
 *          { targetAppId, kind: 'work', n?, new? }     a patch workspace of this user
 *          → { ok, mount, installationId, path, created, n? } (Track P, lib/appSource.ts
 *          `mountAppVolume`; always writable; `targetAppId` may also be the app's name)
 *
 * `capable` reports whether this host can propagate mounts at all, so a client
 * can explain WHY mounting is unavailable instead of just failing.
 */
export const GET: APIRoute = ({ params, url }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = getAppManager();
  if (!mgr.getInstance(instanceId)) return errorResponse(`Instance not found: ${instanceId}`, 404);

  const cap = mgr.mounts.capable();
  // ?includeSidecars=1 adds the mounts of the instance's OS-managed sidecars
  // (own + inherited) — read-only, like the rest of this GET.
  const sidecarMounts = url.searchParams.get('includeSidecars') === '1'
    ? mgr.osSidecars.liveConsumerKeys()
      .filter((k) => k.startsWith(`${instanceId}--`))
      .map((k) => ({ sidecar: k.slice(instanceId.length + 2), mounts: mgr.mounts.list(k) }))
    : undefined;
  return jsonResponse({ capable: cap.ok, reason: cap.reason, mounts: mgr.mounts.list(instanceId), ...(sidecarMounts ? { sidecarMounts } : {}) });
};

export const POST: APIRoute = async ({ params, request }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);

  // The CONSUMER app (from the instance record, never the body) must hold
  // `apps.mount`: the route access manifest's `targetPermissions`, which the
  // middleware applies in every access mode (routeManifest.ts).

  let body: { targetAppId?: string; mode?: string; data?: boolean; kind?: string; n?: unknown; new?: unknown };
  try { body = await request.clone().json(); }
  catch { return errorResponse('Body must be JSON', 400); }

  if (body.kind === 'patches' || body.kind === 'work') {
    const deps = liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());
    return mountAppVolume(request, instanceId, deps, { app: body.targetAppId, kind: body.kind, n: body.n, new: body.new });
  }
  if (body.kind !== undefined && body.kind !== 'source' && body.kind !== 'data') {
    return errorResponse(`kind must be 'source', 'data', 'patches' or 'work'`, 400);
  }

  const targetAppId = body.targetAppId;
  if (!targetAppId) return errorResponse('targetAppId is required', 400);
  if (!mgr.getManifest(targetAppId)) return errorResponse(`App not found: ${targetAppId}`, 400);
  if (body.mode && body.mode !== 'ro' && body.mode !== 'rw') {
    return errorResponse(`mode must be 'ro' or 'rw'`, 400);
  }

  // Container-only: a PRoot instance has no /data volume mount to receive
  // propagation. Say so rather than mounting into a path nobody can see.
  if (instance.sandbox && instance.sandbox !== 'container') {
    return errorResponse(
      `${instanceId} runs in a '${instance.sandbox}' sandbox; cross-app mounting requires sandbox: container`,
      409,
    );
  }

  try {
    const mount = await mgr.mounts.add(instanceId, {
      targetAppId,
      mode: body.mode === 'rw' ? 'rw' : 'ro',
      data: body.data === true || body.kind === 'data',
    });
    return jsonResponse({ ok: true, mount });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "already mounted" / "unavailable" are conflicts, not server faults.
    const conflict = /already mounted|unavailable|refusing/i.test(message);
    return errorResponse(message, conflict ? 409 : 500);
  }
};
