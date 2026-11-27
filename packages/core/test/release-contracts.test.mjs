// Phase 6 Stage 1b (6B.0): the frozen release and D94 contracts against their dependency-free twins.
// core release/paths.ts = os/release/layout.mjs (one path list, D36); release/types.ts value lists =
// os/release-verify.mjs and builder.mjs; infra/types.ts = os/infra. Plus the D64 entries, the approval
// action and the infra propagation stubs ("no config = today", fail closed with one).
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tmp } from './release-fixtures.mjs';
import * as P from '../dist/release/paths.js';
import * as T from '../dist/release/types.js';
import * as I from '../dist/infra/types.js';
import { InfraPropagationError, buildSecrets, infraExecEnv, renderDigest } from '../dist/infra/propagate.js';
import { securityOption, POLICY_OPTION_IDS, UPDATE_CHANNEL, SECURITY_UPDATE_POLICY, RELEASE_AUTO_UPDATE, RELEASE_TRUSTED_KEYS } from '../dist/security/options.js';
import { APPROVAL_ACTIONS, APPROVAL_CLASS, approvalClassOf } from '../dist/approvals/types.js';

const L = await import(join(ROOT, 'os/release/layout.mjs'));
const V = await import(join(ROOT, 'os/release-verify.mjs'));
const B = await import(join(ROOT, 'os/release/builder.mjs'));
const INFRA = await import(join(ROOT, 'os/infra/config.mjs'));
const RENDER = await import(join(ROOT, 'os/infra/render.mjs'));
const STORE = await import(join(ROOT, 'os/infra/store.mjs'));
const ADAPTERS = await import(join(ROOT, 'os/infra/adapters/index.mjs'));

const shown = (v) => (v instanceof RegExp ? `re:${v.source}/${v.flags}` : typeof v === 'function' ? 'fn' : v);

test('release/paths.ts is the twin of os/release/layout.mjs: the same exports, constants and regexes', () => {
  assert.deepEqual(Object.keys(P).filter((k) => k !== 'dataLayout').sort(), Object.keys(L).sort(), 'the same names (dataLayout: core only)');
  for (const k of Object.keys(L)) assert.deepEqual(shown(P[k]), shown(L[k]), k);
});

test('release/paths.ts layout() spells every path exactly as layout.mjs, and refuses the same bad ids', () => {
  const root = '/data';
  const a = P.layout(root), b = L.layout(root);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  const job = P.newJobId(new Date('2026-11-27T10:00:00.000Z'));
  assert.equal(job, L.newJobId(new Date('2026-11-27T10:00:00.000Z')));
  const args = { release: '0.1.0-abcdef123456-1234abcd', staging: job, job, jobFiles: job, overlayApp: 'com.example.notes' };
  for (const k of Object.keys(b)) {
    const v = typeof b[k] === 'function' ? [a[k](args[k]), b[k](args[k])] : [a[k], b[k]];
    assert.equal(v[0], v[1], k);
  }
  assert.equal(a.overlayApp('com.example.notes'), '/data/aura/overlay/apps/com.example.notes.json');
  assert.equal(a.overlayCapabilities, '/data/aura/overlay/capabilities.yaml');
  assert.equal(a.trustedKeys, '/data/aura/release/trusted-keys');
  for (const bad of ['../x', 'a/b', '', '.staging-x']) assert.throws(() => a.release(bad)), assert.throws(() => b.release(bad));
  for (const bad of ['..', 'a/b', '', '../etc', 'a..b']) assert.throws(() => a.overlayApp(bad), bad), assert.throws(() => b.overlayApp(bad), bad);
  assert.throws(() => a.job('2026'));
  assert.equal(P.subpathOf('/data', '/data/aura/pnpm-store'), L.subpathOf('/data', '/data/aura/pnpm-store'));
  assert.throws(() => P.subpathOf('/data', '/data/../etc'));
  assert.equal(P.dataLayout({ AURA_DATA_DIR: '/d' }).pointer, '/d/aura/release/pointer.json');
});

