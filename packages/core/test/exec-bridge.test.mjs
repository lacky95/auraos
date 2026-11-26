// Phase 5 streams X and J: DockerApi against a fake Engine API on a unix
// socket (exec create, hijacked start, resize, inspect, logs), and ExecBridge
// on top of it: sessions enter the running app through the container
// runtime's session broker (J, D74: one exec of aura-session-enter in the
// broker, the kernel's spec as its input), TTY round trip, resize, exit
// codes, signals and the launcher's end, the capped non-TTY run, stderr kept
// apart, logs (engine and the PRoot ring, tail and follow), what is refused
// (J.5), and the audit attribution.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DockerApi, EngineDemux } from '../dist/app-manager/DockerApi.js';
import {
  ExecBridge, ExecBridgeError, parseSessionOpen, parseSince, parseTail, execAudit, DEFAULT_JUMP_ARGV,
  sessionCallerOf,
} from '../dist/app-manager/ExecBridge.js';
import { SessionBroker } from '../dist/app-manager/SessionBroker.js';
import { HomeDeniedError } from '../dist/homes/types.js';
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
      return json(res, 200, { Running: e.running, ExitCode: e.exitCode, Pid: e.running ? 4242 : 0 });
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
    let argv = e.spec.Cmd;
    // The session broker's launcher: its input is the kernel's spec; end/reap answer at once.
    if (argv[1] === 'end' || argv[1] === 'reap') return finish(0);
    if (argv[1] === 'enter') { e.enter = JSON.parse(argv[2]); argv = e.enter.argv; }
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

const CONTAINER_CAPS = { isolation: 'namespace', privateHomeSession: true, sessionExec: true, identity: 'enforced', readOnlyBinds: true, mounts: true, portExpose: true, sidecars: true, warmPool: true, survivesShellRestart: true };
const PROOT_CAPS = { ...CONTAINER_CAPS, isolation: 'ptrace', privateHomeSession: false, sessionExec: false, identity: 'emulated', readOnlyBinds: false };
const CONTAINER_ID = 'c'.repeat(64);
const owner = { user: { userId: 'u1', role: 'owner' } };

/** A generated /etc/passwd line (identity/passwd.ts shape). */
const accountLine = (uid) => `aura-user-${uid}:x:${uid}:${uid}::/home/aura:/bin/bash\n`;

/** The kernel's decision as AppManager.sessionContext makes it (its own tests: phase5-homes). */
function defaultContext(req) {
  if (req.mode === 'app') return { kind: 'app', home: { mode: 'app', hostPath: null }, uid: 200001, gid: 200001, groups: [], env: { HOME: '/home/aura' } };
  return {
    kind: 'user', home: { mode: req.mode, hostPath: req.mode === 'private' ? '/data/aura/home/u1' : null },
    uid: 1000, gid: 1000, groups: [1000], env: { HOME: '/home/aura', TMPDIR: '/run/aura-session' }, userId: req.caller.user.userId,
    passwd: accountLine(1000),
  };
}

function bridgeOver(engine, { sandbox = 'container', running = true, sidecars = [], log = null, context = defaultContext } = {}) {
  const instances = new Map([['io.test.app-1', { appId: 'io.test.app', instanceId: 'io.test.app-1', state: 'resumed' }]]);
  const dir = mkdtempSync(join(tmpdir(), 'broker-'));
  const helper = join(dir, 'helper-src');
  writeFileSync(helper, '#!/bin/true\n');
  const docker = [];
  const broker = engine ? new SessionBroker({
    engine, dataDir: dir, appDataVolume: 'aura_aura-app-data',
    docker: async (args) => { docker.push(args); return args[0] === 'inspect' ? 'true session-broker' : ''; },
    helperBinary: async () => helper,
  }) : null;
  const bridge = new ExecBridge({
    engine,
    instance: (id) => instances.get(id),
    runner: () => ({
      isRunning: () => running,
      capabilities: () => (sandbox === 'container' ? CONTAINER_CAPS : PROOT_CAPS),
      ...(sandbox === 'container'
        ? {
          engineContainer: () => ({ container: 'aura-io.test.app-1', workdir: '/workspace/apps/io.test.app' }),
          openSession: (id, spec, out) => broker.openSession({ ...spec, cwd: spec.cwd ?? '/workspace/apps/io.test.app' }, { containerId: CONTAINER_ID, pid: 777 }, out),
        }
        : { outputLog: () => log }),
    }),
    sidecars: () => sidecars,
    sessionContext: async (id, req) => context(req),
  });
  bridge.docker = docker;
  bridge.broker = broker;
  return bridge;
}

