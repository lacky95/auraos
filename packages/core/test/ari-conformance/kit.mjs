// The ARI conformance kit, layer 1 (Phase 5b; plan §4.2): the contract rows
// every runtime module passes, in process, with no Docker. Started by stream K
// (descriptor, capabilities, settings, health, endpoint, fail closed with
// suggest); stream E adds the instance-operation, workload-token, G1 and A4
// rows. The template for module contract tests (D97, Phases 7/8).
//
//   describeRuntime(name, makeModule, harness)
//     makeModule()      a fresh module (its runner may be a recording stub)
//     harness.settings  settings objects to exercise (default: the schema defaults)
//     harness.instance  an instance id the runner knows (endpoint row), optional
//     harness.groups    async (module) => void: exercises the module's groups on its
//                       harness (adoption list/adopt, sessions, workloads, usage, tools),
//                       optional; the shape rows below check what comes back
//
// Run via: node tools/run-tests.mjs --only=core (ari-conformance.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARI_VERSION, RUNTIME_ID_PATTERN, RUNTIME_VERSION_PATTERN, RUNTIME_CAPABILITY_KEYS, RUNTIME_BOOLEAN_CAPABILITIES,
  RuntimeRegistry, RuntimeCapabilityError, builtInRuntimeRecord, settingsDefaults, validateSettings, healthRefusal,
  requirementsOf, runtimeRefusal, RUNTIME_FEATURE_IDS, moduleFeatures, CATEGORY_OF_CODE, GROUP_FEATURE, groupMismatch,
} from '../../dist/index.js';

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
