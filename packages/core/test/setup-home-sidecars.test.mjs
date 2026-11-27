// D108 P9 (D107-a): the owner-environment sidecar of a Private Home instance
// against a fake docker (no KV server: SidecarManager reads os:sidecars
// through defaultKv). L5: a sidecar without its grant gets no home; an App
// Home sidecar of a private instance and a shared listener are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarManager } from '../dist/app-manager/SidecarManager.js';
import { containerSidecars } from '../dist/runtimes/container/sidecars.js';
import { InstanceTokens } from '../dist/app-manager/InstanceTokens.js';

const APP = 'io.test.webui';
const OWNER = 'default';

/** A minimal fake docker for the create argv (sidecar-manager.test.mjs has the full one). */
function fakeDocker(t) {
  const containers = new Map();
  const reply = (cb, code, stdout = '', stderr = '') => queueMicrotask(() => (code === 0 ? cb(null, stdout, stderr) : cb(Object.assign(new Error(stderr || 'failed'), { code }), stdout, stderr)));
  t.mock.method(childProcess, 'execFile', (_cmd, args, _opts, cb) => {
    const [verb] = args;
    if (verb === 'image') reply(cb, 0, args.includes('{{.Id}}') ? 'sha256:x' : 'PATH=/usr/bin\n');
    else if (verb === 'inspect') {
      const c = containers.get(args.at(-1)) ?? [...containers.values()].find((x) => x.id === args.at(-1));
      if (args[2]?.startsWith('{{range .Config.Env}}')) reply(cb, 0, '');
      else if (!c) reply(cb, 1, '', 'No such object');
      else reply(cb, 0, `/${c.name}\t${c.state}\t${JSON.stringify(c.labels)}\t0\n`);
    } else if (verb === 'create') {
      const name = args[args.indexOf('--name') + 1];
      containers.set(name, { id: `id-${name}`, name, state: 'created', labels: {}, args });
      reply(cb, 0, `id-${name}\n`);
    } else if (verb === 'start') {
      const c = [...containers.values()].find((x) => x.id === args[1] || x.name === args[1]);
      if (c) c.state = 'running';
      reply(cb, 0);
    } else if (verb === 'volume') reply(cb, 1, '', 'no such volume');
    else if (verb === 'ps') reply(cb, 0, '');
    else reply(cb, 0);
    return { stdin: { end() {} } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return containers;
}

function sidecarFixture(t, { template, authorized }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-p9s-'));
  const INST = `${APP}-1`;
  const runner = {
    sidecarRuntime: () => ({ dataDir, appDataVolume: 'appvol', nodeModulesVolume: 'nm', network: 'aura-net',
      osApiBase: 'http://aura-shell:3000', shellHostname: 'aura-shell', workspaceRoot: '/ws', toolsMode: 'hardlink' }),
    mountRootDir: (k) => join(dataDir, 'aura', 'mounts', k),
    mountRootSubpath: (k) => `aura/mounts/${k}`,
    isolatedNetwork: (id) => `aura-inst-${id}`,
    toolsDir: (k) => join(dataDir, 'aura', 'runtime', k, 'tools'),
    clearToolsDir: () => undefined,
  };
  const asked = [];
  const mgr = new SidecarManager({
    runner, workloads: containerSidecars(runner, { baseImage: 'aura-base' }),
    registry: { getById: (id) => (id === APP ? { id: APP, services: [template], tools: [], permissions: ['sidecars.spawn'] } : undefined) },
    permissions: { hasPermission: () => false },
    tokens: new InstanceTokens(join(dataDir, 'aura', 'secrets', 'k')),
    mounts: { reapplyConsumer: async () => ({ restored: 0, inherited: 0, failed: 0 }), removeAll: () => undefined, forgetConsumer: () => undefined },
    context: async () => ({ env: {}, known: new Set() }),
    // A private instance (AppManager: runAs user, not the Terminal): its user's identity, userApp.
    instance: (id) => (id === INST ? {
      appId: APP, instanceDataDir: join(dataDir, 'apps', APP, INST), owner: OWNER, privateHome: true, runtime: 'container',
      identity: { uid: 1000, gid: 1000, range: 'owner', userId: OWNER, userApp: true },
    } : null),
    appHome: async () => ({ kind: 'private', hostPath: join(dataDir, 'aura/home/default'), volumeSubpath: 'aura/home/default', logicalPath: '/home/aura', uid: 1000, gid: 1000, mode: 0o700 }),
    ownerEnvironment: async (_i, tpl) => { asked.push(tpl); return authorized; },
    requireNetwork: () => undefined,
  });
  return { mgr, INST, asked };
}

test('SidecarManager: an authorized owner-environment sidecar of a private instance gets the Private Home as the user', async (t) => {
  const containers = fakeDocker(t);
  const { mgr, INST, asked } = sidecarFixture(t, { template: { name: 'terminal', image: 'ghcr.io/x/term', home: 'owner-environment' }, authorized: true });
  const res = await mgr.spawn(INST, { template: 'terminal' }, { instanceId: INST });
  assert.equal(res.created, true);
  assert.deepEqual(asked, ['terminal']);
  const args = containers.get(`aura-${INST}--terminal`).args;
  const at = (f) => args.flatMap((a, i) => (args[i - 1] === f ? [a] : []));
  assert.deepEqual(at('--user'), ['1000:1000']);
  assert.ok(at('--cap-drop').includes('ALL'));
  assert.ok(at('--mount').some((m) => m.includes('volume-subpath=aura/home/default') && m.includes('target=/home/aura')));
  assert.ok(at('-e').includes('HOME=/home/aura'));
});

test('SidecarManager L5: a sidecar without its grant gets no home (not created); an App Home sidecar of a private instance is refused', async (t) => {
  const containers = fakeDocker(t);
  const a = sidecarFixture(t, { template: { name: 'terminal', image: 'ghcr.io/x/term', home: 'owner-environment' }, authorized: false });
  await assert.rejects(a.mgr.spawn(a.INST, { template: 'terminal' }, { instanceId: a.INST }),
    (e) => e.name === 'PrivateHomeSidecarError' && e.code === 'requirement-unauthorized' && e.body.missing[0] === 'home.private.sidecar:terminal');
  const b = sidecarFixture(t, { template: { name: 'terminal', image: 'ghcr.io/x/term', inheritHome: true }, authorized: true });
  await assert.rejects(b.mgr.spawn(b.INST, { template: 'terminal' }, { instanceId: b.INST }), (e) => e.code === 'requirement-unsupported');
  assert.deepEqual(b.asked, [], 'never asked: not an owner-environment sidecar');
  const c = sidecarFixture(t, { template: { name: 'terminal', image: 'ghcr.io/x/term', home: 'owner-environment', capabilities: ['NET_ADMIN'] }, authorized: true });
  await assert.rejects(c.mgr.spawn(c.INST, { template: 'terminal' }, { instanceId: c.INST }), (e) => e.code === 'requirement-unsupported' || e.status === 403);
  // A shared listener of a private instance is refused before anything (net-iso2).
  const d = sidecarFixture(t, { template: { name: 'webui', image: 'ghcr.io/x/webui' }, authorized: true });
  await assert.rejects(d.mgr.spawn(d.INST, { template: 'webui' }, { instanceId: d.INST }), /shared app network/);
  assert.equal(containers.size, 0, 'nothing was created');
});

