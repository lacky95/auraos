// D108 P3v (7c integration verification): the real engine at AppManager's and SidecarManager's
// seams. Owner items: 1 profile-added permissions, tools and Context keys enforced through the
// existing authorization (PermissionManager, the Authorizer's `declared`, the granted Context,
// the live tools refresh); 3 the effective sidecar configuration reaches SidecarManager
// (Open WebUI personal-private, a fake docker); 8 the warm pool skips a Private Home app quietly.
//
//   node tools/run-tests.mjs --only=packages/core
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppManifestSchema } from '../dist/types/manifest.js';
import { Authorizer } from '../dist/auth/Authorizer.js';
import { SidecarManager } from '../dist/app-manager/SidecarManager.js';
import { containerSidecars } from '../dist/runtimes/container/sidecars.js';
import { InstanceTokens } from '../dist/app-manager/InstanceTokens.js';
import { kvHarness, world, fakeStarter, openWebui, OPERATOR, OWNER } from './setup-verify-world.mjs';

const h = kvHarness();
before(() => h.start());
after(() => h.stop());
beforeEach(() => h.reset());

/** A real AppManager over `raw` (written as the app's manifest) with the world's real engine as `opts.setup`. */
async function managerFor(w, raw, extra = {}) {
  const { AppManager } = await import('../dist/app-manager/AppManager.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-setup-verify-mgr-'));
  mkdirSync(join(root, 'apps', w.appId), { recursive: true });
  writeFileSync(join(root, 'apps', w.appId, 'app.manifest.json'), JSON.stringify(raw));
  const dataDir = join(root, 'mgr');
  const rootfs = join(root, 'rootfs'); mkdirSync(rootfs);
  const mgr = new AppManager({ appsDir: join(root, 'apps'), dataDir, baseRootfs: rootfs, toolchainDir: join(dataDir, 'tc'), setup: () => w.svc, ...extra });
  const sys = mgr.scopeRegistry.getAll().find((s) => s.id === 'system');
  mgr.registry.loadManifestFile(join(root, 'apps', w.appId, 'app.manifest.json'), sys);
  mgr.installationIdOf = async () => w.installationId;
  return mgr;
}

// ── item 1: profile-added requests through the existing authorization ──────

const powerRaw = () => ({
  id: 'com.example.power', name: 'Power', version: '1.0.0', auraContract: 1,
  profiles: [{ id: 'power', title: 'Power', overlay: { permissions: ['apps.mount'], tools: ['git'], context: ['API_KEY'] } }],
});

test('item 1: a profile\'s permission, tool and Context key count only while the setup that approved them is ready', async () => {
  const w = await world(h, AppManifestSchema.parse(powerRaw()));
  const applied = [];
  const mgr = await managerFor(w, powerRaw(), {
    context: {
      systemGranted: async () => true, vaultGranted: async () => false,
      systemEnv: async (keys) => Object.fromEntries(keys.map((k) => [k, `value-of-${k}`])), systemValue: async () => null, vaultValue: async () => null,
    },
  });
  const appId = w.appId;
  const instanceId = `${appId}-1`;
  mgr.instances.set(instanceId, { instanceId, appId, state: 'started', sandbox: 'container', owner: 'default' });
  mgr.moduleOf = () => ({ tools: { apply: (id, { tools }) => { applied.push([...tools]); return { state: 'applied', target: { instanceId: id } }; } } });
  mgr.osSidecars.refreshTools = () => undefined;
  // compose.ts createAuthServices: `declared` = AppManager.effectiveManifest(appId).permissions.
  const authz = new Authorizer({ grants: h.grants, declared: (id) => mgr.effectiveManifest(id)?.permissions, appBinding: async () => ({ scope: 'system', installationId: w.installationId }) });
  const principal = { kind: 'instance', appId, instanceId, userId: 'default' };
  const sees = async () => {
    applied.length = 0;
    mgr.applyInstanceTools(appId);
    const ctx = await mgr.instanceContext(instanceId);
    return {
      permissionManager: mgr.permissions.hasPermission(appId, 'apps.mount'),
      authorizer: (await authz.authorize(principal, 'apps.mount')).allow,
      tools: applied[0]?.includes('git') ?? false,
      contextKnown: ctx.known.has('API_KEY'),
      contextEnv: 'API_KEY' in ctx.env,
    };
  };
  const none = { permissionManager: false, authorizer: false, tools: false, contextKnown: false, contextEnv: false };
  const all = { permissionManager: true, authorizer: true, tools: true, contextKnown: true, contextEnv: true };

  assert.deepEqual(await sees(), none, 'not set up: nothing of the profile counts');
  const r = await w.svc.apply(appId, { profile: 'power' }, OWNER);
  assert.equal(r.status, 'on-hold');
  assert.deepEqual(await sees(), none, 'requested, not approved: requests never grant');
  await h.approvals.approve(r.approvalId, OPERATOR);
  assert.deepEqual(await sees(), none, 'approved, not yet applied');
  assert.equal((await w.svc.resume(appId, OWNER)).status, 'ready');
  assert.deepEqual(await sees(), all, 'ready: PermissionManager, the Authorizer, the tools refresh and the Context see them');

  // A kernel restart: the effective view of the ready app comes back on recovery, before any start.
  const svc = w.restart();
  const mgr2 = await managerFor(w, powerRaw());
  assert.equal(mgr2.setup, svc);
  await svc.recover();
  assert.ok(mgr2.effectiveManifest(appId).permissions.includes('apps.mount') && mgr2.permissions.hasPermission(appId, 'apps.mount'));
  w.svc = svc;

  // Blocked (the Context grant revoked): nothing of the profile counts any more.
  await h.grants.revoke({ kind: 'app', id: appId }, 'context.read:API_KEY');
  await svc.recheck(appId);
  assert.equal((await w.summary()).state, 'blocked');
  const mgr3 = await managerFor(w, powerRaw());
  assert.equal(mgr3.permissions.hasPermission(appId, 'apps.mount'), false);
  assert.deepEqual(mgr3.effectiveManifest(appId), mgr3.registry.getById(appId), 'a blocked app reads its base declarations only');
});

