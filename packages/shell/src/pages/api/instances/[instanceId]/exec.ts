import type { APIRoute } from 'astro';
import { execAudit, getAppManager, getAuthServices, type AuditInput, type RunRequest } from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import { execCaller, execError, jsonBody } from '../../../../lib/instanceAuth.js';

/**
 * Run one command in an instance's environment: the non-TTY `aura exec`
 * through the shell (Phase 5 stream X, core ExecBridge). The interactive
 * form is the `exec-bridge` WebSocket (`/api/instances/:id/session`).
 *
 *   POST {cmd: string[], user?, workdir?, env?, stdin? (≤ 64 KiB), timeoutMs? (≤ 10 min), sidecar?}
 *        → { exitCode, stdout, stderr, truncated, timedOut }
 *
 * The sidecar exec contract (`sidecars/[name]/exec.ts`): argv only, no shell,
 * output capped at 4 MiB per stream. 5-pre2 runs it in the app container as
 * root. Who: the owner, or the instance itself (routeManifest, every mode);
 * `sidecar` is the owner's only. Audited as `instance.exec` (argv[0] only).
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);
  const caller = execCaller(locals, instanceId, mgr);
  if (caller instanceof Response) return caller;
  const body = await jsonBody<RunRequest & { sidecar?: unknown }>(request);
  if (body instanceof Response) return body;
  if (body.sidecar !== undefined && (typeof body.sidecar !== 'string' || caller.level !== 'owner')) {
    return errorResponse('sidecar: the owner only (an app uses its sidecar exec route)', 403);
  }
  const sidecar = body.sidecar as string | undefined;
  const target = { appId: instance.appId, instanceId };
  const argv0 = Array.isArray(body.cmd) && typeof body.cmd[0] === 'string' ? body.cmd[0].slice(0, 128) : null;
  try {
    const r = await mgr.execBridge.run(instanceId, body, sidecar ? { sidecar } : {});
    await audit(execAudit(caller.principal, 'instance.exec', target, { argv0, exitCode: r.exitCode, timedOut: r.timedOut, ...(sidecar ? { sidecar } : {}) }));
    return jsonResponse(r);
  } catch (err) {
    await audit(execAudit(caller.principal, 'instance.exec', target, { argv0, error: (err as Error).message, ...(sidecar ? { sidecar } : {}) }, 'failed'));
    return execError(err);
  }
};

async function audit(entry: AuditInput): Promise<void> {
  try { await getAuthServices().audit.record(entry); } catch { /* the audit store is down: the call still answers */ }
}
