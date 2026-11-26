/**
 * The exec bridge: `WS /api/instances/:id/session`, subprotocol
 * `aura.exec.v1` (Phase 5 stream X): `aura jump` and `aura exec` through the
 * shell instead of a Docker socket in the caller. Surface `exec-bridge` in
 * src/lib/access/surfaceManifest.ts; the work is core's ExecBridge.
 *
 * Protocol:
 *   client → {op:'open', kind:'jump'|'exec', argv?, tty, cols, rows, cwd?,
 *             env:{TERM,COLORTERM,LANG,LC_ALL}, home?:'private'|'app'|'ephemeral',
 *             sidecar?, root?:<grant>}                       first frame, text
 *   client → binary [0, …stdin bytes]
 *   client → {op:'resize', cols, rows} | {op:'signal', sig} | {op:'eof'}
 *   server → {op:'opened'} once the process runs (before it, a client may fall back)
 *   server → binary [1|2, …stdout|stderr bytes]   (a TTY has only 1)
 *   server → {op:'exit', code}  then a normal close; {op:'error', code, message} then close
 * A session enters the running app environment (stream J, D74) with the
 * caller's home mode: private (default for a user), ephemeral, or app (the
 * app identity, D79; the only mode for the instance itself). The kernel
 * decides identity and home (core ExecBridge / AppManager sessionContext);
 * a runtime or instance that can't do it securely is refused
 * (`capability-missing`), never downgraded.
 *
 * Who: the surface rule, decided at the upgrade in EVERY access mode: the
 * owner, or the instance itself by its own token (never one of its
 * sidecars), or a member's own login (D82; the kernel then requires its
 * `app.jump:<installationId>` grant before anything runs). A sidecar target
 * is the owner's only. The user is the verified principal's, never a header.
 * Audit: `session.opened` / `session.closed` (user, instance, mode, home,
 * duration). A revoked sign-in ends the session (M4).
 *
 * A root tab (`aura root`, J.6): `root` carries the single-use grant the
 * owner's approved `POST /api/admin/root` issued for this user and instance;
 * it is consumed here (owner level only) before anything runs, and the
 * session's end is audited `root.ended`.
 */
import { WebSocketServer } from 'ws';
import { followIdentity, reportSurface, requestIdentity, surfaceDecision } from './access-bridge.mjs';

/** `/api/instances/<id>/session`, query allowed. */
export const EXEC_BRIDGE_PATH = /^\/api\/instances\/([^/?]+)\/session(?:\?.*)?$/;
export const EXEC_SUBPROTOCOL = 'aura.exec.v1';
const SUBJECT = 'exec-bridge';
const OPEN_TIMEOUT_MS = 10_000;
const PING_MS = 25_000;
const INSTANCE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const core = () => import('@aura/core');

/** The running shell's side of the bridge. Tests pass their own. */
export const liveExecDeps = {
  decide: (observation) => surfaceDecision(observation),
  bridge: async () => (await core()).getAppManager().execBridge,
  appOf: async (instanceId) => (await core()).getAppManager().getInstance(instanceId)?.appId ?? null,
  parseOpen: async (frame) => (await core()).parseSessionOpen(frame),
  callerOf: async (principal, level) => { const c = await core(); return c.sessionCallerOf(principal, level, c.DEFAULT_OWNER_ID); },
  consumeRoot: async (grant, userId, instanceId) => (await core()).getAppManager().rootGrants.consume(grant, userId, instanceId),
  audit: async (principal, action, target, detail, outcome) => {
    const c = await core();
    await c.getAuthServices().audit.record(c.execAudit(principal, action, target, detail, outcome));
  },
  report: (observation) => reportSurface(observation),
  follow: (identity, end) => followIdentity(identity, end),
};

function refuse(socket, status, text) {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
}

export function attachExecBridge(httpServer, deps = liveExecDeps) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => (offered.has(EXEC_SUBPROTOCOL) ? EXEC_SUBPROTOCOL : false),
  });
  httpServer.on('upgrade', (req, socket, head) => {
    const m = EXEC_BRIDGE_PATH.exec(req.url ?? '');
    if (!m) return;
    void upgrade(req, socket, head, m[1], wss, deps).catch((err) => {
      // Never silent: a failed upgrade is otherwise only a closed socket at the caller.
      console.warn('[exec-bridge] upgrade failed:', err instanceof Error ? err.message : String(err));
      try { socket.destroy(); } catch { /* gone */ }
    });
  });
  return wss;
}

async function upgrade(req, socket, head, rawId, wss, deps) {
  let instanceId = null;
  try { instanceId = decodeURIComponent(rawId); } catch { /* bad escape */ }
  const identity = requestIdentity(req);
  const report = (status, appId = null) => deps.report({ subject: SUBJECT, method: 'UPGRADE', appId, status, identity });
  if (!instanceId || !INSTANCE_ID.test(instanceId)) { report(400); return refuse(socket, 400, 'Bad Request'); }
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
  if (!offered.includes(EXEC_SUBPROTOCOL)) { report(400); return refuse(socket, 400, 'Bad Request'); }

  // An unknown instance is refused like a forbidden one: no existence oracle.
  const decision = await deps.decide({ subject: SUBJECT, method: 'UPGRADE', instanceId, identity });
  const appId = await deps.appOf(instanceId).catch(() => null);
  const verified = await Promise.resolve(identity?.verified ?? null).catch(() => null);
  const principal = verified?.principal ?? null;
  // The instance itself, but never through one of its sidecars' tokens.
  const ruled = appId !== null && decision?.outcome === 'allow'
    && (decision.reason === 'owner' || (decision.reason === 'own-instance' && principal?.kind === 'instance' && !principal.sidecar));
  // D82: a member's own login reaches the kernel, which requires its app.jump grant (core sessionContext).
  const member = !ruled && appId !== null && principal?.kind === 'user' && principal.role === 'member'
    && principal.verification === 'verified';
  const allowed = ruled || member;
  if (!allowed) {
    report(principal && principal.kind !== 'anonymous' ? 403 : 401, appId);
    return refuse(socket, principal && principal.kind !== 'anonymous' ? 403 : 401, principal && principal.kind !== 'anonymous' ? 'Forbidden' : 'Unauthorized');
  }
  const owner = ruled && decision.reason === 'owner';
  const level = owner ? 'owner' : member ? 'member' : 'self';

  wss.handleUpgrade(req, socket, head, (ws) => {
    report(101, appId);
    serve(ws, { instanceId, appId, principal, owner, level, identity }, deps);
  });
}

