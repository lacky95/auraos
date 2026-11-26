// Phase 5 stream X: DockerApi against a fake Engine API on a unix socket
// (exec create, hijacked start, resize, inspect, logs), and ExecBridge's
// protocol on top of it: TTY round trip, resize, exit codes, signals, the
// capped non-TTY run, stderr kept apart, logs (engine and the PRoot ring,
// tail and follow), what is refused, and the audit attribution.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerApi, EngineDemux } from '../dist/app-manager/DockerApi.js';
import {
  ExecBridge, ExecBridgeError, parseSessionOpen, parseSince, parseTail, execAudit, DEFAULT_JUMP_ARGV,
} from '../dist/app-manager/ExecBridge.js';
import { OutputLog } from '../dist/app-manager/outputLog.js';

const frame = (stream, text) => {
  const data = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
};

/** A fake Engine API: just enough for DockerApi, with every call recorded. */
async function fakeEngine(t, { tty = false, logsFollowExtra = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-engine-'));
  const socketPath = join(dir, 'engine.sock');
  const calls = [];
  const execs = new Map();
  let next = 1;
  const body = (req) => new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => resolve(s ? JSON.parse(s) : null));
  });
  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://docker');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    let m;
    if (req.method === 'POST' && (m = /^\/containers\/([^/]+)\/exec$/.exec(url.pathname))) {
      const spec = await body(req);
      if (m[1] === 'aura-gone') return json(res, 404, { message: 'No such container: aura-gone' });
      if (m[1] === 'aura-paused') return json(res, 409, { message: 'Container is paused' });
      const id = `e${next++}`;
      execs.set(id, { container: decodeURIComponent(m[1]), spec, running: true, exitCode: null });
      return json(res, 201, { Id: id });
    }
    if (req.method === 'POST' && (m = /^\/exec\/([^/]+)\/resize$/.exec(url.pathname))) {
      execs.get(m[1]).resized = [Number(url.searchParams.get('w')), Number(url.searchParams.get('h'))];
      return json(res, 201, {});
    }
    if (req.method === 'GET' && (m = /^\/exec\/([^/]+)\/json$/.exec(url.pathname))) {
      const e = execs.get(m[1]);
      return json(res, 200, { Running: e.running, ExitCode: e.exitCode });
    }
    if (req.method === 'GET' && (m = /^\/containers\/([^/]+)\/json$/.exec(url.pathname))) {
      return json(res, 200, { State: { Running: true }, Config: { Tty: tty } });
    }
    if (req.method === 'GET' && (m = /^\/containers\/([^/]+)\/logs$/.exec(url.pathname))) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' });
      res.write(frame(1, 'line one\n'));
      res.write(frame(2, 'warn two\n'));
      if (url.searchParams.get('follow') === '1' && logsFollowExtra) {
        setTimeout(() => { res.write(frame(1, logsFollowExtra)); }, 20);
        req.on('close', () => res.end());
        return;
      }
      return res.end();
    }
    json(res, 404, { message: `unexpected ${req.method} ${url.pathname}` });
  });
  // The hijacked exec start: 101, then the process's stdio on the socket.
  server.on('upgrade', (req, socket, head) => {
    const id = /^\/exec\/([^/]+)\/start$/.exec(req.url)?.[1];
    calls.push(`UPGRADE ${req.url}`);
    const e = execs.get(id);
    let pending = Buffer.from(head);
    let bodyLeft = Number(req.headers['content-length'] ?? 0);
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    const finish = (code) => { e.running = false; e.exitCode = code; socket.end(); };
    const argv = e.spec.Cmd;
    if (!e.spec.Tty) {
      socket.write(frame(1, `ran ${argv.join(' ')}\n`));
      socket.write(frame(2, 'to stderr\n'));
      if (argv[0] === 'big') socket.write(frame(1, 'x'.repeat(5 * 1024 * 1024)));
      if (argv[0] === 'hang') return; // never ends: the timeout test
    }
    let stdin = '';
    const onData = (d) => {
      if (bodyLeft > 0) { const n = Math.min(bodyLeft, d.length); bodyLeft -= n; d = d.subarray(n); }
      if (!d.length) return;
      stdin += d.toString();
      if (e.spec.Tty) {
        socket.write(`echo:${d.toString()}`);
        if (stdin.includes('exit 3\r')) finish(3);
      }
    };
    socket.on('data', onData);
    socket.on('end', () => {
      if (!e.spec.Tty && e.running) { socket.write(frame(1, `stdin:${stdin}`)); finish(argv[0] === 'false' ? 1 : 0); }
    });
    if (pending.length) onData(pending);
    if (!e.spec.Tty && !e.spec.AttachStdin) finish(argv[0] === 'false' ? 1 : 0);
  });
  await new Promise((r) => server.listen(socketPath, r));
  t.after(() => { server.closeAllConnections?.(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, calls, execs, api: new DockerApi({ socketPath }) };
}

function bridgeOver(engine, { sandbox = 'container', running = true, sidecars = [], log = null } = {}) {
  const instances = new Map([['io.test.app-1', { appId: 'io.test.app', instanceId: 'io.test.app-1', state: 'resumed' }]]);
  return new ExecBridge({
    engine,
    instance: (id) => instances.get(id),
    runner: () => ({
      isRunning: () => running,
      ...(sandbox === 'container'
        ? { engineContainer: () => ({ container: 'aura-io.test.app-1', workdir: '/workspace/apps/io.test.app' }) }
        : { outputLog: () => log }),
    }),
    sidecars: () => sidecars,
  });
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

test('EngineDemux splits frames across chunk boundaries', () => {
  const got = [];
  const d = new EngineDemux((s, data) => got.push([s, data.toString()]));
  const all = Buffer.concat([frame(1, 'abc'), frame(2, 'de'), frame(1, 'f')]);
  for (const b of all) d.push(Buffer.from([b]));
  assert.deepEqual(got, [[1, 'abc'], [2, 'de'], [1, 'f']]);
});

test('TTY session: root in the app container, env, resize, round trip, exit code', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const open = parseSessionOpen({ op: 'open', kind: 'jump', tty: true, cols: 120, rows: 40, env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', EVIL: 'x' } });
  let out = '';
  const s = await bridge.openSession('io.test.app-1', open, (ch, d) => { assert.equal(ch, 1); out += d; });
  const e = eng.execs.get('e1');
  assert.equal(e.container, 'aura-io.test.app-1');
  assert.equal(e.spec.User, '0', 'explicit root: 5-apps containers run with --user');
  assert.equal(e.spec.Tty, true);
  assert.deepEqual(e.spec.Cmd, DEFAULT_JUMP_ARGV);
  assert.equal(e.spec.WorkingDir, '/workspace/apps/io.test.app');
  assert.ok(e.spec.Env.includes('AURA_HOSTNAME=io.test.app'));
  assert.ok(e.spec.Env.includes('TERM=xterm-256color'));
  assert.ok(!e.spec.Env.some((v) => v.startsWith('EVIL=')), 'only the terminal env passes');
  await until(() => e.resized);
  assert.deepEqual(e.resized, [120, 40]);
  s.resize(100, 30);
  await until(() => e.resized[0] === 100);
  assert.equal(s.signal('INT'), true);
  s.input(Buffer.from('exit 3\r'));
  assert.equal(await s.exited, 3);
  assert.match(out, /echo:\x03/);
  assert.match(out, /exit 3/);
});

test('non-TTY session keeps stdout and stderr apart; stdin EOF; exit code', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const open = parseSessionOpen({ op: 'open', kind: 'exec', argv: ['false', 'x'], tty: false });
  const got = { 1: '', 2: '' };
  const s = await bridge.openSession('io.test.app-1', open, (ch, d) => { got[ch] += d; });
  s.input(Buffer.from('hello'));
  s.endInput();
  assert.equal(await s.exited, 1);
  assert.equal(got[1], 'ran false x\nstdin:hello');
  assert.equal(got[2], 'to stderr\n');
  assert.equal(eng.execs.get('e1').resized, undefined, 'no resize without a TTY');
});

test('a signal without a TTY ends the session', async (t) => {
  const eng = await fakeEngine(t);
  const s = await bridgeOver(eng.api).openSession('io.test.app-1', parseSessionOpen({ op: 'open', kind: 'exec', argv: ['hang'], tty: false }), () => {});
  assert.equal(s.signal('TERM'), false);
  assert.equal(await s.exited, null, 'still running in the engine: no exit code');
});

test('run: capped output, stdin, timeout', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const r = await bridge.run('io.test.app-1', { cmd: ['echo', 'hi'], stdin: 'abc', env: { FOO: 'bar' } });
  assert.deepEqual(r, { exitCode: 0, stdout: 'ran echo hi\nstdin:abc', stderr: 'to stderr\n', truncated: false, timedOut: false });
  assert.ok(eng.execs.get('e1').spec.Env.includes('FOO=bar'));
  const big = await bridge.run('io.test.app-1', { cmd: ['big'] });
  assert.equal(big.truncated, true);
  assert.equal(big.stdout.length, 4 * 1024 * 1024);
  const hang = await bridge.run('io.test.app-1', { cmd: ['hang'], timeoutMs: 1000 });
  assert.equal(hang.timedOut, true);
  assert.equal(hang.exitCode, null);
  await assert.rejects(bridge.run('io.test.app-1', { cmd: [] }), (e) => e instanceof ExecBridgeError && e.status === 400);
  await assert.rejects(bridge.run('io.test.app-1', { cmd: ['x'], stdin: 'y'.repeat(70 * 1024) }), (e) => e.status === 413);
  await assert.rejects(bridge.run('io.test.app-1', { cmd: ['x'], env: { 'BAD KEY': '1' } }), (e) => e.status === 400);
});

test('refused: unknown, stopped, PRoot, missing or paused container, home modes', async (t) => {
  const eng = await fakeEngine(t);
  const open = parseSessionOpen({ op: 'open', kind: 'jump', tty: true });
  await assert.rejects(bridgeOver(eng.api).openSession('nope-1', open, () => {}), (e) => e.status === 404);
  await assert.rejects(bridgeOver(eng.api, { running: false }).openSession('io.test.app-1', open, () => {}), (e) => e.status === 409 && e.code === 'not-running');
  await assert.rejects(bridgeOver(eng.api, { sandbox: 'proot' }).openSession('io.test.app-1', open, () => {}), (e) => e.code === 'runtime-unsupported');
  const gone = new ExecBridge({
    engine: eng.api, instance: () => ({ appId: 'a', instanceId: 'a' }), sidecars: () => [],
    runner: () => ({ isRunning: () => true, engineContainer: () => ({ container: 'aura-gone' }) }),
  });
  await assert.rejects(gone.openSession('a', open, () => {}), (e) => e.status === 404);
  const paused = new ExecBridge({
    engine: eng.api, instance: () => ({ appId: 'a', instanceId: 'a' }), sidecars: () => [],
    runner: () => ({ isRunning: () => true, engineContainer: () => ({ container: 'aura-paused' }) }),
  });
  await assert.rejects(paused.openSession('a', open, () => {}), (e) => e.status === 409);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'jump', tty: true, home: 'private' }), (e) => e.code === 'capability-missing');
  assert.equal(eng.execs.size, 0, 'nothing was executed');
});

