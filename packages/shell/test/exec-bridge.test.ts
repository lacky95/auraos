// Phase 5 stream X: the exec bridge's WebSocket (server/exec-bridge.mjs) on a
// real HTTP server, with the decision, the core bridge and the audit faked:
// refused callers get no session, the owner gets a TTY round trip with
// resize, signal, EOF and the exit code, the instance itself gets its own,
// its sidecars' tokens and sidecar targets are the owner's only, and home
// modes are refused (J). The real decision is in access-enforce.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseSessionOpen } from '@aura/core';
import { attachExecBridge, EXEC_SUBPROTOCOL } from '../server/exec-bridge.mjs';
import { execCaller } from '../src/lib/instanceAuth.ts';

type Principal = Record<string, unknown> & { kind: string };
const owner: Principal = { kind: 'user', userId: 'u1', role: 'owner', sessionId: 's1', verification: 'verified' };
const self: Principal = { kind: 'instance', appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', userId: 'u1', verification: 'verified' };

interface Rig {
  url: string;
  audits: Array<{ action: string; detail: Record<string, unknown>; outcome?: string }>;
  opened: Array<{ instanceId: string; req: Record<string, unknown> }>;
  session: { inputs: string[]; resizes: number[][]; signals: string[]; eof: boolean; closed: boolean };
}

async function rig(t: { after(fn: () => void): void }, who: { principal: Principal; reason: string | null }): Promise<Rig> {
  const audits: Rig['audits'] = [];
  const opened: Rig['opened'] = [];
  const session = { inputs: [] as string[], resizes: [] as number[][], signals: [] as string[], eof: false, closed: false };
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  attachExecBridge(server, {
    decide: async (o: { instanceId: string }) => (who.reason && o.instanceId !== 'no-such-1'
      ? { outcome: 'allow', reason: who.reason } : { outcome: 'deny', reason: 'wrong-principal' }),
    appOf: async (id: string) => (id === 'no-such-1' ? null : 'com.acme.notes'),
    parseOpen: async (frame: unknown) => parseSessionOpen(frame),
    bridge: async () => ({
      openSession: async (instanceId: string, req: Record<string, unknown>, onOutput: (ch: number, d: Buffer) => void) => {
        opened.push({ instanceId, req });
        let exit!: (code: number | null) => void;
        const exited = new Promise<number | null>((r) => { exit = r; });
        onOutput(1, Buffer.from('ready\n'));
        if (!req['tty']) onOutput(2, Buffer.from('err\n'));
        return {
          input: (d: Buffer) => { session.inputs.push(d.toString()); onOutput(1, d); if (d.toString().includes('exit')) exit(7); },
          endInput: () => { session.eof = true; exit(0); },
          resize: (c: number, r: number) => { session.resizes.push([c, r]); },
          signal: (s: string) => { session.signals.push(s); return true; },
          close: () => { session.closed = true; exit(null); },
          exited,
        };
      },
    }) as never,
    audit: async (_p: unknown, action: string, _t: unknown, detail: Record<string, unknown>, outcome?: string) => { audits.push({ action, detail, ...(outcome ? { outcome } : {}) }); },
    report: () => {},
    follow: () => () => {},
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as AddressInfo;
  // requestIdentity runs the real resolver, which isn't loaded in a test: hand it the verdict.
  const g = globalThis as unknown as Record<symbol, unknown>;
  const BRIDGE = Symbol.for('aura.access');
  const prev = g[BRIDGE];
  g[BRIDGE] = { identify: async () => ({ principal: who.principal, via: 'login-session' }) };
  const prevMode = process.env['AURA_ACCESS_ENFORCE'];
  process.env['AURA_ACCESS_ENFORCE'] = 'report';
  t.after(() => {
    if (prev === undefined) delete g[BRIDGE]; else g[BRIDGE] = prev;
    if (prevMode === undefined) delete process.env['AURA_ACCESS_ENFORCE']; else process.env['AURA_ACCESS_ENFORCE'] = prevMode;
  });
  return { url: `ws://127.0.0.1:${port}`, audits, opened, session };
}

/** Open a session; resolve with what came back once the socket closed. */
function connect(url: string, path: string, frames: Array<string | Uint8Array>, opts: { protocol?: string | null; then?: Array<string | Uint8Array> } = {}) {
  return new Promise<{ status: 'closed' | 'refused'; out: string; err: string; control: Array<Record<string, unknown>> }>((resolve) => {
    const ws = new WebSocket(`${url}${path}`, opts.protocol === null ? [] : [opts.protocol ?? EXEC_SUBPROTOCOL]);
    ws.binaryType = 'arraybuffer';
    let out = '';
    let err = '';
    const control: Array<Record<string, unknown>> = [];
    let opened = false;
    ws.onopen = () => {
      opened = true;
      for (const f of frames) ws.send(f);
    };
    let sentThen = false;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') { control.push(JSON.parse(ev.data)); return; }
      const b = Buffer.from(ev.data as ArrayBuffer);
      if (b[0] === 1) out += b.subarray(1).toString(); else err += b.subarray(1).toString();
      if (!sentThen && opts.then) { sentThen = true; for (const f of opts.then) ws.send(f); }
    };
    // A refused handshake fires `error` without a `close` (Node's WebSocket).
    const done = () => resolve({ status: opened ? 'closed' : 'refused', out, err, control });
    ws.onclose = done;
    ws.onerror = done;
  });
}

const open = (extra: Record<string, unknown> = {}) => JSON.stringify({ op: 'open', kind: 'jump', tty: true, cols: 100, rows: 30, env: { TERM: 'xterm-256color' }, ...extra });
const stdin = (s: string) => Buffer.concat([Buffer.from([0]), Buffer.from(s)]);

test('refused: anonymous, another app, an unknown instance, no subprotocol; nothing opens', async (t) => {
  const anon = await rig(t, { principal: { kind: 'anonymous' }, reason: null });
  assert.equal((await connect(anon.url, '/api/instances/com.acme.notes-1/session', [open()])).status, 'refused');
  const other = await rig(t, { principal: { kind: 'instance', appId: 'com.other.app', instanceId: 'com.other.app-1', verification: 'verified' }, reason: null });
  assert.equal((await connect(other.url, '/api/instances/com.acme.notes-1/session', [open()])).status, 'refused');
  const own = await rig(t, { principal: owner, reason: 'owner' });
  assert.equal((await connect(own.url, '/api/instances/no-such-1/session', [open()])).status, 'refused');
  assert.equal((await connect(own.url, '/api/instances/com.acme.notes-1/session', [open()], { protocol: null })).status, 'refused');
  assert.equal((await connect(own.url, '/api/instances/%E0%A4%A/session', [open()])).status, 'refused');
  for (const r of [anon, other, own]) assert.equal(r.opened.length, 0);
});

test('a sidecar token of the instance is not the instance itself', async (t) => {
  const r = await rig(t, { principal: { ...self, sidecar: 'db' }, reason: 'own-instance' });
  assert.equal((await connect(r.url, '/api/instances/com.acme.notes-1/session', [open()])).status, 'refused');
  assert.equal(r.opened.length, 0);
});

test('owner: TTY round trip, resize, signal, exit code; audited with duration', async (t) => {
  const r = await rig(t, { principal: owner, reason: 'owner' });
  const res = await connect(r.url, '/api/instances/com.acme.notes-1/session', [open()], {
    then: [JSON.stringify({ op: 'resize', cols: 120, rows: 40 }), JSON.stringify({ op: 'signal', sig: 'INT' }), stdin('ls\r'), stdin('exit\r')],
  });
  assert.equal(res.status, 'closed');
  assert.equal(r.opened[0]!.instanceId, 'com.acme.notes-1');
  assert.equal(r.opened[0]!.req['tty'], true);
  assert.match(res.out, /^ready\nls\rexit\r$/);
  assert.deepEqual(res.control, [{ op: 'opened' }, { op: 'exit', code: 7 }]);
  assert.deepEqual(r.session.resizes, [[120, 40]]);
  assert.deepEqual(r.session.signals, ['INT']);
  assert.deepEqual(r.audits.map((a) => a.action), ['session.opened', 'session.closed']);
  assert.equal(r.audits[1]!.detail['exitCode'], 7);
  assert.equal(typeof r.audits[1]!.detail['durationMs'], 'number');
  assert.equal(r.audits[1]!.detail['mode'], 'jump');
});

test('the instance itself: non-TTY exec keeps stderr apart and ends on EOF', async (t) => {
  const r = await rig(t, { principal: self, reason: 'own-instance' });
  const res = await connect(r.url, '/api/instances/com.acme.notes-1/session', [open({ kind: 'exec', argv: ['cat'], tty: false })], {
    then: [stdin('abc'), JSON.stringify({ op: 'eof' })],
  });
  assert.equal(res.out, 'ready\nabc');
  assert.equal(res.err, 'err\n');
  assert.deepEqual(res.control, [{ op: 'opened' }, { op: 'exit', code: 0 }]);
  assert.equal(r.session.eof, true);
});

test('a sidecar session is the owner\'s only; home modes are J\'s; a bad open frame is refused', async (t) => {
  const r = await rig(t, { principal: self, reason: 'own-instance' });
  const sc = await connect(r.url, '/api/instances/com.acme.notes-1/session', [open({ sidecar: 'db' })]);
  assert.equal(sc.control[0]!['code'], 'forbidden');
  const home = await connect(r.url, '/api/instances/com.acme.notes-1/session', [open({ home: 'private' })]);
  assert.equal(home.control[0]!['code'], 'capability-missing');
  const junk = await connect(r.url, '/api/instances/com.acme.notes-1/session', ['not json']);
  assert.equal(junk.control[0]!['code'], 'bad-request');
  const binary = await connect(r.url, '/api/instances/com.acme.notes-1/session', [stdin('x')]);
  assert.equal(binary.control[0]!['code'], 'bad-request');
  assert.equal(r.opened.length, 0);
  const own = await rig(t, { principal: owner, reason: 'owner' });
  await connect(own.url, '/api/instances/com.acme.notes-1/session', [open({ sidecar: 'db', kind: 'exec', argv: ['psql'], tty: false })], { then: [JSON.stringify({ op: 'eof' })] });
  assert.equal(own.opened[0]!.req['sidecar'], 'db');
});

test('a client that goes away ends the session', async (t) => {
  const r = await rig(t, { principal: owner, reason: 'owner' });
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${r.url}/api/instances/com.acme.notes-1/session`, [EXEC_SUBPROTOCOL]);
    ws.onopen = () => ws.send(open());
    ws.onmessage = () => ws.close();
    ws.onclose = () => resolve();
    ws.onerror = () => resolve();
  });
  for (let i = 0; i < 50 && !r.session.closed; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.session.closed, true);
  assert.deepEqual(r.audits.map((a) => a.action), ['session.opened', 'session.closed']);
});

test('execCaller (exec and logs routes): owner levels, the instance itself, never its sidecar', () => {
  // D29 is owner-bound (stream I, C4): the Terminal instance must be the owner's.
  const mgr = {
    isTrustedSystemCopy: (id: string) => id === 'com.aura.terminal',
    getInstance: (id: string) => (id === 'com.aura.terminal-1' ? { instanceId: id, appId: 'com.aura.terminal', owner: 'default' } : undefined),
  };
  const locals = (principal: Principal, via = 'instance-token') => ({ access: { principal, via } }) as unknown as App.Locals;
  const level = (l: App.Locals) => { const c = execCaller(l, 'com.acme.notes-1', mgr as never); return c instanceof Response ? c.status : c.level; };
  assert.equal(level(locals(owner, 'login-session')), 'owner');
  assert.equal(level(locals({ kind: 'operator', verification: 'verified' }, 'operator-ticket')), 'owner');
  assert.equal(level(locals({ kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', verification: 'verified' })), 'owner');
  assert.equal(level(locals(self)), 'self');
  assert.equal(level(locals({ ...self, sidecar: 'db' })), 403);
  assert.equal(level(locals(self, 'gateway')), 403);
  assert.equal(level(locals({ kind: 'instance', appId: 'com.other.app', instanceId: 'com.other.app-1', verification: 'verified' })), 403);
  assert.equal(level(locals({ kind: 'anonymous' }, 'none')), 401);
  assert.equal(level(undefined as unknown as App.Locals), 401);
});