// ── item 3: the effective sidecar configuration reaches SidecarManager ─────

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

/** Open WebUI ready with personal-private (setup-verify.test.mjs `privateOwui`, inlined). */
async function privateOwui(raw = openWebui()) {
  const w = await world(h, AppManifestSchema.parse(raw), { starter: fakeStarter({ onSetup: () => ({ ok: true }) }) });
  const r = await w.svc.apply(w.appId, { profile: 'personal-private' }, OWNER);
  assert.equal(r.status, 'on-hold', JSON.stringify(r.error));
  await h.approvals.approve(r.approvalId, OPERATOR);
  await w.svc.resume(w.appId, OWNER);
  await w.svc.settled();
  assert.equal((await w.summary()).state, 'ready');
  return w;
}

function sidecars(w, { effective }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-setup-verify-sc-'));
  const INST = `${w.appId}-1`;
  const runner = {
    sidecarRuntime: () => ({ dataDir, appDataVolume: 'appvol', nodeModulesVolume: 'nm', network: 'aura-net',
      osApiBase: 'http://aura-shell:3000', shellHostname: 'aura-shell', workspaceRoot: '/ws', toolsMode: 'hardlink' }),
    mountRootDir: (k) => join(dataDir, 'aura', 'mounts', k),
    mountRootSubpath: (k) => `aura/mounts/${k}`,
    isolatedNetwork: (id) => `aura-inst-${id}`,
    toolsDir: (k) => join(dataDir, 'aura', 'runtime', k, 'tools'),
    clearToolsDir: () => undefined,
  };
  const port = w.spawnPort();
  const mgr = new SidecarManager({
    runner, workloads: containerSidecars(runner, { baseImage: 'aura-base' }),
    registry: { getById: (id) => (id === w.appId ? w.manifest : undefined) },
    permissions: { hasPermission: () => false },
    tokens: new InstanceTokens(join(dataDir, 'aura', 'secrets', 'k')),
    mounts: { reapplyConsumer: async () => ({ restored: 0, inherited: 0, failed: 0 }), removeAll: () => undefined, forgetConsumer: () => undefined },
    context: async () => ({ env: {}, known: new Set() }),
    // AppManager: a private instance runs as its user (identity A).
    instance: (id) => (id === INST ? {
      appId: w.appId, instanceDataDir: join(dataDir, 'apps', w.appId, INST), owner: 'default', privateHome: true, runtime: 'container',
      identity: { uid: 1000, gid: 1000, range: 'owner', userId: 'default', userApp: true },
    } : null),
    appHome: async () => ({ kind: 'private', hostPath: join(dataDir, 'aura/home/default'), volumeSubpath: 'aura/home/default', logicalPath: '/home/aura', uid: 1000, gid: 1000, mode: 0o700 }),
    // AppManager's wiring: P9's spawn port (compose privateHomeForSpawn), P4's values, the engine's view.
    ownerEnvironment: async (_i, tpl) => port.sidecarAuthorized(w.appId, 'default', tpl),
    setupValues: async () => w.svc.sidecarValues(w.appId),
    ...(effective ? { effectiveManifest: (appId, base) => w.svc.manifestView(appId, base) } : {}),
    requireNetwork: () => undefined,
  });
  return { mgr, INST };
}