test('parseSessionOpen validates the first frame', () => {
  assert.throws(() => parseSessionOpen(null), /first frame/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'root' }), /kind/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'exec' }), /argv/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'exec', argv: ['a\0b'] }), /argv/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'jump', cwd: 'rel' }), /cwd/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'jump', sidecar: '../x' }), /sidecar/);
  const o = parseSessionOpen({ op: 'open', kind: 'jump', tty: true, cols: 0, rows: 5000, env: { TERM: 'xterm; rm -rf /' } });
  assert.deepEqual([o.cols, o.rows, o.env], [80, 24, {}]);
});

test('sidecar session: the sidecar container, its image user', async (t) => {
  const eng = await fakeEngine(t);
  const sidecars = [{ id: 'aura-io.test.app-1--db', service: 'db', backend: 'container', state: 'running', parentInstanceId: 'io.test.app-1', appId: 'io.test.app' }];
  const s = await bridgeOver(eng.api, { sidecars }).openSession('io.test.app-1', parseSessionOpen({ op: 'open', kind: 'exec', argv: ['psql'], tty: false, sidecar: 'db' }), () => {});
  s.endInput();
  await s.exited;
  const e = eng.execs.get('e1');
  assert.equal(e.container, 'aura-io.test.app-1--db');
  assert.equal(e.spec.User, undefined);
  assert.ok(!e.spec.Env.some((v) => v.startsWith('AURA_HOSTNAME=')));
});

