import type { APIRoute } from 'astro';
import { DEFAULT_OWNER_ID, execAudit, getAppManager, getAuthServices, sessionCallerOf, type AuditInput, type JumpHomeMode, type RunRequest } from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import { execCaller, execError, jsonBody } from '../../../../lib/instanceAuth.js';

/**
 * Run one command in an instance's environment: the non-TTY `aura exec`
 * through the shell (Phase 5 stream X, core ExecBridge). The interactive
 * form is the `exec-bridge` WebSocket (`/api/instances/:id/session`).
 *
 *   POST {cmd: string[], home?: private|app|ephemeral, workdir?, env?, stdin? (≤ 64 KiB),
 *         timeoutMs? (≤ 10 min), sidecar?, user? (sidecar only)}
 *        → { exitCode, stdout, stderr, truncated, timedOut }
 *
 * The sidecar exec contract (`sidecars/[name]/exec.ts`): argv only, no shell,
 * output capped at 4 MiB per stream. Into the instance it is a non-interactive
 * jump (stream J, D74): the same session, identity and home rules as
 * `aura jump` (default `--home private` for a user, `app` for the instance
 * itself). Who: the owner or the instance itself (routeManifest, every
 * mode; a member jumps through the session WebSocket); `sidecar` is the
 * owner's only. Audited as `instance.exec` (argv[0] only).
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);
  const caller = execCaller(locals, instanceId, mgr);
  if (caller instanceof Response) return caller;
  const body = await jsonBody<RunRequest & { sidecar?: unknown; home?: unknown }>(request);
  if (body instanceof Response) return body;
  if (body.sidecar !== undefined && (typeof body.sidecar !== 'string' || caller.level !== 'owner')) {
    return errorResponse('sidecar: the owner only (an app uses its sidecar exec route)', 403);
  }
  const sidecar = body.sidecar as string | undefined;
  if (body.home !== undefined && (sidecar || !['private', 'app', 'ephemeral'].includes(body.home as string))) {
    return errorResponse('home: private, app or ephemeral, and never for a sidecar', 400);
  }
  const home = body.home as JumpHomeMode | undefined;
  const target = { appId: instance.appId, instanceId };
  const argv0 = Array.isArray(body.cmd) && typeof body.cmd[0] === 'string' ? body.cmd[0].slice(0, 128) : null;
  try {
    const run = sidecar ? { sidecar } : { caller: sessionCallerOf(caller.principal, caller.level, DEFAULT_OWNER_ID), ...(home ? { home } : {}) };
    const r = await mgr.execBridge.run(instanceId, body, run);
    await audit(execAudit(caller.principal, 'instance.exec', target, { argv0, exitCode: r.exitCode, timedOut: r.timedOut, ...(home ? { home } : {}), ...(sidecar ? { sidecar } : {}) }));
    return jsonResponse(r);
  } catch (err) {
    await audit(execAudit(caller.principal, 'instance.exec', target, { argv0, error: (err as Error).message, ...(home ? { home } : {}), ...(sidecar ? { sidecar } : {}) }, 'failed'));
    return execError(err);
  }
};

async function audit(entry: AuditInput): Promise<void> {
  try { await getAuthServices().audit.record(entry); } catch { /* the audit store is down: the call still answers */ }
}
