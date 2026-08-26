import type { APIRoute } from 'astro';
import { getAppManager, ProvidedInterfaceSchema } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';
import { identifyInstance } from './identify.js';

/**
 * Interface discovery + runtime registration.
 *
 *   GET  /api/interfaces                    → { interfaces, consumers }
 *        ?kind= &appId= &name=              filters (ANDed)
 *        ?live=1                            only entries a running instance serves
 *        ?consumers=0                       skip the resolution report
 *   POST /api/interfaces                    register an interface this instance
 *        { name, kind, address, version?, description?, schema?, permission? }
 *
 * Reads are open to every app: the response contains only what apps themselves
 * declared, plus a proxy path any caller could already construct. Writes are
 * caller-scoped — see identify.ts.
 */
export const GET: APIRoute = ({ url }) => {
  const mgr = getAppManager();
  const q = url.searchParams;

  const filter = {
    ...(q.get('kind')  ? { kind:  q.get('kind') as never } : {}),
    ...(q.get('appId') ? { appId: q.get('appId')! }        : {}),
    ...(q.get('name')  ? { name:  q.get('name')! }         : {}),
    ...(q.get('live') === '1' ? { live: true } : {}),
  };

  const interfaces = mgr.listInterfaces(filter);
  // The consumer report is the expensive half and the panel is its only real
  // consumer, so it can be turned off.
  const consumers = q.get('consumers') === '0' ? [] : mgr.interfaces.consumers();
  return jsonResponse({ interfaces, consumers });
};

export const POST: APIRoute = async ({ request }) => {
  const mgr = getAppManager();

  const instance = identifyInstance(request, mgr);
  if (!instance) {
    return errorResponse(
      'Could not identify the calling instance. Call from an app iframe, or send X-Aura-Instance-Id.',
      401,
    );
  }

  const body = await request.json().catch(() => null) as unknown;
  if (!body || typeof body !== 'object') {
    return errorResponse('body must be { name, kind, address, version?, description?, schema?, permission? }', 400);
  }

  // Validated at the boundary, not in core: the registry stays transport-
  // agnostic, and this is the same split the rest of the shell uses.
  const parsed = ProvidedInterfaceSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return errorResponse(`invalid interface: ${first?.path.join('.') || 'body'} — ${first?.message ?? 'invalid'}`, 400);
  }

  const result = mgr.interfaces.register(instance.instanceId, parsed.data);
  if (!result.ok) return errorResponse(result.error, result.status);

  const view = mgr.listInterfaces({ appId: instance.appId, name: parsed.data.name })[0];
  return jsonResponse({ ok: true, interface: view }, 201);
};
