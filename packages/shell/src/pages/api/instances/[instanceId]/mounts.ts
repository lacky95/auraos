import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse, failureResponse } from '../../../../lib/appResponse.js';
import { auditOwner, liveOwnerActionDeps, ownerAction } from '../../../../lib/approvals/admin.ts';
import { authenticate } from '../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { liveAppSourceDeps, mountAppVolume } from '../../../../lib/appSource.ts';
import { isDeveloperMode } from '../../../../lib/systemMode.ts';
import { TERMINAL_APP_ID } from '../../../../../server/terminal-embed.mjs';
import { capabilityRefusal, refusalResponse } from '../../../../lib/runtimeCaps.ts';

/**
 * Cross-app mounts for one instance.
 *
 *   GET  → { capable, reason?, mounts[] }      (?includeSidecars=1 → + sidecarMounts[])
 *   POST → { targetAppId, mode?: 'ro'|'rw', data?: boolean } → { ok, mount }
 *          { targetAppId, kind: 'patches' }            the installation's patch repo
 *          { targetAppId, kind: 'work', n?, new? }     a patch workspace of this user
 *          → { ok, mount, installationId, path, created, n? } (Track P, lib/appSource.ts
 *          `mountAppVolume`; always writable; `targetAppId` may also be the app's name)
 *   POST { kind: 'workspace' } → `aura mount workspace` (D60): /workspace,
 *        read-write, at /mnt/aura/workspace of the CALLING System Terminal
 *        instance, by its own token. Developer Mode only; the owner approves
 *        it with one click; never into any other app or a sidecar. It lasts
 *        until `aura mount rm workspace`, the instance stops, or Developer
 *        Mode is switched off.
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

export const POST: APIRoute = async (ctx) => {
  const { params, request } = ctx;
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

  if (body.kind === 'workspace') return mountWorkspace(ctx, instanceId);
  if (body.kind === 'patches' || body.kind === 'work') {
    const deps = liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());
    return mountAppVolume(request, instanceId, deps, { app: body.targetAppId, kind: body.kind, n: body.n, new: body.new });
  }
  if (body.kind !== undefined && body.kind !== 'source' && body.kind !== 'data') {
    return errorResponse(`kind must be 'source', 'data', 'patches', 'work' or 'workspace'`, 400);
  }

  const targetAppId = body.targetAppId;
  if (!targetAppId) return errorResponse('targetAppId is required', 400);
  if (!mgr.getManifest(targetAppId)) return errorResponse(`App not found: ${targetAppId}`, 400);
  if (body.mode && body.mode !== 'ro' && body.mode !== 'rw') {
    return errorResponse(`mode must be 'ro' or 'rw'`, 400);
  }

  // The runtime's `mounts` capability (5b G): a runtime without it has nothing
  // to receive a live bind. Say so rather than mounting into a path nobody can see.
  const refused = capabilityRefusal(instanceId, core.requestNeeds('mount'), 'cross-app mounts');
  if (refused) return refused;

  try {
    const mount = await mgr.mounts.add(instanceId, {
      targetAppId,
      mode: body.mode === 'rw' ? 'rw' : 'ro',
      data: body.data === true || body.kind === 'data',
    });
    return jsonResponse({ ok: true, mount });
  } catch (err) {
    // D80: a cross-uid writable mount without idmapped mounts is `capability-missing: idmappedMounts`.
    const refusal = refusalResponse(err);
    if (refusal) return refusal;
    const message = err instanceof Error ? err.message : String(err);
    // "already mounted" / "unavailable" are conflicts, not server faults.
    const conflict = /already mounted|unavailable|refusing/i.test(message);
    // An app reads it without host paths (D105 Pass B, review §4.4 rule 5).
    return failureResponse(ctx, err, { status: conflict ? 409 : 500 });
  }
};

/** `aura mount workspace`: the checks are the route's, the bind is MountManager's. */
async function mountWorkspace(ctx: Parameters<APIRoute>[0], instanceId: string): Promise<Response> {
  if (!isDeveloperMode()) {
    return errorResponse('aura mount workspace needs Developer Mode (Settings → System, or aura mode developer on the host)', 409);
  }
  const caller = await authenticate(ctx.request);
  if (caller instanceof Response) return caller;
  const mgr = getAppManager();
  // Only the System Terminal instance itself, by its own token: not the
  // owner naming one, not a sidecar, not another Terminal instance, not a
  // copy of the Terminal installed in another scope.
  if (caller.kind !== 'instance' || caller.appId !== TERMINAL_APP_ID || caller.instanceId !== instanceId
    || caller.sidecar || mgr.registry.getScopeId(TERMINAL_APP_ID) !== 'system') {
    return errorResponse('the AuraOS checkout is mounted only into the System Terminal that asks for it: run aura mount workspace there', 403);
  }
  const refused = capabilityRefusal(instanceId, core.requestNeeds('mount'), 'the workspace mount');
  if (refused) return refused;
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'mount.workspace', instanceId },
    title: 'Mount the AuraOS source writable into the System Terminal',
    details: [
      `/workspace appears read-write at /mnt/aura/workspace in ${instanceId}.`,
      'Every session and agent in that Terminal can change the running AuraOS source until it is detached or Developer Mode is switched off.',
    ],
  });
  if (actor instanceof Response) return actor;
  try {
    const mount = await mgr.mounts.addWorkspace(instanceId);
    await auditOwner(actor, 'mount.workspace', { target: instanceId });
    return jsonResponse({ ok: true, mount });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditOwner(actor, 'mount.workspace', { target: instanceId, outcome: 'failed', detail: { error: message } });
    return errorResponse(message, /already mounted|unavailable|refusing|never/i.test(message) ? 409 : 500);
  }
}
