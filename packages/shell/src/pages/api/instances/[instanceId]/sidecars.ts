import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { jsonBody, sidecarError, sidecarGate } from '../../../../lib/instanceAuth.js';

/**
 * Inspect data for one instance: its own sandbox plus every sidecar attached
 * to it (backend-neutral — see `SidecarInfo`), each with live resource usage.
 *
 *   GET → { instanceId, instance: { usage }, sidecars: [...SidecarInfo, usage], totalMemBytes }
 *
 * Usage is measured on demand (a backend call per request), so poll this only
 * while an inspect view is open.
 *
 *   GET ?usage=0 → { instanceId, sidecars: [...SidecarInfo] }
 *
 * The cheap form for lists (`aura get sidecars`): straight from the
 * reconciler's cache, no `docker stats` round-trip. Both GET forms list every
 * sidecar (app- and OS-managed) and need no token.
 *
 *   GET ?view=managed   (token, sidecars.spawn) → { sidecars: OsSidecar[] }
 *   POST {template, name?|suffix?, env?, envInherit?, command?, mounts?, image?, replace?, takeover?, wait?}
 *                       (token, sidecars.spawn) → 201 { ok, created: true, sidecar } | 200 adopted
 *
 * OS-managed sidecars: the OS does the `docker run` (SidecarManager), so the
 * app needs no docker tool. See core's sidecar-spec.ts for what may be asked.
 */
export const GET: APIRoute = async ({ params, url, request }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = core.getAppManager();
  if (!mgr.getInstance(instanceId)) return errorResponse(`Instance not found: ${instanceId}`, 404);

  if (url.searchParams.get('view') === 'managed') {
    const gate = sidecarGate(params, request, ['sidecars.spawn']);
    if (gate instanceof Response) return gate;
    // A sidecar caller sees only what it may manage (its own subtree, unless sidecars.manageAll).
    try { return jsonResponse({ sidecars: await gate.mgr.osSidecars.list(instanceId, gate.caller) }); }
    catch (err) { return sidecarError(err); }
  }

  if (url.searchParams.get('usage') === '0') {
    return jsonResponse({ instanceId, sidecars: mgr.getSidecars(instanceId) });
  }

  try {
    const { instance, sidecars } = await mgr.getInstanceUsage(instanceId);
    const mems = [instance?.memBytes, ...sidecars.map((s) => s.usage?.memBytes)];
    const totalMemBytes = mems.every((m) => m == null)
      ? null
      : mems.reduce<number>((sum, m) => sum + (m ?? 0), 0);
    return jsonResponse({ instanceId, instance: { usage: instance }, sidecars, totalMemBytes });
  } catch (err) {
    return errorResponse(`Could not read usage for ${instanceId}: ${(err as Error).message}`, 502);
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.spawn']);
  if (gate instanceof Response) return gate;
  const body = await jsonBody<unknown>(request);
  if (body instanceof Response) return body;
  try {
    const req = core.parseSpawnRequest(body);
    const res = await gate.mgr.osSidecars.spawn(gate.instance.instanceId, req, gate.caller);
    return jsonResponse({ ok: true, ...res }, res.created ? 201 : 200);
  } catch (err) {
    return sidecarError(err);
  }
};
