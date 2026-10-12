import { getAppManager } from '@aura/core';
import { errorResponse } from './appResponse.js';

/**
 * Caller identity for the token-gated routes (OS-managed sidecars).
 *
 * Every other `/api/instances/:id/*` route trusts the id in the URL. These
 * can start containers on an app's behalf, so the caller must prove it IS
 * that instance (or one of its OS sidecars) with the bearer the OS injected
 * at spawn: `Authorization: Bearer $AURA_INSTANCE_TOKEN`. See core's
 * InstanceTokens.
 */

type AppManager = ReturnType<typeof getAppManager>;
type Instance = NonNullable<ReturnType<AppManager['getInstance']>>;

export interface SidecarCaller {
  instanceId: string;
  /** Set when an OS sidecar is calling with its own token. */
  sidecar?: string;
}

export interface Gate {
  mgr: AppManager;
  instance: Instance;
  caller: SidecarCaller;
}

/** Resolve + authenticate a caller, or a ready error Response. */
export function requireInstanceToken(request: Request, instanceId: string, mgr: AppManager): SidecarCaller | Response {
  const header = request.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!token) {
    return errorResponse('missing bearer token — send Authorization: Bearer $AURA_INSTANCE_TOKEN (the OS injects it into every app container)', 401);
  }
  const claims = mgr.tokens.verify(token);
  if (!claims) {
    const hint = mgr.tokens.hasNonce(instanceId)
      ? 'invalid or expired token'
      : `invalid token — ${instanceId} has no current token (started before instance tokens existed? restart it)`;
    return errorResponse(hint, 401);
  }
  if (claims.instanceId !== instanceId) {
    return errorResponse(`token belongs to ${claims.instanceId}${claims.sidecar ? `/${claims.sidecar}` : ''}, not ${instanceId}`, 403);
  }
  return claims;
}

/**
 * The shared prelude of every sidecar route: instance exists → token →
 * permission(s) of the instance's app → container sandbox.
 */
export function sidecarGate(
  params: Record<string, string | undefined>,
  request: Request,
  permissions: string[],
): Gate | Response {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);

  const caller = requireInstanceToken(request, instanceId, mgr);
  if (caller instanceof Response) return caller;

  // The app id comes from the instance record, never from the request.
  for (const p of permissions) {
    if (!mgr.permissions.hasPermission(instance.appId, p)) {
      return errorResponse(`${instance.appId} is not granted '${p}'. Add it to the app's manifest permissions[].`, 403);
    }
  }
  if (instance.sandbox && instance.sandbox !== 'container') {
    return errorResponse(`${instanceId} runs in a '${instance.sandbox}' sandbox; OS sidecars need sandbox: container`, 409);
  }
  return { mgr, instance, caller };
}

/** Map a SidecarManager / MountManager failure to a status. */
export function sidecarError(err: unknown): Response {
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof status === 'number') return errorResponse(message, status);
  if (/no OS sidecar|not mounted|not found/i.test(message)) return errorResponse(message, 404);
  if (/already mounted|unavailable|refusing|inherited from|no mount root/i.test(message)) return errorResponse(message, 409);
  return errorResponse(message, 500);
}

/** Parse a JSON body or return a 400 Response. */
export async function jsonBody<T>(request: Request): Promise<T | Response> {
  try { return (await request.json()) as T; }
  catch { return errorResponse('Body must be JSON', 400); }
}