/** The launcher exec of the session (the broker's `enter`), skipping its reap. */
const enterOf = (eng) => [...eng.execs.values()].find((e) => e.spec.Cmd[1] === 'enter');

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

test('TTY session: in the running app as the user, with the Private Home (D74, J.2)', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const open = parseSessionOpen({ op: 'open', kind: 'jump', tty: true, cols: 120, rows: 40, env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', EVIL: 'x' } });
  let out = '';
  const s = await bridge.openSession('io.test.app-1', open, (ch, d) => { assert.equal(ch, 1); out += d; }, owner);
  const e = enterOf(eng);
  assert.equal(e.container, 'aura-session-broker', 'one exec in the broker, never a new container');
  assert.equal(e.spec.User, '0');
  assert.equal(e.spec.Tty, true);
  assert.equal(e.spec.Cmd.length, 3);
  assert.match(e.spec.Cmd[0], /\/aura\/runtime\/session-broker\/aura-session-enter-[0-9a-f]{16}$/);
  const x = e.enter;
  assert.deepEqual([x.v, x.kind, x.home, x.homePath, x.uid, x.gid, x.groups], [1, 'user', 'private', '/data/aura/home/u1', 1000, 1000, [1000]]);
  assert.deepEqual([x.container, x.pid, x.tty, x.cwd], [CONTAINER_ID, 777, true, '/workspace/apps/io.test.app']);
  assert.deepEqual(x.argv, DEFAULT_JUMP_ARGV);
  assert.ok(x.env.includes('TERM=xterm-256color') && x.env.includes('HOME=/home/aura'));
  assert.ok(x.env.some((v) => /^AURA_SESSION=[0-9a-f-]{36}$/.test(v)));
  assert.ok(!x.env.some((v) => v.startsWith('EVIL=')), 'only the terminal env passes');
  assert.equal(x.socket, undefined, 'a user session never gets the Docker socket');
  assert.match(x.passwd, /^aura-user-1000:/);
  assert.deepEqual(bridge.broker.sessions().map((r) => [r.kind, r.home, r.launcherPid, r.userId]), [['user', 'private', 4242, 'u1']]);
  await until(() => e.resized);
  assert.deepEqual(e.resized, [120, 40]);
  s.resize(100, 30);
  await until(() => e.resized[0] === 100);
  assert.equal(s.signal('INT'), true);
  s.input(Buffer.from('exit 3\r'));
  assert.equal(await s.exited, 3);
  assert.match(out, /echo:\x03/);
  assert.match(out, /exit 3/);
  await until(() => bridge.broker.sessions().length === 0);
});

test('the broker is adopted by its label, the helper staged once, stale launchers reaped first (D77)', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const open = parseSessionOpen({ op: 'open', kind: 'exec', argv: ['true'], tty: false });
  for (let i = 0; i < 2; i++) { const s = await bridge.openSession('io.test.app-1', open, () => {}, owner); s.endInput(); await s.exited; }
  assert.equal(bridge.docker.filter((a) => a[0] === 'inspect').length, 1, 'set up once per shell');
  assert.ok(!bridge.docker.some((a) => a[0] === 'run'), 'an existing broker is adopted, never duplicated');
  const reaps = [...eng.execs.values()].filter((e) => e.spec.Cmd[1] === 'reap');
  assert.equal(reaps.length, 1);
  assert.deepEqual(reaps[0].spec.Cmd.slice(2), [], 'a new shell keeps no launcher of the previous one');
});

