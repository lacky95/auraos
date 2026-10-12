// SidecarManager against a fake docker: the create argv (labels, network,
// identity + the sidecar's own token, no socket without the docker tool),
// adopt-on-equal-spec, recreate-on-change, cleanup when start fails or the
// runtime dies on boot, grandchild removal, reconcile after a shell restart,
// exec plumbing, and the app-managed name collision.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarManager } from '../dist/app-manager/SidecarManager.js';
import { InstanceTokens } from '../dist/app-manager/InstanceTokens.js';

const APP = 'io.test.app';
const INST = 'io.test.app-2';

/** In-memory docker: just enough of the CLI for SidecarManager. */
function fakeDocker(t, { failStart = false, dieOnBoot = false } = {}) {
  const containers = new Map();   // name → { id, state, labels, args }
  const calls = [];
  let nextId = 1;
  const byRef = (ref) => containers.get(ref) ?? [...containers.values()].find((c) => c.id === ref);
  const reply = (cb, code, stdout = '', stderr = '') => queueMicrotask(() => {
    if (code === 0) cb(null, stdout, stderr);
    else cb(Object.assign(new Error(stderr || 'failed'), { code }), stdout, stderr);
  });
  t.mock.method(childProcess, 'execFile', (cmd, args, _opts, cb) => {
    assert.equal(cmd, 'docker');
    calls.push(args);
    const [verb] = args;
    if (verb === 'volume') reply(cb, 1, '', 'no such volume');
    else if (verb === 'image') reply(cb, 0, args.includes('{{.Id}}') ? 'sha256:x' : 'PATH=/usr/bin:/bin\n');
    else if (verb === 'inspect') {
      const ref = args[args.length - 1];
      if (args[2]?.startsWith('{{range .Config.Env}}')) { reply(cb, 0, 'PARENT_ONLY=yes\nK1=from-parent\n'); return { stdin: { end() {} } }; }
      const c = byRef(ref);
      if (!c) reply(cb, 1, '', `No such object: ${ref}`);
      else reply(cb, 0, `/${c.name}\t${c.state}\t${JSON.stringify(c.labels)}\n`);
    } else if (verb === 'ps') {
      const filters = args.flatMap((a, i) => (args[i - 1] === '--filter' ? [a.replace(/^label=/, '')] : []));
      const match = [...containers.values()].filter((c) => filters.every((f) => {
        const [k, v] = f.split('=');
        return c.labels[k] === v;
      }));
      const fmt = args[args.indexOf('--format') + 1];
      if (args.includes('-aq')) reply(cb, 0, match.map((c) => c.id).join('\n'));
      else if (fmt?.includes('{{.State}}')) reply(cb, 0, match.map((c) => `${c.name}\t${c.state}\t${c.labels['aura.sidecar.spec']}`).join('\n'));
      else reply(cb, 0, match.map((c) => `${c.name}\t${c.labels['aura.parent']}\t${c.labels['aura.sidecar.spec']}`).join('\n'));
    } else if (verb === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const labels = {};
      args.forEach((a, i) => { if (args[i - 1] === '--label') { const j = a.indexOf('='); labels[a.slice(0, j)] = a.slice(j + 1); } });
      const id = `id${nextId++}`;
      containers.set(name, { id, name, state: 'created', labels, args });
      reply(cb, 0, `${id}\n`);
    } else if (verb === 'start') {
      const c = byRef(args[1]);
      if (failStart) reply(cb, 1, '', 'port is already allocated');
      else { c.state = dieOnBoot ? 'exited' : 'running'; reply(cb, 0); }
    } else if (verb === 'rm') {
      const c = byRef(args[args.length - 1]);
      if (c) containers.delete(c.name);
      reply(cb, 0);
    } else if (verb === 'logs') reply(cb, 0, 'boom: config missing\n');
    else if (verb === 'exec') reply(cb, args.includes('fail') ? 3 : 0, 'hi\n', '');
    else reply(cb, 0);
    return { stdin: { end() {} } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { containers, calls };
}

function fixture(t, opts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-sc-'));
  const tokens = new InstanceTokens(join(dataDir, 'aura', 'secrets', 'k'));
  const mountCalls = [];
  const services = [
    { name: 'box', image: 'alpine:3', command: ['sleep', 'infinity'], env: { A: '1' }, envInherit: ['CTX_KEY', 'K1'],
      volumes: [{ name: 'data', target: '/data' }], inheritIdentity: true, inheritMounts: true },
    ...(opts.services ?? []),
  ];
  const mgr = new SidecarManager({
    runner: {
      sidecarRuntime: () => ({ dataDir, appDataVolume: 'appvol', nodeModulesVolume: 'nm', network: 'aura-net',
        osApiBase: 'http://aura-shell:3000', shellHostname: 'aura-shell', workspaceRoot: '/ws', toolsMode: 'hardlink' }),
      mountRootDir: (k) => join(dataDir, 'aura', 'mounts', k),
      mountRootSubpath: (k) => `aura/mounts/${k}`,
      resolveContextEnv: async () => ({ CTX_KEY: 'ctx-value' }),
    },
    registry: { getById: (id) => (id === APP ? { id: APP, services, tools: opts.tools ?? [], permissions: ['sidecars.spawn'] } : undefined) },
    permissions: { hasPermission: (_app, p) => (opts.perms ?? []).includes(p) },
    tokens,
    mounts: {
      reapplyConsumer: async (k, o) => { mountCalls.push(['reapply', k, o]); return { restored: 0, inherited: 0, failed: 0 }; },
      removeAll: (k) => mountCalls.push(['removeAll', k]),
      forgetConsumer: (k) => mountCalls.push(['forget', k]),
    },
    instance: (id) => (id === INST ? { appId: APP, instanceDataDir: join(dataDir, 'scopes/users/default/apps', APP, INST) } : null),
  });
  return { mgr, tokens, mountCalls, dataDir };
}

const flag = (args, name) => args.flatMap((a, i) => (args[i - 1] === name ? [a] : []));

test('spawn: labels, network, env order, own token, mount root, no socket', async (t) => {
  const d = fakeDocker(t);
  const { mgr, tokens, mountCalls } = fixture(t);
  const res = await mgr.spawn(INST, { template: 'box', env: { A: '2' } }, { instanceId: INST });
  assert.equal(res.created, true);
  assert.equal(res.sidecar.containerName, `aura-${INST}--box`);
  assert.equal(res.sidecar.host, `aura-${INST}--box`);
  const c = d.containers.get(`aura-${INST}--box`);
  assert.equal(c.state, 'running');
  assert.equal(c.labels['aura.parent'], INST);
  assert.equal(c.labels['aura.app'], APP);
  assert.equal(c.labels['aura.service'], 'box');
  assert.equal(c.labels['aura.managed'], 'os');
  assert.equal(flag(c.args, '--network')[0], 'aura-net');
  const env = Object.fromEntries(flag(c.args, '-e').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  assert.equal(env.A, '2', 'request env wins over the template');
  assert.equal(env.CTX_KEY, 'ctx-value', 'envInherit from OS Context');
  assert.equal(env.K1, 'from-parent', 'envInherit falls back to the app container env');
  assert.equal(env.AURA_INSTANCE_ID, INST);
  assert.equal(env.AURA_SIDECAR_NAME, 'box');
  assert.deepEqual(tokens.verify(env.AURA_INSTANCE_TOKEN), { instanceId: INST, sidecar: 'box' }, 'the sidecar gets its OWN token');
  assert.ok(!c.args.includes('/var/run/docker.sock:/var/run/docker.sock'));
  assert.ok(flag(c.args, '--mount').some((m) => m.includes('target=/mnt/aura') && m.includes(`volume-subpath=aura/mounts/${INST}--box`)));
  assert.ok(flag(c.args, '--mount').some((m) => m.includes('target=/data') && m.includes('/.sidecars/box/data')));
  assert.deepEqual(mountCalls.at(-1), ['reapply', `${INST}--box`, { own: false, inherit: true, exclude: [], forceRo: false }]);
  assert.deepEqual(mgr.fanoutTargets(INST), [{ consumer: `${INST}--box`, exclude: [], forceRo: false }]);
  assert.equal(c.args.at(-3), 'alpine:3');
});

test('same spec → adopted (no create); changed spec → recreated, own mounts kept', async (t) => {
  const d = fakeDocker(t);
  const { mgr, mountCalls } = fixture(t);
  await mgr.spawn(INST, { template: 'box' }, { instanceId: INST });
  const creates = () => d.calls.filter((a) => a[0] === 'create').length;
  const again = await mgr.spawn(INST, { template: 'box' }, { instanceId: INST });
  assert.equal(again.created, false);
  assert.equal(creates(), 1);
  const changed = await mgr.spawn(INST, { template: 'box', env: { NEW: 'x' } }, { instanceId: INST });
  assert.equal(changed.created, true);
  assert.equal(creates(), 2);
  assert.ok(mountCalls.some((c) => c[0] === 'removeAll' && c[1] === `${INST}--box`), 'binds dropped, declarations kept');
  await assert.rejects(mgr.spawn(INST, { template: 'box', env: { NEW: 'y' }, replace: false }, { instanceId: INST }), /different spec/);
});

test('a failing start is cleaned up by container id', async (t) => {
  const d = fakeDocker(t, { failStart: true });
  const { mgr } = fixture(t);
  await assert.rejects(mgr.spawn(INST, { template: 'box' }, { instanceId: INST }), /port is already allocated/);
  assert.equal(d.containers.size, 0);
  assert.ok(d.calls.some((a) => a[0] === 'rm' && a.at(-1) === 'id1'));
});

test('a runtime that dies on boot fails the spawn with its logs and is removed', async (t) => {
  const d = fakeDocker(t, { dieOnBoot: true });
  const { mgr, tokens } = fixture(t);
  await assert.rejects(mgr.spawn(INST, { template: 'box' }, { instanceId: INST }), /exited right after start:\nboom: config missing/);
  assert.equal(d.containers.size, 0);
  assert.equal(tokens.hasNonce(INST, 'box'), false);
});

test('remove deletes grandchildren, mounts and the token', async (t) => {
  const d = fakeDocker(t);
  const { mgr, tokens, mountCalls } = fixture(t);
  await mgr.spawn(INST, { template: 'box' }, { instanceId: INST });
  await mgr.spawn(INST, { template: 'box', suffix: 'kid' }, { instanceId: INST, sidecar: 'box' });
  assert.equal(d.containers.get(`aura-${INST}--box-kid`).labels['aura.sidecar.owner'], 'box');
  await mgr.remove(INST, 'box');
  assert.equal(d.containers.size, 0);
  assert.equal(tokens.hasNonce(INST, 'box'), false);
  assert.ok(mountCalls.some((c) => c[0] === 'forget' && c[1] === `${INST}--box-kid`));
  assert.ok(mountCalls.some((c) => c[0] === 'forget' && c[1] === `${INST}--box`));
  await assert.rejects(mgr.remove(INST, 'box'), /no OS sidecar 'box'/);
});

test('reconcile re-learns live sidecars (token, fan-out) and reaps dead parents', async (t) => {
  const d = fakeDocker(t);
  const first = fixture(t);
  await first.mgr.spawn(INST, { template: 'box' }, { instanceId: INST });
  const env = flag(d.containers.get(`aura-${INST}--box`).args, '-e').find((kv) => kv.startsWith('AURA_INSTANCE_TOKEN='));
  const token = env.slice('AURA_INSTANCE_TOKEN='.length);
  d.containers.set('aura-gone.app--x', { id: 'zz', name: 'aura-gone.app--x', state: 'running',
    labels: { 'aura.managed': 'os', 'aura.parent': 'gone.app', 'aura.sidecar.spec': JSON.stringify({ name: 'x', template: 'x', image: 'i', specHash: 'h', mounts: { own: false, inherit: false, exclude: [], forceRo: false }, createdAt: '' }) } });

  // "Shell restart": fresh manager + fresh token memory, same key file.
  const tokens2 = new InstanceTokens(join(first.dataDir, 'aura', 'secrets', 'k'));
  const mgr2 = new SidecarManager({ ...first.mgr.opts, tokens: tokens2 });
  assert.equal(tokens2.verify(token), null);
  const res = await mgr2.reconcile(new Set([INST]));
  assert.deepEqual(res, { adopted: 1, reaped: 1 });
  assert.ok(!d.containers.has('aura-gone.app--x'));
  assert.deepEqual(tokens2.verify(token), { instanceId: INST, sidecar: 'box' });
  assert.deepEqual(mgr2.liveConsumerKeys(), [`${INST}--box`]);
});

test('exec: -i only with stdin, exit codes pass through, cmd validated', async (t) => {
  const d = fakeDocker(t);
  const { mgr } = fixture(t);
  await mgr.spawn(INST, { template: 'box' }, { instanceId: INST });
  const ok = await mgr.exec(INST, 'box', { cmd: ['echo', 'hi'] });
  assert.deepEqual(ok, { exitCode: 0, stdout: 'hi\n', stderr: '', truncated: false, timedOut: false });
  assert.ok(!d.calls.at(-1).includes('-i'));
  await mgr.exec(INST, 'box', { cmd: ['cat'], stdin: 'x' });
  assert.ok(d.calls.at(-1).includes('-i'));
  assert.equal((await mgr.exec(INST, 'box', { cmd: ['fail'] })).exitCode, 3);
  await assert.rejects(mgr.exec(INST, 'box', { cmd: [] }), /non-empty array/);
  await assert.rejects(mgr.exec(INST, 'nope', { cmd: ['x'] }), /no OS sidecar/);
  await assert.rejects(mgr.exec(INST, 'box', { cmd: ['x'], stdin: 'y'.repeat(70_000) }), /64 KiB/);
});

test("an app-managed container of the same name is never touched — unless the app takes over its own", async (t) => {
  const d = fakeDocker(t);
  const { mgr } = fixture(t);
  d.containers.set(`aura-${INST}--box`, { id: 'sdk1', name: `aura-${INST}--box`, state: 'running', labels: { 'aura.parent': INST, 'aura.service': 'box' } });
  await assert.rejects(mgr.spawn(INST, { template: 'box' }, { instanceId: INST }), /not OS-managed/);
  assert.equal(d.containers.get(`aura-${INST}--box`).id, 'sdk1');
  const res = await mgr.spawn(INST, { template: 'box', takeover: true }, { instanceId: INST });
  assert.equal(res.created, true);
  assert.equal(d.containers.get(`aura-${INST}--box`).labels['aura.managed'], 'os');
});

test('the docker socket is forwarded only with the docker tool', async (t) => {
  const d = fakeDocker(t);
  const svc = [{ name: 'sock', image: 'x:1', inheritDockerSocket: true, command: [], env: {}, volumes: [] }];
  await assert.rejects(fixture(t, { services: svc }).mgr.spawn(INST, { template: 'sock' }, { instanceId: INST }), /does not grant docker/);
  await fixture(t, { services: svc, tools: ['docker'] }).mgr.spawn(INST, { template: 'sock' }, { instanceId: INST });
  assert.ok(d.containers.get(`aura-${INST}--sock`).args.includes('/var/run/docker.sock:/var/run/docker.sock'));
});
