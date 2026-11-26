import type { APIRoute } from 'astro';
import { execAudit, getAppManager, getAuthServices, parseSince, parseTail, type LogsRequest } from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import { execCaller, execError } from '../../../../lib/instanceAuth.js';
import { followSession, streamSessionOf } from '../../../../lib/streamSession.ts';

/**
 * An instance's own output: `aura logs` through the shell (Phase 5 stream X,
 * core ExecBridge). The engine's log for a container, the runner's output
 * ring for PRoot.
 *
 *   GET ?tail=200&since=10m&timestamps=1&sidecar=<name>
 *       → { stdout, stderr }               (capped at 4 MiB each)
 *   GET …&follow=1
 *       → text/event-stream: `event: out|err`, `data: "<JSON string>"`, until
 *         the instance's output ends or the caller goes away (or its sign-in)
 *
 * Who: the owner, or the instance itself (routeManifest, every mode);
 * `sidecar` is the owner's only. Audited as `instance.logs`.
 */
const CAP = 4 * 1024 * 1024;

export const GET: APIRoute = async ({ params, url, request, locals }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);
  const caller = execCaller(locals, instanceId, mgr);
  if (caller instanceof Response) return caller;
  const sidecar = url.searchParams.get('sidecar') || undefined;
  if (sidecar && caller.level !== 'owner') return errorResponse('sidecar: the owner only (an app uses its sidecar logs route)', 403);
  const follow = url.searchParams.get('follow') === '1';
  let req: LogsRequest;
  try {
    const tail = parseTail(url.searchParams.get('tail'));
    const since = parseSince(url.searchParams.get('since'));
    req = {
      ...(tail !== undefined ? { tail } : {}), ...(since !== undefined ? { since } : {}),
      timestamps: url.searchParams.get('timestamps') === '1', follow, ...(sidecar ? { sidecar } : {}),
    };
  } catch (err) {
    return execError(err);
  }
  try { await getAuthServices().audit.record(execAudit(caller.principal, 'instance.logs', { appId: instance.appId, instanceId }, { follow, ...(sidecar ? { sidecar } : {}) })); }
  catch { /* the audit store is down: the call still answers */ }

  if (!follow) {
    const out = { out: [] as Buffer[], err: [] as Buffer[] };
    const size = { out: 0, err: 0 };
    try {
      const s = await mgr.execBridge.logs(instanceId, req, (stream, data) => {
        if (size[stream] >= CAP) return;
        out[stream].push(data);
        size[stream] += data.length;
      });
      await s.done;
    } catch (err) {
      return execError(err);
    }
    return jsonResponse({
      stdout: Buffer.concat(out.out).subarray(0, CAP).toString('utf-8'),
      stderr: Buffer.concat(out.err).subarray(0, CAP).toString('utf-8'),
    });
  }

  // Opened before the response, so a refusal still answers with its status.
  const encoder = new TextEncoder();
  const pending: string[] = [];
  let push = (text: string) => { pending.push(text); };
  let logs: Awaited<ReturnType<typeof mgr.execBridge.logs>>;
  try {
    logs = await mgr.execBridge.logs(instanceId, req, (stream, data) => {
      push(`event: ${stream}\ndata: ${JSON.stringify(data.toString('utf-8'))}\n\n`);
    });
  } catch (err) {
    return execError(err);
  }
  const session = streamSessionOf(request, caller.principal);
  let cleanup = () => { logs.close(); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => { if (!closed) { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } } };
      const end = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      };
      send(': ok\n\n');
      for (const text of pending.splice(0)) send(text);
      push = send;
      const following = session ? followSession(session, end) : null;
      const heartbeat = setInterval(() => { following?.recheck(); send(': hb\n\n'); }, 10_000);
      cleanup = () => { following?.stop(); clearInterval(heartbeat); logs.close(); request.signal.removeEventListener('abort', end); };
      request.signal.addEventListener('abort', end);
      void logs.done.then(end);
    },
    cancel() { cleanup(); },
  });
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
};
