import { ExecBridgeError, getAppManager, type AccessPrincipal } from '@aura/core';
import { errorResponse, jsonResponse } from './appResponse.js';
import { isTrustedOwnerAgent } from './access/identify.ts';

/**
 * The OS-managed sidecar routes' target and caller.
 *
 * Who may call them is the route access manifest's (routeManifest.ts,
 * `sidecar`): only the instance itself, or one of its OS sidecars, by the
 * bearer the OS injected at spawn (`Authorization: Bearer
 * $AURA_INSTANCE_TOKEN`, core's InstanceTokens), with the permissions its
 * app declares. The middleware applies that in every access mode, so a route
 * here only reads the caller it verified (`locals.access`).
 */

type AppManager = ReturnType<typeof getAppManager>;
type Instance = NonNullable<ReturnType<AppManager['getInstance']>>;

export interface SidecarCaller {
  instanceId: string;
  /** Set when an OS sidecar is calling with its own token. */
  sidecar?: string;
}

export interface SidecarTarget {
  mgr: AppManager;
  instance: Instance;
  caller: SidecarCaller;
}

/**
 * The shared prelude of every sidecar route: the instance exists, its caller
 * is the one the middleware verified, and it runs in a container sandbox.
 */
export function sidecarTarget(
  params: Record<string, string | undefined>,
  locals: App.Locals | undefined,
): SidecarTarget | Response {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);

  const p = locals?.access?.principal;
  if (p?.kind !== 'instance' || p.instanceId !== instanceId) {
    return errorResponse('send Authorization: Bearer $AURA_INSTANCE_TOKEN (the OS injects it into every app container)', 401);
  }
  if (instance.sandbox && instance.sandbox !== 'container') {
    return errorResponse(`${instanceId} runs in a '${instance.sandbox}' sandbox; OS sidecars need sandbox: container`, 409);
  }
  return { mgr, instance, caller: { instanceId, ...(p.sidecar ? { sidecar: p.sidecar } : {}) } };
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

/**
 * The caller of an exec bridge route (Phase 5 stream X: `exec`, `logs`). The
 * middleware already applied the rule in every mode (`guard: 'rule'`); this
 * names which level let the caller in, as the bridge's surface decision does:
 *   owner   the owner's login, the host operator, or a trusted owner agent by
 *           its own token (D29: the System Terminal)
 *   self    the instance itself by its own token (never one of its sidecars:
 *           a foreign image does not get root in the app's container)
 */
export interface ExecCaller {
  principal: AccessPrincipal;
  level: 'owner' | 'self';
}

export function execCaller(
  locals: App.Locals | undefined,
  instanceId: string,
  mgr: Pick<AppManager, 'isTrustedSystemCopy'>,
): ExecCaller | Response {
  const v = locals?.access;
  const p = v?.principal;
  if (!p || p.kind === 'anonymous') return errorResponse('authentication required', 401);
  if (p.kind === 'operator' || (p.kind === 'user' && p.role === 'owner')) return { principal: p, level: 'owner' };
  if (p.kind === 'instance' && v?.via === 'instance-token') {
    if (isTrustedOwnerAgent(p, mgr)) return { principal: p, level: 'owner' };
    if (p.instanceId === instanceId && !p.sidecar) return { principal: p, level: 'self' };
  }
  return errorResponse('only the owner or the instance itself', 403);
}

/** An ExecBridge failure as a response. */
export function execError(err: unknown): Response {
  if (err instanceof ExecBridgeError) return jsonResponse({ error: err.message, code: err.code }, err.status);
  return errorResponse(err instanceof Error ? err.message : String(err), 500);
}