function serve(ws, ctx, deps) {
  const target = { appId: ctx.appId, instanceId: ctx.instanceId };
  let session = null;
  let opened = null;      // { at, kind, tty, home, sidecar, root }
  let finished = false;
  const sendJson = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const fail = (code, message, wsCode = 4000) => {
    sendJson({ op: 'error', code, message });
    try { ws.close(wsCode, code.slice(0, 120)); } catch { /* gone */ }
  };
  const finish = (exitCode) => {
    if (finished || !opened) return;
    finished = true;
    if (opened.root) void deps.audit(ctx.principal, 'root.ended', target, { durationMs: Date.now() - opened.at, exitCode }).catch(() => undefined);
    void deps.audit(ctx.principal, 'session.closed', target, {
      mode: opened.kind, tty: opened.tty, durationMs: Date.now() - opened.at, exitCode,
      ...(opened.home ? { home: opened.home } : {}),
      ...(opened.sidecar ? { sidecar: opened.sidecar } : {}),
    }).catch(() => undefined);
  };

  const openTimer = setTimeout(() => fail('bad-request', 'no open frame'), OPEN_TIMEOUT_MS);
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const hb = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch { /* gone */ } return; }
    alive = false;
    try { ws.ping(); } catch { /* gone */ }
  }, PING_MS);
  hb.unref?.();
  // M4: a revoked sign-in ends the session.
  const unfollow = deps.follow(ctx.identity, () => { try { ws.terminate(); } catch { /* gone */ } });

  let opening = false;
  ws.on('message', (data, isBinary) => {
    if (!session) {
      if (opening) return;
      if (isBinary) return fail('bad-request', 'the first frame must be {op:"open", …}');
      opening = true;
      clearTimeout(openTimer);
      void open(String(data));
      return;
    }
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      if (buf.length > 1 && buf[0] === 0) session.input(buf.subarray(1));
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg?.op === 'resize') session.resize(Number(msg.cols), Number(msg.rows));
    else if (msg?.op === 'signal' && typeof msg.sig === 'string') session.signal(msg.sig);
    else if (msg?.op === 'eof') session.endInput();
  });

  async function open(text) {
    let frame;
    try { frame = JSON.parse(text); } catch { return fail('bad-request', 'the open frame is not JSON'); }
    let req;
    try { req = await deps.parseOpen(frame); } catch (err) { return fail(err?.code ?? 'bad-request', err?.message ?? String(err)); }
    if (req.sidecar && !ctx.owner) return fail('forbidden', 'a sidecar session is the owner\'s only');
    if (ws.readyState !== ws.OPEN) return;
    const home = req.sidecar ? null : req.home ?? (ctx.level === 'self' ? 'app' : 'private');
    const detail = { mode: req.kind, tty: req.tty, ...(home ? { home } : {}), ...(req.sidecar ? { sidecar: req.sidecar } : {}), ...(req.root ? { root: true } : {}) };
    try {
      const bridge = await deps.bridge();
      const caller = await deps.callerOf(ctx.principal, ctx.level);
      if (req.root) {
        // J.6: the owner's own grant for exactly this instance, used once.
        if (!ctx.owner || !caller.user || !(await deps.consumeRoot(req.root, caller.user.userId, ctx.instanceId))) {
          throw Object.assign(new Error('no valid root grant for this Terminal: run `aura root` again'), { code: 'forbidden' });
        }
        caller.root = true;
      }
      session = await bridge.openSession(ctx.instanceId, req, (channel, chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([channel]), chunk]), { binary: true });
      }, caller);
    } catch (err) {
      void deps.audit(ctx.principal, 'session.opened', target, { ...detail, error: err?.message }, 'failed').catch(() => undefined);
      return fail(err?.code ?? 'internal', err?.message ?? String(err));
    }
    opened = { at: Date.now(), kind: req.kind, tty: req.tty, home, sidecar: req.sidecar, root: !!req.root };
    void deps.audit(ctx.principal, 'session.opened', target, detail).catch(() => undefined);
    if (ws.readyState !== ws.OPEN) { session.close(); return; }
    sendJson({ op: 'opened' });
    void session.exited.then((code) => {
      finish(code);
      sendJson({ op: 'exit', code });
      try { ws.close(1000, 'exit'); } catch { /* gone */ }
    });
  }

  ws.on('close', () => {
    clearTimeout(openTimer);
    clearInterval(hb);
    unfollow();
    if (session) {
      session.close();
      void session.exited.then((code) => finish(code), () => finish(null));
    }
  });
}
