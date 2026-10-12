import type { APIRoute } from 'astro';
import type { ExecRequest } from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../../../lib/appResponse.js';
import { jsonBody, sidecarError, sidecarGate } from '../../../../../../lib/instanceAuth.js';

/**
 * Run one command in an OS-managed sidecar — the `docker exec` an app without
 * the docker tool can't do itself (psql, init scripts, health probes).
 *
 *   POST {cmd: string[], user?, workdir?, env?, stdin? (≤ 64 KiB), timeoutMs? (≤ 10 min)}
 *        (token, sidecars.spawn) → { exitCode, stdout, stderr, truncated, timedOut }
 *
 * argv only, no shell: pass ["sh", "-c", "…"] if you want one. Output is
 * capped at 4 MiB per stream (`truncated`). Interactive sessions are out of
 * scope.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.spawn']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  const body = await jsonBody<ExecRequest>(request);
  if (body instanceof Response) return body;
  try {
    await gate.mgr.osSidecars.authorize(gate.instance.instanceId, name, gate.caller);
    return jsonResponse(await gate.mgr.osSidecars.exec(gate.instance.instanceId, name, body));
  } catch (err) {
    return sidecarError(err);
  }
};
