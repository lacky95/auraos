import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../../../lib/appResponse.js';
import { jsonBody, sidecarError, sidecarGate } from '../../../../../../lib/instanceAuth.js';

/**
 * Tools of one OS-managed sidecar — what it holds at /aura/my-tools.
 *
 *   GET                       → { own, inherited, template, runtime, effective, ignored }
 *        No token needed (read-only, like `GET …/sidecars?usage=0`); with a
 *        token the caller must be allowed to manage that sidecar.
 *   POST   { tools: [...] }   → { ok, granted, …view }   (token, sidecars.tools)
 *   DELETE ?tool=<name>[&tool=…] → { ok, revoked, …view } (token, sidecars.tools)
 *
 * effective = (template `services[].tools` ∪ runtime grants) ∩ the app's
 * tools[] — a sidecar never holds a tool its app doesn't. Runtime grants are
 * additive, applied live (no recreate), kept across a recreate and dropped
 * with the sidecar or its instance. Template tools are revoked in the
 * template (409 here). The sidecar's template must declare `tools` (even
 * `[]`) so it has a tools dir of its own — 409 otherwise.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  if (request.headers.get('authorization')) {
    const gate = sidecarGate(params, request, ['sidecars.spawn']);
    if (gate instanceof Response) return gate;
    try {
      await gate.mgr.osSidecars.authorize(gate.instance.instanceId, name, gate.caller);
      return jsonResponse(await gate.mgr.osSidecars.listTools(gate.instance.instanceId, name));
    } catch (err) {
      return sidecarError(err);
    }
  }
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const mgr = getAppManager();
  if (!mgr.getInstance(instanceId)) return errorResponse(`Instance not found: ${instanceId}`, 404);
  try {
    return jsonResponse(await mgr.osSidecars.listTools(instanceId, name));
  } catch (err) {
    return sidecarError(err);
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.tools']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  const body = await jsonBody<{ tools?: unknown }>(request);
  if (body instanceof Response) return body;
  try {
    await gate.mgr.osSidecars.authorize(gate.instance.instanceId, name, gate.caller);
    const res = await gate.mgr.osSidecars.grantTools(gate.instance.instanceId, name, body.tools as string[]);
    return jsonResponse({ ok: true, ...res });
  } catch (err) {
    return sidecarError(err);
  }
};

export const DELETE: APIRoute = async ({ params, request, url }) => {
  const gate = sidecarGate(params, request, ['sidecars.tools']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  const tools = url.searchParams.getAll('tool').filter(Boolean);
  if (tools.length === 0) return errorResponse('pass the tool(s) to revoke as ?tool=<name>', 400);
  try {
    await gate.mgr.osSidecars.authorize(gate.instance.instanceId, name, gate.caller);
    const res = await gate.mgr.osSidecars.revokeTools(gate.instance.instanceId, name, tools);
    return jsonResponse({ ok: true, ...res });
  } catch (err) {
    return sidecarError(err);
  }
};