test('item 3: Open WebUI personal-private: the overlay\'s webui network and terminal home reach SidecarManager (authorized, not refused)', async (t) => {
  const w = await privateOwui();
  const containers = fakeDocker(t);
  const { mgr, INST } = sidecars(w, { effective: true });
  const at = (args, f) => args.flatMap((a, i) => (args[i - 1] === f ? [a] : []));
  await mgr.spawn(INST, { template: 'webui' }, { instanceId: INST });
  const webui = containers.get(`aura-${INST}--webui`).args;
  assert.ok(at(webui, '--network').includes(`aura-inst-${INST}`), `webui on the instance network (${at(webui, '--network')})`);
  await mgr.spawn(INST, { template: 'terminal' }, { instanceId: INST });
  const term = containers.get(`aura-${INST}--terminal`).args;
  assert.deepEqual(at(term, '--user'), ['1000:1000'], 'the owner-environment terminal runs as the user');
  assert.ok(at(term, '--mount').some((m) => m.includes('volume-subpath=aura/home/default') && m.includes('target=/home/aura')), 'with the Private Home');
});

test('item 3: without the effective view (the base\'s shared listener) the same spawn is refused', async (t) => {
  const w = await privateOwui();
  const containers = fakeDocker(t);
  const { mgr, INST } = sidecars(w, { effective: false });
  await assert.rejects(mgr.spawn(INST, { template: 'webui' }, { instanceId: INST }), /shared app network/);
  assert.equal(containers.size, 0);
});

// ── item 8: the warm pool and a Private Home app ────────────────────────────

test('item 8: a Private Home app is never warmed: skipped without a warning, before and after its gate is known; an App Home app still is', async (t) => {
  const raw = { ...openWebui(), instanceMode: 'multi', warmPool: 1 };
  const w = await privateOwui(raw);
  const svc = w.restart();   // the engine's memory is empty, as at boot before the first start
  const mgr = await managerFor(w, raw);
  assert.equal(mgr.setup, svc);
  const logs = [];
  for (const level of ['warn', 'error', 'log']) t.mock.method(console, level, (...a) => { logs.push([level, a.join(' ')]); });
  // Boot: the pool kick-off runs before the engine knows the app's effective configuration.
  mgr.scheduleRefill(w.appId);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mgr.getInstancesByApp(w.appId).length, 0, 'no pool member');
  assert.equal(mgr.refillInFlight.get(w.appId) ?? 0, 0);
  assert.equal(svc.effectiveHome(w.appId), 'private', 'its gate validated it on the way');
  await assert.rejects(mgr.spawnInstance(w.appId, { inPool: true }), (e) => e.name === 'PrivateHomePoolSkip', 'a pool spawn is a skip, not a spawn');
  let spawns = 0;
  mgr.spawnInstance = async () => { spawns++; throw new Error('should not spawn'); };
  mgr.scheduleRefill(w.appId);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(spawns, 0, 'known private: the refill is not even tried');
  assert.deepEqual(logs.filter(([l, m]) => (l === 'warn' || l === 'error') && m.includes(w.appId)), [], 'no warning or error');
  t.mock.restoreAll();

  // Control: the same app with the App Home profile keeps its pool.
  await h.reset();
  const ww = await world(h, AppManifestSchema.parse(raw), { starter: fakeStarter({ onSetup: () => ({ ok: true }) }) });
  await ww.svc.apply(ww.appId, { profile: 'personal' }, OWNER);
  await ww.svc.settled();
  assert.equal((await ww.summary()).state, 'ready');
  const m2 = await managerFor(ww, raw);
  let tried = 0;
  m2.spawnInstance = async () => { tried++; return 'x'; };
  m2.scheduleRefill(ww.appId);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tried, 1, 'an App Home app is warmed as before');
});