test('non-TTY session keeps stdout and stderr apart; stdin EOF; exit code', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const open = parseSessionOpen({ op: 'open', kind: 'exec', argv: ['false', 'x'], tty: false });
  const got = { 1: '', 2: '' };
  const s = await bridge.openSession('io.test.app-1', open, (ch, d) => { got[ch] += d; }, owner);
  s.input(Buffer.from('hello'));
  s.endInput();
  assert.equal(await s.exited, 1);
  assert.equal(got[1], 'ran false x\nstdin:hello');
  assert.equal(got[2], 'to stderr\n');
  assert.equal(enterOf(eng).resized, undefined, 'no resize without a TTY');
});

test('a closed session ends its launcher in the broker (disconnect, End, timeout)', async (t) => {
  const eng = await fakeEngine(t);
  const s = await bridgeOver(eng.api).openSession('io.test.app-1', parseSessionOpen({ op: 'open', kind: 'exec', argv: ['hang'], tty: false }), () => {}, owner);
  assert.equal(s.signal('TERM'), false);
  await until(() => [...eng.execs.values()].some((e) => e.spec.Cmd[1] === 'end'));
  const end = [...eng.execs.values()].find((e) => e.spec.Cmd[1] === 'end');
  assert.deepEqual(end.spec.Cmd.slice(2), ['4242']);
});

test('run: capped output, stdin, timeout; user is a sidecar\'s only', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const r = await bridge.run('io.test.app-1', { cmd: ['echo', 'hi'], stdin: 'abc', env: { FOO: 'bar', HOME: '/evil' } }, { caller: owner });
  assert.deepEqual(r, { exitCode: 0, stdout: 'ran echo hi\nstdin:abc', stderr: 'to stderr\n', truncated: false, timedOut: false });
  assert.ok(enterOf(eng).enter.env.includes('FOO=bar'));
  assert.ok(enterOf(eng).enter.env.includes('HOME=/home/aura'), 'the kernel\'s keys are not the caller\'s');
  const big = await bridge.run('io.test.app-1', { cmd: ['big'] }, { caller: owner });
  assert.equal(big.truncated, true);
  assert.equal(big.stdout.length, 4 * 1024 * 1024);
  const hang = await bridge.run('io.test.app-1', { cmd: ['hang'], timeoutMs: 1000 }, { caller: owner });
  assert.equal(hang.timedOut, true);
  assert.equal(hang.exitCode, null);
  await assert.rejects(bridge.run('io.test.app-1', { cmd: [] }), (e) => e instanceof ExecBridgeError && e.status === 400);
  await assert.rejects(bridge.run('io.test.app-1', { cmd: ['x'], stdin: 'y'.repeat(70 * 1024) }), (e) => e.status === 413);
  await assert.rejects(bridge.run('io.test.app-1', { cmd: ['x'], env: { 'BAD KEY': '1' } }), (e) => e.status === 400);
  await assert.rejects(bridge.run('io.test.app-1', { cmd: ['x'], user: '0' }, { caller: owner }), (e) => e.status === 400 && /sidecar only/.test(e.message));
});

test('home modes: ephemeral and app; the instance itself gets app only', async (t) => {
  const eng = await fakeEngine(t);
  const bridge = bridgeOver(eng.api);
  const run = async (open, caller) => { const s = await bridge.openSession('io.test.app-1', parseSessionOpen(open), () => {}, caller); s.endInput(); await s.exited; const e = [...eng.execs.values()].filter((x) => x.spec.Cmd[1] === 'enter').at(-1); return e.enter; };
  const eph = await run({ op: 'open', kind: 'exec', argv: ['true'], home: 'ephemeral' }, owner);
  assert.deepEqual([eph.kind, eph.home, eph.homePath, eph.uid], ['user', 'ephemeral', undefined, 1000]);
  const app = await run({ op: 'open', kind: 'exec', argv: ['true'], home: 'app' }, owner);
  assert.deepEqual([app.kind, app.home, app.uid, app.gid], ['app', 'app', 200001, 200001], 'D79: the app\'s identity');
  const self = await run({ op: 'open', kind: 'exec', argv: ['true'] }, {});
  assert.deepEqual([self.kind, self.home], ['app', 'app'], 'no human user: the app identity only');
  await assert.rejects(bridge.openSession('io.test.app-1', parseSessionOpen({ op: 'open', kind: 'jump', home: 'private' }), () => {}, {}), (e) => e.status === 403);
});

