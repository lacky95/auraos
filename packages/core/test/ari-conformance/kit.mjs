// The ARI conformance kit, layer 1 (Phase 5b; plan §4.2): the contract rows
// every runtime module passes, in process, with no Docker. Started by stream K
// (descriptor, capabilities, settings, health, endpoint, fail closed with
// suggest); stream E adds the instance-operation, workload-token, G1 and A4
// rows; 5b E adds the instance-ops, workload-token (D89), A4, address-identity
// and G1 rows. The template for module contract tests (D97, Phases 7/8).
//
//   describeRuntime(name, makeModule, harness)
//     makeModule()      a fresh module (its runner may be a recording stub)
//     harness.settings  settings objects to exercise (default: the schema defaults)
//     harness.instance  an instance id the runner knows (endpoint row), optional
//     harness.groups    async (module) => void: exercises the module's groups on its
//                       harness (adoption list/adopt, sessions, workloads, usage, tools),
//                       optional; the shape rows below check what comes back
//     harness.instanceOps  (module, instanceId) => workload env: the runner really runs
//                       instances in process (the reference mock); enables the
//                       instance-ops and workload-token rows (5b E)
//
// Run via: node tools/run-tests.mjs --only=core (ari-conformance.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARI_VERSION, RUNTIME_ID_PATTERN, RUNTIME_VERSION_PATTERN, RUNTIME_CAPABILITY_KEYS, RUNTIME_BOOLEAN_CAPABILITIES,
  RuntimeRegistry, RuntimeCapabilityError, builtInRuntimeRecord, settingsDefaults, validateSettings, healthRefusal,
  requirementsOf, runtimeRefusal, RUNTIME_FEATURE_IDS, moduleFeatures, CATEGORY_OF_CODE, GROUP_FEATURE, groupMismatch,
} from '../../dist/index.js';
import { buildSpawnSpec } from '../../dist/runtimes/spawnSpec.js';

const EXEC_CODES = ['not-found', 'not-running', 'engine'];

const plain = (v) => JSON.parse(JSON.stringify(v));

