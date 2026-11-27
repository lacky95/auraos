import { getAppManager, type AccessPrincipal, type ExecBridgeError } from '@aura/core';
import * as core from '@aura/core';
import { capabilityRefusal, refusalResponse } from './runtimeCaps.ts';
import { errorResponse, jsonResponse, redactInternal } from './appResponse.js';
import type { AuraErrorBody } from '@aura/core';
import { isOwnerPrincipal, isTrustedOwnerAgent } from './access/identify.ts';

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
  // OS sidecars need the runtime's `sidecars` capability (5b G), whatever the runtime is called.
  const refused = capabilityRefusal(instanceId, core.requestNeeds('sidecars'), 'OS sidecars', mgr);
  if (refused) return refused;
  return { mgr, instance, caller: { instanceId, ...(p.sidecar ? { sidecar: p.sidecar } : {}) } };
}

/**
 * Map a SidecarManager / MountManager failure to a status. A runtime refusal
 * (D107 isolation, a capability) is the 409 D105 body (`refusalResponse`); a
 * failure that names a code (e.g. `image_auth`) answers the one error body,
 * `error` the code and `message` the sentence (D105; the SDK reads `error`).
 */
export function sidecarError(err: unknown): Response {
  const refused = refusalResponse(err);
  if (refused) return refused;
  const { status, code, body } = (err ?? {}) as { status?: unknown; code?: unknown; body?: AuraErrorBody };
  const message = err instanceof Error ? err.message : String(err);
  // A refusal that carries its D105 body (e.g. B12 sidecar-identity-conflict) answers it as is.
  if (typeof status === 'number' && body && typeof body.error === 'string' && typeof body.message === 'string') return errorResponse(status, grantableHint(body));
  if (typeof status === 'number') {
    return typeof code === 'string' && /^[a-z_]{1,32}$/.test(code)
      ? errorResponse(status, { error: code, message }) : errorResponse(message, status);
  }
  // Anything else is the runtime's own text (docker stderr): the app reads it without host paths (review §4.4 rule 5).
  const safe = redactInternal(message);
  if (/no OS sidecar|not mounted|not found/i.test(message)) return errorResponse(safe, 404);
  if (/already mounted|unavailable|refusing|inherited from|no mount root/i.test(message)) return errorResponse(safe, 409);
  return errorResponse(safe, 500);
}

/**
 * A system app's permissions ship with AuraOS: `aura grant perms` refuses
 * them, so its missing permission is named without a grant command (review
 * §4.4 rule 2, as the access layer's refusals).
 */
function grantableHint(body: AuraErrorBody): AuraErrorBody {
  if (!body.permission || body.holder !== 'caller' || !body.target) return body;
  let scope: string | undefined;
  try { scope = getAppManager().registry.getScopeId(body.target); } catch { scope = undefined; }
  if (scope !== 'system') return body;
  const { hint: _hint, ...rest } = body;
  return { ...rest, category: 'not-grantable', message: `${body.message} (a system app: its permissions ship with AuraOS)` };
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
  mgr: Pick<AppManager, 'isTrustedSystemCopy' | 'getInstance'>,
): ExecCaller | Response {
  const v = locals?.access;
  const p = v?.principal;
  if (!p || p.kind === 'anonymous') return errorResponse('authentication required', 401);
  if (isOwnerPrincipal(p)) return { principal: p, level: 'owner' };
  if (p.kind === 'instance' && v?.via === 'instance-token') {
    if (isTrustedOwnerAgent(p, mgr)) return { principal: p, level: 'owner' };
    if (p.instanceId === instanceId && !p.sidecar) return { principal: p, level: 'self' };
  }
  return errorResponse('only the owner or the instance itself', 403);
}

/** An ExecBridge failure as a response. */
export function execError(err: unknown): Response {
  // By name, not instanceof: under `astro dev` core can load twice (SSR and Node's loader).
  const e = err as Partial<ExecBridgeError> | null;
  // The one error body (D105): `error` is the code, `message` the sentence, `category` what a client may do.
  if (e?.name === 'ExecBridgeError' && typeof e.status === 'number') {
    return errorResponse(e.status, { error: e.code ?? 'error', message: e.message ?? '', ...(e.category ? { category: e.category } : {}) });
  }
  return errorResponse(err instanceof Error ? err.message : String(err), 500);
}