test('refused, nothing runs: unknown, stopped, PRoot, root instance, unauthorized, bad home (J.5)', async (t) => {
  const eng = await fakeEngine(t);
  const open = parseSessionOpen({ op: 'open', kind: 'jump', tty: true });
  await assert.rejects(bridgeOver(eng.api).openSession('nope-1', open, () => {}, owner), (e) => e.status === 404);
  await assert.rejects(bridgeOver(eng.api, { running: false }).openSession('io.test.app-1', open, () => {}, owner), (e) => e.status === 409 && e.code === 'not-running');
  for (const home of ['private', 'app', 'ephemeral']) {
    await assert.rejects(bridgeOver(eng.api, { sandbox: 'proot' }).openSession('io.test.app-1', parseSessionOpen({ op: 'open', kind: 'jump', home }), () => {}, owner),
      (e) => e.status === 409 && e.code === 'capability-missing' && /sessionExec/.test(e.message), `PRoot ${home}`);
  }
  const rootApp = () => { throw new HomeDeniedError('root-instance', 'a private jump needs a non-root target instance'); };
  await assert.rejects(bridgeOver(eng.api, { context: rootApp }).openSession('io.test.app-1', open, () => {}, owner),
    (e) => e.status === 409 && e.code === 'capability-missing' && /identity \(instance runs as root/.test(e.message));
  const noGrant = () => { throw new HomeDeniedError('not-authorized', 'user u2 holds no app.jump grant'); };
  await assert.rejects(bridgeOver(eng.api, { context: noGrant }).openSession('io.test.app-1', open, () => {}, { user: { userId: 'u2', role: 'member' } }),
    (e) => e.status === 403);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'jump', home: 'shared' }), (e) => e.status === 400);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'jump', home: 'app', sidecar: 'db' }), (e) => e.status === 400);
  assert.equal(enterOf(eng), undefined, 'nothing was executed');
});

test('sessionCallerOf: the verified principal decides the user, never the frame', () => {
  assert.deepEqual(sessionCallerOf({ kind: 'operator', verification: 'verified' }, 'owner', 'default'), { user: { userId: 'default', role: 'owner' } });
  assert.deepEqual(sessionCallerOf({ kind: 'user', userId: 'u1', role: 'owner' }, 'owner', 'default'), { user: { userId: 'u1', role: 'owner' } });
  assert.deepEqual(sessionCallerOf({ kind: 'user', userId: 'bob', role: 'member' }, 'member', 'default'), { user: { userId: 'bob', role: 'member' } });
  assert.deepEqual(sessionCallerOf({ kind: 'user', userId: 'bob', role: 'member' }, 'owner', 'default'), {}, 'a member never passes as the owner');
  assert.deepEqual(sessionCallerOf({ kind: 'instance', appId: 'com.aura.terminal', instanceId: 't-1', userId: 'default' }, 'owner', 'default'), { user: { userId: 'default', role: 'owner' } });
  assert.deepEqual(sessionCallerOf({ kind: 'instance', appId: 'io.test.app', instanceId: 'io.test.app-1', userId: 'default' }, 'self', 'default'), {}, 'the instance itself is no user');
});

test('parseSessionOpen validates the first frame', () => {
  assert.throws(() => parseSessionOpen(null), /first frame/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'root' }), /kind/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'exec' }), /argv/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'exec', argv: ['a\0b'] }), /argv/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'jump', cwd: 'rel' }), /cwd/);
  assert.throws(() => parseSessionOpen({ op: 'open', kind: 'jump', sidecar: '../x' }), /sidecar/);
  const o = parseSessionOpen({ op: 'open', kind: 'jump', tty: true, cols: 0, rows: 5000, env: { TERM: 'xterm; rm -rf /' } });
  assert.deepEqual([o.cols, o.rows, o.env, o.home], [80, 24, {}, undefined]);
  assert.equal(parseSessionOpen({ op: 'open', kind: 'jump', home: 'ephemeral' }).home, 'ephemeral');
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
  assert.equal(e.enter, undefined, 'a sidecar is no in-environment session');
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