export function describeRuntime(name, makeModule, harness = {}) {
  const settingsList = () => {
    const m = makeModule();
    return harness.settings ?? [settingsDefaults(m.descriptor.settingsSchema)];
  };

  test(`[ARI ${name}] descriptor: id pattern, semver version, ari <= ARI_VERSION, a settings version; plain data`, () => {
    const d = makeModule().descriptor;
    assert.match(d.id, RUNTIME_ID_PATTERN);
    assert.match(d.version, RUNTIME_VERSION_PATTERN);
    assert.ok(Number.isInteger(d.ari) && d.ari >= 1 && d.ari <= ARI_VERSION);
    assert.ok(Number.isInteger(d.settingsVersion) && d.settingsVersion >= 1);
    assert.equal(typeof d.title, 'string');
    assert.equal(typeof d.builtIn, 'boolean');
    assert.deepEqual(plain(d), d, 'the descriptor is JSON data (no functions)');
    assert.doesNotThrow(() => validateSettings(d.settingsSchema, {}));
  });

  test(`[ARI ${name}] a module with ari: ARI_VERSION + 1 is refused with "needs ARI n"`, () => {
    const m = makeModule();
    const reg = new RuntimeRegistry();
    assert.throws(() => reg.register({ ...m, descriptor: { ...m.descriptor, ari: ARI_VERSION + 1 } }),
      (e) => e.code === 'ari-unsupported' && new RegExp(`needs ARI ${ARI_VERSION + 1}`).test(e.message) && runtimeRefusal(e)?.code === 'ari-unsupported');
    assert.equal(reg.get(m.descriptor.id), undefined);
  });

  test(`[ARI ${name}] capabilities: an exhaustive, plain object under every settings`, () => {
    const m = makeModule();
    for (const settings of settingsList()) {
      const caps = m.capabilities(settings);
      assert.deepEqual(Object.keys(caps).sort(), [...RUNTIME_CAPABILITY_KEYS].sort(), 'every capability, no extra');
      for (const k of RUNTIME_BOOLEAN_CAPABILITIES) assert.equal(typeof caps[k], 'boolean', k);
      assert.ok(['none', 'ptrace', 'namespace', 'vm', 'remote'].includes(caps.isolation));
      assert.ok(['none', 'emulated', 'enforced'].includes(caps.identity));
      assert.ok(['shell-netns', 'bridge', 'remote'].includes(caps.network));
      assert.equal(caps.gpu, false, 'gpu is reserved');
      assert.deepEqual(plain(caps), caps);
    }
  });

  test(`[ARI ${name}] features: exhaustive over RUNTIME_FEATURE_IDS, valid values, plain data (D100 §12)`, () => {
    const m = makeModule();
    for (const settings of settingsList()) {
      const fs = moduleFeatures(m, settings);
      assert.deepEqual(fs.map((f) => f.id), [...RUNTIME_FEATURE_IDS]);
      for (const f of fs) {
        assert.ok(['supported', 'conditional', 'unsupported'].includes(f.support), f.id);
        if (f.applyMode) assert.ok(['live', 'restart-required', 'recreate-required'].includes(f.applyMode), f.id);
      }
      assert.deepEqual(plain(fs), fs);
    }
  });

  test(`[ARI ${name}] groups: present exactly when their feature is supported; a disagreeing module is refused (D100)`, () => {
    const m = makeModule();
    const settings = settingsList()[0];
    assert.equal(groupMismatch(m, moduleFeatures(m, settings)), null);
    for (const group of Object.keys(GROUP_FEATURE)) {
      const reg = new RuntimeRegistry();
      const flipped = { ...m };
      if (m[group] === undefined) flipped[group] = group === 'usage' ? async () => ({}) : {};
      else delete flipped[group];
      assert.throws(() => reg.register(flipped), (e) => e.code === 'invalid-descriptor' && new RegExp(`group ${group}`).test(e.message), group);
    }
  });

  test(`[ARI ${name}] group results are plain data: opaque refs, no PIDs or engine handles; terminal operation states`, async () => {
    const m = makeModule();
    if (m.adoption) {
      const list = await m.adoption.list();
      if (list) {
        for (const s of list) {
          assert.equal(typeof s.ref, 'string');
          assert.ok(!('pid' in s) && !('hostname' in s) && !('address' in s), 'no PID, container name or address at the contract');
          assert.deepEqual(plain(s), s);
        }
      }
    }
    if (m.sessions) for (const r of m.sessions.list()) { assert.ok(!('launcherPid' in r)); assert.deepEqual(plain(r), r); }
    if (m.usage) { const u = await m.usage({ instanceIds: [], sidecarIds: [] }); assert.ok(!(u instanceof Map)); assert.deepEqual(plain(u), u); }
    if (m.tools && harness.instance) {
      const r = m.tools.apply(harness.instance, { tools: [] });
      assert.ok(['applied', 'failed', 'unsupported', 'restart-required', 'recreate-required'].includes(r.state), 'a synchronous provider answers terminal states');
      if (r.error) assert.equal(r.error.category, CATEGORY_OF_CODE[r.error.code]);
      assert.deepEqual(plain(r), r);
    }
    for (const [id, a] of Object.entries(m.actions ?? {})) {
      assert.equal(typeof a.title, 'string', id);
      assert.equal(typeof a.mutating, 'boolean', id);
    }
    await harness.groups?.(m);
  });

  // 5b-2 D: the groups whose mechanism moved behind ARI (D-X, D-P, D-B, D-R/D-C, D-#11).
  test(`[ARI ${name}] moved groups: workloads exec/logs, logs, endpoints, build, diagnostics, orphans are functions; refusals carry a code`, async () => {
    const m = makeModule();
    const fn = (v, what) => assert.equal(typeof v, 'function', what);
    if (m.workloads) {
      fn(m.workloads.exec, 'workloads.exec');
      fn(m.workloads.logs, 'workloads.logs');
      // An exec into a workload that isn't there fails explicitly, with a neutral code (never a silent no-op).
      const spec = { argv: ['true'], tty: false, env: {}, cols: 80, rows: 24 };
      await assert.rejects(m.workloads.exec('no-such-workload', spec, () => {}), (e) => EXEC_CODES.includes(e.code), 'workloads.exec');
    }
    if (m.logs) fn(m.logs, 'logs');
    if (m.endpoints) { fn(m.endpoints.list, 'endpoints.list'); fn(m.endpoints.expose, 'endpoints.expose'); fn(m.endpoints.remove, 'endpoints.remove'); }
    if (m.build) { fn(m.build.build, 'build.build'); fn(m.build.provision, 'build.provision'); }
    for (const k of ['inspectWrites', 'workloadMounts', 'probeTools']) if (m.diagnostics?.[k] !== undefined) fn(m.diagnostics[k], `diagnostics.${k}`);
    if (m.orphans) {
      fn(m.orphans.scan, 'orphans.scan');
      const r = m.orphans.scan(new Set());
      assert.ok(Array.isArray(r.all) && Array.isArray(r.squatters));
      assert.deepEqual(plain(r), r);
    }
    if (m.tools && harness.instance) {
      const st = m.tools.status(harness.instance);
      assert.equal(typeof st.provisioned, 'boolean');
      assert.deepEqual(plain(st), st);
    }
  });

  // D106: resources.limits for build/check workloads. Supported → the build group refuses an invalid record with the
  // stable code before anything runs; unsupported → no build is ever handed limits there (the kernel fails closed).
  test(`[ARI ${name}] resources.limits (D106): declared honestly; an invalid limits record is refused (invalid-resource-limits) before running`, async () => {
    const m = makeModule();
    const f = moduleFeatures(m, settingsList()[0]).find((x) => x.id === 'resources.limits');
    assert.ok(['supported', 'conditional', 'unsupported'].includes(f.support));
    if (f.support === 'unsupported') return;
    assert.ok(m.build, 'limits are for build/check workloads: the build group is there');
    for (const bad of [{ cpus: 0 }, { memoryBytes: 1.5 }, { pids: -1 }, { cpus: Infinity }, { swap: 1 }]) {
      await assert.rejects(m.build.build({ appId: 'org.k.app', appDir: '/nonexistent', limits: bad }), (e) => e.code === 'invalid-resource-limits', JSON.stringify(bad));
    }
  });

  // Phase 6 D-M: the mounts group is the mechanism only; its shape is the contract.
  test(`[ARI ${name}] mounts (D-M): present exactly with mount.attach; attach/detach/table/verify/rootOf are functions`, () => {
    const m = makeModule();
    if (!m.mounts) return;
    for (const k of ['capable', 'idmapProbe', 'rootDir', 'hostPath', 'rootOf', 'attach', 'detach', 'table', 'verify']) assert.equal(typeof m.mounts[k], 'function', `mounts.${k}`);
    assert.deepEqual(Object.keys(m.mounts.capable()).filter((k) => !['ok', 'reason'].includes(k)), []);
  });

  test(`[ARI ${name}] A4 spec (buildSpawnSpec): a runtime without hostFilesystem gets no host path; one with it gets the spec as resolved`, () => {
    const m = makeModule();
    const caps = m.capabilities(settingsList()[0]);
    const context = {
      appDir: '/workspace/apps/org.k.app', instanceDataDir: '/data/apps/org.k.app/org.k.app-1', instanceToken: { token: 't', nonce: 'n' },
      home: { kind: 'app', mode: 'app', hostPath: '/data/aura/app-homes/i', path: '/home/aura' }, env: { A: '1' }, owner: 'default',
    };
    const spec = buildSpawnSpec({ instanceId: 'org.k.app-1', appId: 'org.k.app', port: 4100, manifest: { id: 'org.k.app' }, context }, caps);
    assert.deepEqual(plain(spec), spec, 'plain data');
    assert.equal(spec.instanceToken.token, 't', 'the token always (D89)');
    if (caps.hostFilesystem) {
      assert.equal(spec.appDir, context.appDir);
      assert.equal(spec.home.hostPath, context.home.hostPath);
    } else {
      assert.deepEqual([spec.appDir, spec.instanceDataDir, spec.home.hostPath], ['', '', null], 'no host path reaches it');
      assert.equal(JSON.stringify(spec).includes('/data/'), false);
    }
  });

  test(`[ARI ${name}] settings: schema defaults; unknown keys refused`, () => {
    const m = makeModule();
    const schema = m.descriptor.settingsSchema;
    assert.deepEqual(validateSettings(schema, {}), settingsDefaults(schema));
    assert.throws(() => validateSettings(schema, { 'no-such-setting': 1 }), (e) => e.code === 'invalid-settings');
  });

  test(`[ARI ${name}] health: {status, checks[]}, plain data; unavailable blocks resolve`, () => {
    const m = makeModule();
    for (const settings of settingsList()) {
      const h = m.health(settings);
      assert.ok(['ok', 'degraded', 'unavailable'].includes(h.status));
      assert.ok(Array.isArray(h.checks));
      for (const c of h.checks) assert.ok(typeof c.id === 'string' && typeof c.ok === 'boolean');
      assert.deepEqual(plain(h), h);
    }
    const reg = new RuntimeRegistry();
    const down = { ...m, health: () => ({ status: 'unavailable', checks: [{ id: 'probe', ok: false, detail: 'probe failed' }] }) };
    reg.register(down);
    const rec = { ...builtInRuntimeRecord(reg), enabled: [m.descriptor.id] };
    assert.throws(() => reg.resolve({ manifest: { id: 'org.k.app', sandbox: m.descriptor.id }, installationId: 'i', sourceMode: 'open', record: rec }),
      (e) => e.code === 'runtime-not-installed' && /probe failed/.test(e.message));
  });

  test(`[ARI ${name}] endpoint: an object or null, never a string`, () => {
    const m = makeModule();
    assert.equal(m.endpoint('no-such-instance'), null);
    if (harness.instance) {
      const e = m.endpoint(harness.instance);
      assert.ok(e && typeof e.host === 'string' && Number.isInteger(e.port));
      assert.deepEqual(plain(e), e);
    }
  });

  test(`[ARI ${name}] instance ops: spawn → endpoint object → isRunning; forceKill; exactly one onExit; kill after it is a no-op`, async (t) => {
    if (!harness.instanceOps) { t.skip('no in-process instances for this module (the VM kit runs them)'); return; }
    const m = makeModule();
    const r = m.runner;
    const id = 'org.k.app-9';
    const exits = [];
    await r.spawn(id, 'org.k.app', 4809, { id: 'org.k.app' }, { appDir: '', instanceDataDir: '', instanceToken: { token: 'tok-9', nonce: 'n-9' } });
    r.onExit(id, (code) => exits.push(code));
    assert.equal(r.isRunning(id), true);
    const e = m.endpoint(id);
    assert.ok(e && typeof e.host === 'string' && e.port === 4809, 'endpoint is an object with the spawned port');
    assert.deepEqual(Object.keys(e).filter((k) => !['host', 'port', 'address'].includes(k)), [], 'an endpoint is for dialing only (D88)');
    assert.equal(r.forceKill(id), true);
    assert.equal(r.isRunning(id), false);
    await r.kill(id);
    assert.equal(exits.length, 1, 'exactly one exit report (G1: the kernel turns it into the events)');
    assert.equal(r.forceKill(id), false, 'nothing left to kill');
  });

  test(`[ARI ${name}] workload token (D89): the workload gets AURA_INSTANCE_TOKEN; adoption carries its nonce; no token, no start`, async (t) => {
    if (!harness.instanceOps) { t.skip('the golden argv pins it for the built-ins (ari-conformance.test.mjs)'); return; }
    const m = makeModule();
    const id = 'org.k.app-8';
    await m.runner.spawn(id, 'org.k.app', 4808, { id: 'org.k.app' }, { appDir: '', instanceDataDir: '', instanceToken: { token: 'tok-8', nonce: 'n-8' } });
    assert.equal(harness.instanceOps(m, id).AURA_INSTANCE_TOKEN, 'tok-8');
    if (m.adoption) {
      const s = (await m.adoption.list())?.find((x) => x.instanceId === id);
      assert.equal(s?.tokenNonce, 'n-8', 'the nonce survives (a survivor without one is never adopted)');
      assert.ok(!('token' in s), 'never the token itself');
    }
    await assert.rejects(m.runner.spawn('org.k.app-7', 'org.k.app', 4807, { id: 'org.k.app' }, { appDir: '', instanceDataDir: '' }), 'a start without a token is refused');
    m.runner.forceKill(id);
  });

  test(`[ARI ${name}] A4: without hostFilesystem, every host-bound manifest feature is refused naming hostFilesystem`, (t) => {
    const m = makeModule();
    const caps = m.capabilities(settingsList()[0]);
    if (caps.hostFilesystem) { t.skip('declares hostFilesystem'); return; }
    const reg = new RuntimeRegistry();
    reg.register(m);
    const rec = { ...builtInRuntimeRecord(reg), enabled: [m.descriptor.id] };
    const rows = [
      { tools: ['docker'] },
      { services: [{ name: 'db', image: 'redis:7', inheritDockerSocket: true }] },
      { ports: { hostPublish: [{ port: 80 }] } },
      { permissions: ['apps.mount'] },
      { services: [{ name: 'db', image: 'redis:7', privileged: true }] },
    ];
    for (const extra of rows) {
      const manifest = { id: 'org.k.app', sandbox: m.descriptor.id, ...extra };
      assert.throws(() => reg.resolve({ manifest, installationId: 'i', sourceMode: 'open', record: rec }),
        (e) => e.code === 'capability-missing' && e.missing.includes('hostFilesystem'), JSON.stringify(extra));
    }
  });

  test(`[ARI ${name}] no address identity (D89): nothing the module reports identifies a workload by its address`, async () => {
    const m = makeModule();
    const caps = m.capabilities(settingsList()[0]);
    assert.ok(!Object.keys(caps).some((k) => /address|network.?identity/i.test(k)), 'no capability offers address identity');
    for (const f of moduleFeatures(m, settingsList()[0])) assert.ok(!/identity/i.test(JSON.stringify(f.constraints ?? {})) || f.id === 'workload.identityInheritance', f.id);
    if (m.adoption) for (const s of (await m.adoption.list()) ?? []) assert.ok(!('address' in s) && !('addresses' in s), 'a survivor is matched by token nonce, never by address');
  });

  test(`[ARI ${name}] fail closed: every capability it lacks refuses the request that needs it, with capability-missing and suggest`, () => {
    const m = makeModule();
    const reg = new RuntimeRegistry();
    reg.register(m);
    const settings = settingsList()[0];
    const caps = m.capabilities(settings);
    const rec = { ...builtInRuntimeRecord(reg), enabled: [m.descriptor.id] };
    if (healthRefusal(m.health(settings))) return; // an unavailable runtime refuses everything (row above)
    const rows = [
      ['sidecars', { services: [{ name: 'db', image: 'redis:7' }] }, 'open'],
      ['portExpose', { ports: { exposes: [{ sourceApp: 'org.k.src', sourcePort: 80 }] } }, 'open'],
      ['readOnlyBinds', {}, 'closed'],
      ['mounts', { permissions: ['apps.mount'] }, 'open'],
      ['hostFilesystem', { tools: ['docker'] }, 'open'],
      ['warmPool', { warmPool: 1 }, 'open'],
    ];
    for (const [cap, extra, sourceMode] of rows) {
      if (caps[cap]) continue;
      const manifest = { id: 'org.k.app', sandbox: m.descriptor.id, ...extra };
      assert.ok(requirementsOf(manifest, { sourceMode }).capabilities.includes(cap), `${cap} is derived`);
      assert.throws(() => reg.resolve({ manifest, installationId: 'i', sourceMode, record: rec }),
        (e) => e instanceof RuntimeCapabilityError && e.code === 'capability-missing' && e.missing.includes(cap) && Array.isArray(e.suggest)
          && runtimeRefusal(e)?.category === CATEGORY_OF_CODE['capability-missing'],
        `${cap} fails closed`);
    }
  });
}
