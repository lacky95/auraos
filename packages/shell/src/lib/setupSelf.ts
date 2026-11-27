/**
 * `GET /api/setup/self` (D108 value delivery; SDK `osClient.setup.config()`):
 * the calling app instance's own installation's effective setup values,
 * secrets as D56 handles (read with `credentials.get`). Core
 * `SetupServiceContract.selfConfig` answers; this file only identifies the
 * caller and transports the answer.
 *
 *   - only an app's own server with its verified instance token (never a
 *     page, never an OS sidecar: a sidecar gets its values as env references
 *     at spawn, setup/values.ts);
 *   - the instance, app and user come from the verified principal only, so
 *     an app never reads another installation's or another user's values;
 *   - 503 D105 `unavailable` while this build has no setup engine (P3 wires
 *     it), never a made-up or empty configuration.
 *
 * The engine comes from the one shared accessor (`lib/setup/service.ts`
 * `liveSetupService()`), null until the engine is wired (P3).
 */
import type { SetupConfigView, SetupErrorBody, SetupServiceContract } from '@aura/core';
import type { ResolvedPrincipal } from './access/identify.ts';
import { liveSetupService } from './setup/service.ts';

export interface SetupSelfDeps {
  resolve(request: Request): Promise<ResolvedPrincipal>;
  /** The setup engine, or null while this build has none. */
  service(): Pick<SetupServiceContract, 'selfConfig'> | null;
}

export function liveSetupSelfDeps(): SetupSelfDeps {
  return {
    resolve: async (request) => (await import('./auth.ts')).resolveCaller(request),
    service: () => liveSetupService(),
  };
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** The body while there is no engine (the same D105 shape as the other setup routes). */
export const SETUP_SELF_UNAVAILABLE = Object.freeze({
  error: 'unavailable',
  category: 'unavailable',
  message: 'the app setup engine is not available on this AuraOS',
  hint: 'update AuraOS to a release with app setup (D108)',
});

/** The HTTP status of a setup refusal (D105 category). */
function statusOf(body: SetupErrorBody): number {
  switch (body.category) {
    case 'invalid-request': return 400;
    case 'missing-permission': return 403;
    default: return 409;
  }
}

function isSetupErrorBody(v: unknown): v is SetupErrorBody {
  return !!v && typeof v === 'object' && typeof (v as SetupErrorBody).error === 'string' && typeof (v as SetupErrorBody).category === 'string';
}

export async function readSetupSelf(request: Request, deps: SetupSelfDeps): Promise<Response> {
  const r = await deps.resolve(request);
  if (r.rejected) return json({ error: 'invalid-credential' }, 401);
  const p = r.principal;
  if (p.kind !== 'instance' || r.via !== 'instance-token') {
    return json({ error: 'server-only', message: 'An app reads its setup values on its own server, with its instance token.' }, p.kind === 'anonymous' ? 401 : 403);
  }
  if (p.sidecar) {
    return json({ error: 'server-only', message: 'An OS sidecar gets its setup values through its template env references, not this route.' }, 403);
  }
  const service = deps.service();
  if (!service) return json(SETUP_SELF_UNAVAILABLE, 503);
  let view: SetupConfigView;
  try {
    view = await service.selfConfig({ appId: p.appId, instanceId: p.instanceId, ...(p.userId ? { userId: p.userId } : {}) });
  } catch (err) {
    const body = (err as { body?: unknown }).body;
    if (isSetupErrorBody(body)) return json(body, statusOf(body));
    return json({ error: 'internal', message: 'the setup values could not be read' }, 500);
  }
  // Defence in depth: the engine answers for the caller's own app only.
  if (view.appId !== p.appId) return json({ error: 'internal', message: 'the setup values could not be read' }, 500);
  return json(view);
}