test('logs: engine frames split by stream; follow until closed', async (t) => {
  const eng = await fakeEngine(t, { logsFollowExtra: 'later\n' });
  const bridge = bridgeOver(eng.api);
  const got = [];
  const once = await bridge.logs('io.test.app-1', { tail: 10, since: 100, timestamps: true }, (s, d) => got.push([s, d.toString()]));
  await once.done;
  assert.deepEqual(got, [['out', 'line one\n'], ['err', 'warn two\n']]);
  assert.ok(eng.calls.some((c) => c === 'GET /containers/aura-io.test.app-1/logs?stdout=1&stderr=1&tail=10&since=100&timestamps=1'));
  const followed = [];
  const f = await bridge.logs('io.test.app-1', { follow: true }, (s, d) => followed.push(d.toString()));
  await until(() => followed.includes('later\n'));
  f.close();
  await f.done;
});

test('logs: the PRoot output ring, tail, since and follow', async () => {
  let now = 1_000_000;
  const log = new OutputLog(1024, () => now);
  log.push('out', 'a\nb\n');
  now += 5000;
  log.push('err', 'c\n');
  const bridge = bridgeOver(null, { sandbox: 'proot', log });
  const got = [];
  await (await bridge.logs('io.test.app-1', { tail: 2 }, (s, d) => got.push([s, d.toString()]))).done;
  assert.deepEqual(got, [['out', 'b\n'], ['err', 'c\n']]);
  const since = [];
  await (await bridge.logs('io.test.app-1', { since: 1003 }, (s, d) => since.push(d.toString()))).done;
  assert.deepEqual(since, ['c\n']);
  const live = [];
  const f = await bridge.logs('io.test.app-1', { tail: 0, follow: true }, (s, d) => live.push(d.toString()));
  log.push('out', 'd\n');
  f.close();
  await f.done;
  log.push('out', 'e\n');
  assert.deepEqual(live, ['d\n']);
  await assert.rejects(bridgeOver(null, { sandbox: 'proot', log: null }).logs('io.test.app-1', {}, () => {}), (e) => e.code === 'runtime-unsupported');
});

