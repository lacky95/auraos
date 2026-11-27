import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { getAppManager } from '@aura/core';
import { capabilityRefusal } from '../../../../lib/runtimeCaps.ts';
import { jsonResponse, errorResponse, failureResponse } from '../../../../lib/appResponse.js';

/**
 * Cross-container port exposes for one instance.
 *
 *   GET  → { ports: AuraPortExpose[] }
 *   POST into: { kind:'into', sourceAppId, sourcePort, port?, sticky? }
 *           → the URL instance is the TARGET; sourceAppId's port appears on the
 *             target's 127.0.0.1.
 *   POST host: { kind:'host', sourcePort, port?/hostPort?, bindAddr?, sticky? }
 *           → the URL instance is the SOURCE; its port is published on the host.
 *
 * Same permission model as mounts: the app of the instance in the URL (never
 * the body) must declare `apps.port`, the route access manifest's
 * `targetPermissions` (routeManifest.ts), applied by the middleware.
 */
export const GET: APIRoute = ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = getAppManager();
  if (!mgr.getInstance(instanceId)) return errorResponse(`Instance not found: ${instanceId}`, 404);

  return jsonResponse({ ports: mgr.portExpose.list(instanceId) });
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);

  let body: {
    kind?: string; sourceAppId?: string; sourcePort?: number;
    port?: number; hostPort?: number; bindAddr?: string; sticky?: boolean;
  };
  try { body = await request.json(); }
  catch { return errorResponse('Body must be JSON', 400); }

  const kind = body.kind;
  if (kind !== 'into' && kind !== 'host') {
    return errorResponse(`kind must be 'into' or 'host'`, 400);
  }
  if (typeof body.sourcePort !== 'number' || body.sourcePort < 1 || body.sourcePort > 65535) {
    return errorResponse('sourcePort must be a valid port number', 400);
  }

  // `into` joins the target's own network: its runtime's `portExpose` (5b G).
  if (kind === 'into') {
    const refused = capabilityRefusal(instanceId, core.requestNeeds('port-expose'), "'into' exposing");
    if (refused) return refused;
  }

  // For `into`, the source is another app; for `host`, the source IS this app.
  const sourceAppId = kind === 'into' ? body.sourceAppId : instance.appId;
  if (kind === 'into' && !sourceAppId) return errorResponse('sourceAppId is required for kind: into', 400);
  if (sourceAppId && !mgr.getManifest(sourceAppId)) return errorResponse(`App not found: ${sourceAppId}`, 400);

  let bindAddr: string | undefined;
  if (kind === 'host') {
    bindAddr = body.bindAddr ?? '127.0.0.1';
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(bindAddr)) {
      return errorResponse(`bindAddr must be an IPv4 literal (e.g. 127.0.0.1 or 0.0.0.0)`, 400);
    }
  }

  try {
    const port = await mgr.portExpose.expose(instanceId, {
      kind,
      sourceAppId: sourceAppId!,
      sourcePort: body.sourcePort,
      port: kind === 'host' ? (body.hostPort ?? body.port) : body.port,
      bindAddr,
      sticky: body.sticky === true,
    });
    return jsonResponse({ ok: true, port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const conflict = /already exposed|already in use|conflicts|in use/i.test(message);
    // An app reads it without host paths (D105 Pass B, review §4.4 rule 5).
    return failureResponse({ request, locals }, err, { status: conflict ? 409 : 500 });
  }
};