test('release/types.ts value lists = the verifier and the builder (channel signed|main, maturity floor alpha)', () => {
  assert.deepEqual([...T.RELEASE_CHANNELS], [...V.CHANNELS]);
  assert.deepEqual([...T.RELEASE_MATURITIES], [...V.MATURITIES]);
  assert.deepEqual([...T.RELEASE_PROVENANCES], [...V.PROVENANCES]);
  assert.deepEqual([...T.SECURITY_SEVERITIES], [...V.SEVERITIES]);
  assert.equal(T.RELEASE_META_VERSION, V.META_VERSION);
  assert.equal(T.RELEASE_RECORD_VERSION, B.RELEASE_RECORD_VERSION);
  assert.equal(T.DEFAULT_RELEASE_CHANNEL, 'signed');
  assert.equal(T.DEFAULT_MATURITY_FLOOR, 'alpha');
  assert.deepEqual([...T.SECURITY_UPDATE_POLICIES], ['follow-signed', 'hold']);
});

test('infra/types.ts constants = os/infra (config version, render version, store, render root, secret ids)', () => {
  assert.equal(I.INFRA_CONFIG_VERSION, INFRA.INFRA_CONFIG_VERSION);
  assert.equal(I.RENDER_VERSION, RENDER.RENDER_VERSION);
  assert.equal(join('/data', I.INFRA_DIR), STORE.infraDir('/data'));
  assert.equal(I.INFRA_ROOT, ADAPTERS.INFRA_ROOT);
  assert.deepEqual([...I.BUILD_SECRET_IDS], [...ADAPTERS.BUILD_SECRET_IDS]);
});

test('infra propagation (IC-5): no config = today (empty env, no secrets); an unreadable render is refused, not ignored', async () => {
  const data = tmp('b0-infra');
  assert.equal(renderDigest(data), null);
  assert.deepEqual(infraExecEnv('release-build', { dataDir: data }), {});
  const s = await buildSecrets({ jobDir: join(data, 'job'), dataDir: data });
  assert.deepEqual(s.secrets, {});
  await s.dispose();
  const hex = 'a'.repeat(64);
  mkdirSync(join(data, I.INFRA_GENERATED_DIR, hex), { recursive: true });
  symlinkSync(hex, join(data, I.INFRA_CURRENT_LINK));
  assert.equal(renderDigest(data), `sha256:${hex}`);
  // A rendered dir without its manifest: fail closed (a spawn or build without the configured proxy/CA would go public).
  assert.throws(() => infraExecEnv('app', { dataDir: data }), (e) => e instanceof InfraPropagationError && e.code === 'infra-not-propagated');
  await assert.rejects(buildSecrets({ jobDir: join(data, 'job'), dataDir: data }), (e) => e.code === 'infra-not-propagated');
});

test('D64: the release update options (Stage 1b): signed|main default signed at fresh; hold; reserved; the key record', () => {
  const ch = securityOption(UPDATE_CHANNEL);
  assert.deepEqual([ch.type, ch.values, ch.default, ch.source, ch.change], ['enum', ['signed', 'main'], 'signed', 'policy', 'fresh']);
  assert.deepEqual([...ch.values], [...T.RELEASE_CHANNELS]);
  const sp = securityOption(SECURITY_UPDATE_POLICY);
  assert.deepEqual([sp.values, sp.default, sp.source, sp.change], [[...T.SECURITY_UPDATE_POLICIES], 'follow-signed', 'policy', 'fresh']);
  assert.equal(securityOption(RELEASE_AUTO_UPDATE).source, 'reserved');
  const keys = securityOption(RELEASE_TRUSTED_KEYS);
  assert.deepEqual([keys.source, keys.record, keys.change], ['record', P.TRUSTED_KEYS_DIR, 'fresh']);
  assert.ok(POLICY_OPTION_IDS.includes(UPDATE_CHANNEL) && POLICY_OPTION_IDS.includes(SECURITY_UPDATE_POLICY));
});

test('approval system.release.activate: in the closed catalog, forced (D102: it activates code)', () => {
  assert.ok(APPROVAL_ACTIONS.includes('system.release.activate'));
  assert.equal(APPROVAL_CLASS['system.release.activate'], 'forced');
  assert.equal(approvalClassOf('system.release.activate', { op: 'shell-mode' }), 'forced');
});
