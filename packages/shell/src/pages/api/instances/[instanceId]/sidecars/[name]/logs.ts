import type { APIRoute } from 'astro';
import { errorResponse, jsonResponse } from '../../../../../../lib/appResponse.js';
import { sidecarError, sidecarGate } from '../../../../../../lib/instanceAuth.js';

/**
 * Recent output of an OS-managed sidecar.
 *
 *   GET ?tail=200&since=10m&timestamps=1  (token, sidecars.spawn) → { stdout, stderr }
 *
 * `tail` is capped at 5000 lines; docker keeps the two streams apart.
 */
export const GET: APIRoute = async ({ params, request, url }) => {
  const gate = sidecarGate(params, request, ['sidecars.spawn']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  const tail = url.searchParams.get('tail');
  try {
    return jsonResponse(await gate.mgr.osSidecars.logs(gate.instance.instanceId, name, {
      ...(tail ? { tail: Number(tail) } : {}),
      ...(url.searchParams.get('since') ? { since: url.searchParams.get('since')! } : {}),
      timestamps: url.searchParams.get('timestamps') === '1',
    }));
  } catch (err) {
    return sidecarError(err);
  }
};