test('OutputLog is bounded', () => {
  const log = new OutputLog(10);
  for (let i = 0; i < 10; i++) log.push('out', `${i}${i}${i}\n`);
  assert.ok(log.read().map((c) => c.data).join('').length <= 12);
  assert.equal(log.read().at(-1).data, '999\n');
});

test('parseSince / parseTail', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseSince('10m', now), 1_700_000_000 - 600);
  assert.equal(parseSince('1700000000', now), 1_700_000_000);
  assert.equal(parseSince('2023-11-14T22:13:20Z', now), 1_700_000_000);
  assert.equal(parseSince('', now), undefined);
  assert.throws(() => parseSince('yesterday', now), (e) => e.status === 400);
  assert.equal(parseTail('50'), 50);
  assert.equal(parseTail('99999'), 5000);
  assert.equal(parseTail('all'), undefined);
  assert.throws(() => parseTail('-1'), (e) => e.status === 400);
});

test('execAudit attributes to the verified user, never a header', () => {
  const target = { appId: 'io.test.app', instanceId: 'io.test.app-1' };
  const owner = execAudit({ kind: 'user', userId: 'u1', role: 'owner', sessionId: 'abcdef123456', verification: 'verified' }, 'session.opened', target, { mode: 'jump' });
  assert.deepEqual(owner.by, { kind: 'user', userId: 'u1', session: 'abcdef12' });
  assert.equal(owner.target, 'app:io.test.app');
  assert.deepEqual(owner.detail, { instance: 'io.test.app-1', mode: 'jump' });
  const term = execAudit({ kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', userId: 'u1', verification: 'verified' }, 'instance.exec', target);
  assert.deepEqual(term.by, { kind: 'user', userId: 'u1' });
  assert.deepEqual(term.detail.through, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1' });
  assert.deepEqual(execAudit({ kind: 'operator', verification: 'verified' }, 'instance.logs', target).by, { kind: 'operator' });
  assert.deepEqual(execAudit(null, 'session.closed', target).by, { kind: 'anonymous' });
});
