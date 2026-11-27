// D108 P1: the setup resolver. `resolveEffective()` (merge rules §2.4 1–7,
// `when`, the overlay allowlist, `instanceScope: shared` refused), requirement
// evaluation through the ports, the digests, `autoSelectableProfile` and
// `profileOptions`. Golden: an app without setup/profiles resolves trivially
// and its effective manifest view is its base. Never a fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/index.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { featuresOf, RUNTIME_FEATURE_IDS } from '../dist/runtimes/ari.js';

const {
  resolveEffective, autoSelectableProfile, profileOptions, effectiveManifestView, tightenField,
  configDigestOf, grantDigestOf, FEATURE_OF_NEED, declaresSetup,
} = core;

// The worked example (review §2.6), as in setup-contracts.test.mjs `openWebui()`.
const openWebui = () => ({
  id: 'io.lakner.openwebui', name: 'Open WebUI', version: '0.2.0', sandbox: 'container', environmentScope: 'user',
  homeEnvironments: { supported: ['app', 'private'], recommended: 'app', reason: 'uses your agent logins in the terminal sidecar' },
  services: [
    { name: 'webui', image: 'ghcr.io/open-webui/open-webui:main', port: 8080, env: {
      WEBUI_AUTH: { fromSetup: 'auth', map: { native: 'True', aura: 'False' } },
      WEBUI_ADMIN_PASSWORD: { fromSecret: 'adminPassword' },
      WEBUI_SECRET_KEY: { fromSecret: 'sessionKey' },
      PLAIN: 'x',
    } },
    { name: 'terminal', image: 'ghcr.io/example/terminal:1', inheritHome: true, env: { TERMINAL_KEY: { fromSecret: 'terminalKey' } } },
  ],
  setup: {
    version: 1,
    fields: {
      auth: { type: 'string', enum: ['native', 'aura'], default: 'native', title: 'Sign-in' },
      adminPassword: { type: 'secret', title: 'Admin password', secret: { source: 'generate', length: 24 }, when: { field: 'auth', in: ['native'] } },
      terminalKey: { type: 'secret', title: 'Terminal key', secret: { source: 'generate', length: 32 } },
      sessionKey: { type: 'secret', title: 'Session key', secret: { source: 'generate', length: 32 } },
    },
    requirements: [{ feature: 'network.isolation', level: 'required', when: { field: 'auth', in: ['aura'] }, reason: 'only an isolated network keeps other apps out' }],
    init: { hook: true },
  },
  profiles: [
    { id: 'personal', title: 'Personal (own logins)', recommended: true,
      overlay: { instanceScope: 'per-user', environmentScope: 'user', homeEnvironment: 'app' } },
    { id: 'personal-private', title: 'Personal, using my logins',
      overlay: { instanceScope: 'per-user', homeEnvironment: 'private',
        services: { terminal: { home: 'owner-environment', network: 'instance' }, webui: { network: 'instance' } } },
      setup: { requirements: [
        { grant: 'home.private', level: 'required' }, { grant: 'home.private.sidecar:terminal', level: 'required' },
        { feature: 'storage.privateHome', level: 'required' }, { feature: 'network.isolation', level: 'required' },
      ] } },
    { id: 'team', title: 'Shared for several users',
      overlay: { instanceScope: 'shared', environmentScope: 'global', homeEnvironment: 'app' },
      setup: { fields: { auth: { enum: ['native'] } } } },
  ],
});

const ALL = Object.fromEntries(RUNTIME_FEATURE_IDS.map((id) => [id, 'supported']));
const authKey = (r) => ({
  permission: () => `permission:${r.permission}`, tool: () => `tool:${r.tool}`, context: () => `context:${r.key}`,
  grant: () => r.grant, 'home-private': () => 'home.private', 'home-private-sidecar': () => `home.private.sidecar:${r.sidecar}`,
})[r.kind]();
const ports = ({ features = {}, grants = [], policy = { 'app-private-home': 'grant' }, caps = {}, calls } = {}) => ({
  runtimeFeatures: (id) => { calls?.push('runtimeFeatures'); return id === 'container' ? { ...ALL, ...features } : null; },
  defaultRuntime: () => { calls?.push('defaultRuntime'); return 'container'; },
  isAuthorized: (r) => { calls?.push(`isAuthorized:${authKey(r)}`); return grants.includes(authKey(r)); },
  capability: (n) => caps[n] ?? { installed: false, granted: false },
  policy: (id) => (id in policy ? policy[id] : null),
});
const NO_ISOLATION = { 'network.isolation': 'unsupported' };
const PRIVATE_GRANTS = ['home.private', 'home.private.sidecar:terminal'];

const desired = (profile, values = {}, secrets = {}, overrides = {}) => ({
  v: 1, setupVersion: 1, profile, values, secrets, overrides, updatedAt: '2026-11-27T00:00:00Z', updatedBy: 'user:owner',
});
const SECRETS = { adminPassword: 'vault:h-admin-1', terminalKey: 'vault:h-term-1', sessionKey: 'vault:h-sess-1' };
const input = (manifest, d, userDesired = null) => ({
  appId: manifest.id, installationId: 'inst-1', userId: 'owner', manifest, desired: d, userDesired,
});
const owui = () => AppManifestSchema.parse(openWebui());
const resolve = (d, p = ports(), m = owui(), u = null) => resolveEffective(input(m, d, u), p);
const codes = (r) => r.blocking.map((b) => b.error);

// ── golden: an app without setup/profiles ───────────────────────────────────

test('golden: an app without setup/profiles resolves trivially, consults no port, and its effective manifest view is the base', () => {
  const m = AppManifestSchema.parse({
    id: 'com.example.notes', name: 'Notes', version: '1.0.0', sandbox: 'container',
    permissions: ['zeta.read', 'apps.list'], tools: ['git', 'bash'], context: ['B_KEY', 'A_KEY'],
    services: [
      { name: 'db', image: 'postgres:16', env: { B: '2', A: '1' }, inheritHome: true, limits: { memory: '512m' } },
      { name: 'cache', image: 'valkey:8', env: {} },
    ],
  });
  assert.equal(declaresSetup(m), false);
  const throwing = new Proxy({}, { get: (_, k) => () => { throw new Error(`port ${String(k)} consulted`); } });
  const r = resolveEffective(input(m, null), throwing);
  assert.ok(r.effective, 'trivially effective');
  assert.deepEqual(r.fields, {});
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.degraded, []);
  assert.deepEqual(r.feasible.requirements, []);
  assert.equal(r.effective.profile, null);
  assert.equal(r.effective.homeEnvironment, 'app');
  assert.deepEqual(r.effective.ownerEnvironmentSidecars, []);
  // The golden: the effective view of the base is the base, key for key and in base order.
  const view = effectiveManifestView(m, r.effective);
  assert.deepEqual(view, m);
  assert.deepEqual(view.permissions, ['zeta.read', 'apps.list']);
  assert.equal(r.configDigest, r.effective.configDigest);
  assert.equal(resolveEffective(input(m, null), throwing).configDigest, r.configDigest, 'deterministic');
});

// ── Open WebUI: personal / personal-private / team ──────────────────────────

test('Open WebUI personal: effective with the defaults; the auth-conditional requirement is inactive; secrets by handle', () => {
  const r = resolve(desired('personal', {}, SECRETS), ports({ features: NO_ISOLATION }));
  assert.deepEqual(r.blocking, []);
  const e = r.effective;
  assert.ok(e);
  assert.equal(e.profile, 'personal');
  assert.deepEqual(e.values, { auth: 'native' });
  assert.deepEqual(Object.keys(e.secrets).sort(), ['adminPassword', 'sessionKey', 'terminalKey']);
  assert.equal(e.homeEnvironment, 'app');
  assert.equal(e.instanceScope, 'per-user');
  assert.deepEqual(e.networks, { webui: 'shared', terminal: 'shared' });
  assert.deepEqual(e.services.find((s) => s.name === 'terminal').home, 'app', 'inheritHome: true is home app');
  assert.equal(r.feasible.requirements.find((x) => x.requirement.feature === 'network.isolation' && x.requirement.when)?.status, 'inactive');
});

test('Open WebUI auth: aura needs network.isolation: blocked without it (no shared-network fallback), effective with it; adminPassword then does not exist', () => {
  const d = desired('personal', { auth: 'aura' }, SECRETS);
  const blocked = resolve(d, ports({ features: NO_ISOLATION }));
  assert.equal(blocked.effective, null);
  const b = blocked.blocking.find((x) => x.error === 'requirement-unsupported');
  assert.equal(b.category, 'unsupported-feature');
  assert.equal(b.manifestField, 'setup.requirements[0]');
  assert.deepEqual(b.missing, ['network.isolation']);
  assert.equal(blocked.requested.values.auth, 'aura', 'the request is kept, never weakened to native');

  const ok = resolve(d, ports());
  assert.ok(ok.effective);
  assert.equal('adminPassword' in ok.fields, false, 'when false: the field does not exist');
  assert.equal('adminPassword' in ok.effective.secrets, false);
  assert.deepEqual(Object.keys(ok.effective.secrets).sort(), ['sessionKey', 'terminalKey']);
});

test('Open WebUI team: refused fail closed (shared instances arrive with multi-user, BT-M2), listed unavailable, never picked', () => {
  const r = resolve(desired('team', {}, SECRETS));
  assert.equal(r.effective, null);
  const b = r.blocking.find((x) => x.error === 'requirement-unsupported');
  assert.equal(b.category, 'unsupported-feature');
  assert.match(b.message, /shared instances arrive with multi-user \(BT-M2\)/);
  assert.equal(b.manifestField, 'profiles[team].overlay.instanceScope');
  assert.equal(r.requested.instanceScope, 'shared', 'never run as per-user instead');
  assert.equal(r.feasible.ok, false);

  const opts = profileOptions(owui(), ports(), { installationId: 'inst-1', userId: 'owner' });
  const team = opts.find((o) => o.id === 'team');
  assert.equal(team.available, false);
  assert.ok(team.reasons.some((x) => /BT-M2/.test(x.message)));
  assert.deepEqual(opts.map((o) => [o.id, o.available, o.recommended]), [['personal', true, true], ['personal-private', true, false], ['team', false, false]]);
  assert.notEqual(autoSelectableProfile(owui(), ports(), { installationId: 'inst-1', userId: 'owner' }), 'team');
  // A desired override to shared is refused the same way.
  const o = resolve(desired('personal', {}, SECRETS, { instanceScope: 'shared' }));
  assert.equal(o.effective, null);
  assert.equal(o.blocking.find((x) => x.error === 'requirement-unsupported').target, 'overrides.instanceScope');
});

test('Open WebUI team tightens auth to native: aura is invalid there (tighten, never loosen)', () => {
  const r = resolve(desired('team', { auth: 'aura' }, SECRETS));
  assert.deepEqual(r.fields.auth.enum, ['native']);
  assert.deepEqual(r.values.fieldErrors, { auth: 'invalid value (one of: native)' });
  const body = r.blocking.find((x) => x.error === 'config-invalid');
  assert.equal(body.manifestField, 'setup.fields.auth');
  assert.equal(JSON.stringify(body).includes('"aura"'), false, 'the value is never echoed');
});

test('Open WebUI personal-private: blocked without the home grants (no Private→App fallback), effective with them', () => {
  const r = resolve(desired('personal-private', {}, SECRETS));
  assert.equal(r.effective, null);
  assert.equal(r.requested.homeEnvironment, 'private', 'desired stays private');
  const missing = r.authorized.missing.flatMap((x) => x.missing);
  assert.deepEqual(missing.sort(), ['home.private', 'home.private.sidecar:terminal']);
  for (const x of r.authorized.missing) {
    assert.equal(x.error, 'requirement-unauthorized');
    assert.match(x.manifestField, /^profiles\[personal-private\]\.setup\.requirements\[[01]\]$/);
    assert.deepEqual(x.suggest, ['personal'], 'other available profiles named, never picked');
  }
  assert.equal(r.profile, 'personal-private');

  const ok = resolve(desired('personal-private', {}, SECRETS), ports({ grants: PRIVATE_GRANTS }));
  assert.deepEqual(ok.blocking, []);
  assert.equal(ok.effective.homeEnvironment, 'private');
  assert.deepEqual(ok.effective.ownerEnvironmentSidecars, ['terminal']);
  assert.deepEqual(ok.effective.networks, { webui: 'instance', terminal: 'instance' });
  assert.equal(ok.effective.services.find((s) => s.name === 'terminal').home, 'owner-environment');
});

test('personal-private with app-private-home off: policy-refused naming the option, even with the grants; listed unavailable', () => {
  const p = ports({ grants: PRIVATE_GRANTS, policy: { 'app-private-home': 'off' } });
  const r = resolve(desired('personal-private', {}, SECRETS), p);
  assert.equal(r.effective, null);
  assert.equal(r.policy.ok, false);
  const b = r.policy.refusals[0];
  assert.equal(b.error, 'policy-refused');
  assert.equal(b.category, 'not-grantable');
  assert.equal(b.policy, 'app-private-home');
  assert.equal(b.manifestField, 'profiles[personal-private].overlay.homeEnvironment');
  assert.equal(r.requested.homeEnvironment, 'private', 'never a different configuration');
  const opt = profileOptions(owui(), p, { installationId: 'inst-1', userId: 'owner' }).find((o) => o.id === 'personal-private');
  assert.equal(opt.available, false);
  // An unset policy is not `grant`: fail closed.
  assert.equal(resolve(desired('personal-private', {}, SECRETS), ports({ grants: PRIVATE_GRANTS, policy: {} })).policy.ok, false);
});

test('personal-private needs storage.privateHome and network.isolation of the resolved runtime', () => {
  const r = resolve(desired('personal-private', {}, SECRETS), ports({ grants: PRIVATE_GRANTS, features: { 'storage.privateHome': 'conditional', ...NO_ISOLATION } }));
  assert.equal(r.effective, null);
  const missing = r.blocking.filter((x) => x.error === 'requirement-unsupported').flatMap((x) => x.missing);
  assert.deepEqual([...new Set(missing)].sort(), ['network.isolation', 'storage.privateHome'], 'conditional support does not count');
  // An unknown runtime (override) is not available at all.
  const u = resolve(desired('personal', {}, SECRETS, { sandbox: 'ghost' }), ports());
  assert.equal(u.effective, null);
  assert.ok(u.blocking.some((x) => /runtime ghost is not installed/.test(x.message)));
});

// ── profile selection (decision 3) ──────────────────────────────────────────

test('no selected profile: profile-required with suggestions; the resolver never picks; autoSelectableProfile only for exactly one input-free', () => {
  const r = resolve(null);
  assert.equal(r.effective, null);
  assert.deepEqual(codes(r), ['profile-required']);
  assert.equal(r.blocking[0].category, 'needs-setup');
  assert.deepEqual(r.blocking[0].suggest, ['personal', 'personal-private']);
  assert.equal(r.profile, null);

  const ctx = { installationId: 'inst-1', userId: 'owner' };
  assert.equal(autoSelectableProfile(owui(), ports(), ctx), 'personal', 'personal-private needs approvals, team is refused');
  assert.equal(autoSelectableProfile(owui(), ports({ grants: PRIVATE_GRANTS }), ctx), null, 'two input-free profiles: the owner chooses');

  const unknown = resolve(desired('ghost'));
  assert.deepEqual(codes(unknown).slice(0, 1), ['unknown-profile']);

  // A profile with a required asked value is not input-free; a required generated secret is.
  const m = AppManifestSchema.parse({
    id: 'com.example.two', name: 'Two', version: '1.0.0',
    setup: { fields: {
      host: { type: 'string', title: 'Host', when: { profile: ['remote'] }, required: true },
      key: { type: 'secret', title: 'Key', required: true, secret: { source: 'generate' } },
    } },
    profiles: [{ id: 'local', title: 'Local' }, { id: 'remote', title: 'Remote' }],
  });
  assert.equal(autoSelectableProfile(m, ports(), ctx), 'local');
  const local = resolveEffective(input(m, desired('local')), ports());
  assert.deepEqual(local.values.missing, ['key'], 'the resolver still reports the ungenerated secret');
});

test('an app without profiles but a selected profile in the record: unknown-profile', () => {
  const m = AppManifestSchema.parse({ id: 'com.example.s', name: 'S', version: '1.0.0', setup: { fields: { a: { type: 'boolean', title: 'A' } } } });
  const r = resolveEffective(input(m, desired('x')), ports());
  assert.deepEqual(codes(r), ['unknown-profile']);
  assert.ok(resolveEffective(input(m, desired(null)), ports()).effective);
});

// ── merge rules ─────────────────────────────────────────────────────────────

const mergeApp = (overlay = {}, extra = {}) => AppManifestSchema.parse({
  id: 'com.example.merge', name: 'Merge', version: '1.0.0', sandbox: 'container',
  permissions: ['b.perm', 'a.perm'], tools: ['git'], context: ['K1'],
  homeEnvironments: { supported: ['app', 'private'] },
  services: [{ name: 'svc', image: 'a:1', env: { A: '1', B: '2' }, inheritHome: true, limits: { memory: '256m' } }],
  setup: { fields: { mode: { type: 'string', title: 'Mode', enum: ['x', 'y'], default: 'x' } } },
  profiles: [{ id: 'p', title: 'P', overlay }],
  ...extra,
});

test('rule 2: requests are a sorted union, never a removal; added requests need authorization (requests never grant)', () => {
  const m = mergeApp({ permissions: ['c.perm', 'a.perm'], tools: ['jq'], context: ['K0'] });
  const r = resolveEffective(input(m, desired('p')), ports());
  assert.deepEqual(r.requested.permissions, ['a.perm', 'b.perm', 'c.perm']);
  assert.deepEqual(r.requested.tools, ['git', 'jq']);
  assert.deepEqual(r.requested.context, ['K0', 'K1']);
  assert.equal(r.effective, null);
  assert.deepEqual(r.authorized.missing.map((x) => x.missing[0]).sort(), ['context:K0', 'permission:c.perm', 'tool:jq']);
  assert.equal(r.authorized.missing.find((x) => x.missing[0] === 'permission:c.perm').manifestField, 'profiles[p].overlay.permissions');
  const calls = [];
  const ok = resolveEffective(input(m, desired('p')), ports({ grants: ['permission:c.perm', 'tool:jq', 'context:K0'], calls }));
  assert.ok(ok.effective);
  assert.equal(calls.some((c) => c === 'isAuthorized:permission:a.perm'), false, 'base requests are install-approved, not re-asked');
  const view = effectiveManifestView(m, ok.effective);
  assert.deepEqual(view.permissions, ['b.perm', 'a.perm', 'c.perm'], 'base order kept, additions appended');
});

test('rule 3: services merge by name with only the overlay keys; inheritHome is the alias of home app; a new template is refused', () => {
  const m = mergeApp({ services: { svc: { env: { B: '3', C: { fromSetup: 'mode' } }, home: 'none', network: 'instance', limits: { cpus: 1 } } } });
  const r = resolveEffective(input(m, desired('p')), ports());
  assert.ok(r.effective);
  const s = r.effective.services[0];
  assert.deepEqual(s.env, { A: '1', B: '3', C: { fromSetup: 'mode' } });
  assert.equal(s.home, 'none');
  assert.equal(s.network, 'instance');
  assert.deepEqual(s.limits, { memory: '256m', cpus: 1 });
  const view = effectiveManifestView(m, r.effective);
  assert.equal(view.services[0].home, 'none');
  assert.equal(view.services[0].inheritHome, false, 'the alias follows home');
  assert.equal(view.services[0].image, 'a:1', 'never an image change');
  // instance network → network.isolation, never the shared network instead.
  const blocked = resolveEffective(input(m, desired('p')), ports({ features: NO_ISOLATION }));
  assert.equal(blocked.effective, null);
  assert.equal(blocked.blocking[0].manifestField, 'profiles[p].overlay.services.svc.network');
  assert.equal(blocked.requested.networks.svc, 'instance');
  // An overlay naming no template (the schema refuses it; the resolver too, defensively).
  const raw = mergeApp();
  raw.profiles[0].overlay = { services: { added: { env: { A: '1' } } } };
  const added = resolveEffective(input(raw, desired('p')), ports());
  assert.equal(added.effective, null);
  assert.match(added.blocking[0].message, /can't add a sidecar/);
  assert.deepEqual(added.requested.services.map((x) => x.name), ['svc']);
});

test('rule 1: the overlay overrides base axes; desired overrides only the configurable keys; private needs the home declaration', () => {
  const m = mergeApp({ environmentScope: 'global', sandbox: 'container' });
  const r = resolveEffective(input(m, desired('p', {}, {}, { environmentScope: 'user', homeEnvironment: 'private' })), ports({ grants: ['home.private'] }));
  assert.equal(r.requested.environmentScope, 'user');
  assert.equal(r.requested.homeEnvironment, 'private');
  assert.ok(r.effective);
  const policyOrigin = resolveEffective(input(m, desired('p', {}, {}, { homeEnvironment: 'private' })), ports({ grants: ['home.private'], policy: {} }));
  assert.equal(policyOrigin.policy.refusals[0].target, 'overrides.homeEnvironment');

  const noHome = mergeApp({}, { homeEnvironments: undefined });
  const x = resolveEffective(input(noHome, desired('p', {}, {}, { homeEnvironment: 'private' })), ports({ grants: ['home.private'] }));
  assert.equal(x.effective, null);
  assert.equal(x.blocking[0].manifestField, 'homeEnvironments.supported');
  assert.equal(x.requested.homeEnvironment, 'private');
});

test('resources need enforced ARI resources.limits (D106): unenforced is refused, never applied unenforced', () => {
  const m = mergeApp({ resources: { memory: '2g', cpus: 2 } });
  const r = resolveEffective(input(m, desired('p')), ports({ features: { 'resources.limits': 'unsupported' } }));
  assert.equal(r.effective, null);
  assert.deepEqual(r.blocking[0].missing, ['resources.limits']);
  assert.equal(r.blocking[0].manifestField, 'profiles[p].overlay.resources');
  assert.deepEqual(resolveEffective(input(m, desired('p')), ports()).effective.resources, { memory: '2g', cpus: 2 });
});

test('requirementsOf() on the requested configuration: a profile adding apps.mount needs mount features of the runtime', () => {
  const m = mergeApp({ permissions: ['apps.mount'] });
  const r = resolveEffective(input(m, desired('p')), ports({ grants: ['permission:apps.mount'], features: { 'mount.attach': 'unsupported' } }));
  assert.equal(r.effective, null);
  assert.ok(r.blocking.some((b) => b.error === 'requirement-unsupported' && b.missing.includes('mount.attach')));
  assert.ok(resolveEffective(input(m, desired('p')), ports({ grants: ['permission:apps.mount'] })).effective);
});

test('FEATURE_OF_NEED follows the ARI table: each mapped feature turns with exactly its capability', () => {
  const caps = {
    isolation: 'namespace', network: 'bridge', appHome: true, privateHomeSession: true, sessionExec: true, identity: 'enforced',
    readOnlyBinds: true, hostFilesystem: true, mounts: true, idmappedMounts: true, portExpose: true, sidecars: true, warmPool: true,
    survivesShellRestart: true, usage: true, gpu: true, userNamespaces: true,
  };
  const support = (c, id) => featuresOf(c).find((f) => f.id === id).support;
  for (const [cap, feature] of Object.entries(FEATURE_OF_NEED)) {
    assert.equal(support(caps, feature), 'supported', feature);
    assert.equal(support({ ...caps, [cap]: false }, feature), 'unsupported', `${feature} follows ${cap}`);
  }
});

// ── fields: tighten, never loosen; when; scopes ─────────────────────────────

test('rule 4: tightenField narrows and never loosens', () => {
  const int = { type: 'integer', title: 'Port', minimum: 10, maximum: 100, default: 50 };
  assert.deepEqual(tightenField(int, { minimum: 20, maximum: 200 }), { ...int, minimum: 20, maximum: 100 });
  assert.deepEqual(tightenField(int, { minimum: 5 }), int, 'a wider minimum keeps the base');
  assert.equal(tightenField(int, { minimum: 60 }).default, undefined, 'a default outside the tightened range is dropped');
  const str = { type: 'string', title: 'S', enum: ['a', 'b'], default: 'b' };
  assert.deepEqual(tightenField(str, { enum: ['a', 'c'], required: true }), { type: 'string', title: 'S', enum: ['a'], required: true });
  assert.equal(tightenField({ ...str, required: true }, { required: false }).required, true, 'required is never dropped');
  assert.deepEqual(tightenField(str, { type: 'integer', title: 'S' }), str, 'a retype is ignored');
  const whenField = { type: 'boolean', title: 'B', scope: 'user', when: { field: 'x', equals: true } };
  assert.deepEqual(tightenField(whenField, { type: 'boolean', title: 'Other', scope: 'installation' }), whenField, 'when/scope/title stay');
});

test('rule 5: `when` after the merge on the desired values; an inactive field\'s value is dropped, an unknown one named', () => {
  const m = AppManifestSchema.parse({
    id: 'com.example.when', name: 'W', version: '1.0.0',
    setup: { fields: {
      mode: { type: 'string', title: 'Mode', enum: ['a', 'b'], default: 'a' },
      onlyB: { type: 'integer', title: 'Only B', required: true, when: { field: 'mode', equals: 'b' } },
      chained: { type: 'boolean', title: 'Chained', when: { field: 'onlyB', in: [1, 2] } },
    } },
  });
  const a = resolveEffective(input(m, desired(null, { onlyB: 'junk', chained: true })), ports());
  assert.deepEqual(Object.keys(a.fields), ['mode']);
  assert.ok(a.effective, 'values of inactive fields are not validated');
  assert.deepEqual(a.effective.values, { mode: 'a' });
  const b = resolveEffective(input(m, desired(null, { mode: 'b' })), ports());
  assert.deepEqual(b.values.missing, ['onlyB']);
  assert.equal(b.blocking[0].manifestField, 'setup.fields.onlyB');
  const c = resolveEffective(input(m, desired(null, { mode: 'b', onlyB: 2, chained: true })), ports());
  assert.deepEqual(c.effective.values, { mode: 'b', onlyB: 2, chained: true });
  const u = resolveEffective(input(m, desired(null, { nope: 1 })), ports());
  assert.deepEqual(u.values.fieldErrors, { nope: 'unknown field' });
});

test('user-scope values come from the user record only; a per-user value never becomes an installation value', () => {
  const m = AppManifestSchema.parse({
    id: 'com.example.user', name: 'U', version: '1.0.0',
    setup: { fields: {
      theme: { type: 'string', title: 'Theme', scope: 'user' },
      token: { type: 'secret', title: 'Token', scope: 'user', required: true, secret: { source: 'ask' } },
      site: { type: 'string', title: 'Site' },
    } },
  });
  const ok = resolveEffective(input(m, desired(null, { site: 's' }), desired(null, { theme: 'dark' }, { token: 'vault:u-1' })), ports());
  assert.ok(ok.effective);
  assert.deepEqual(ok.effective.values, { site: 's', theme: 'dark' });
  const crossed = resolveEffective(input(m, desired(null, { theme: 'dark' }, { token: 'vault:x' }), desired(null, { site: 's' })), ports());
  assert.equal(crossed.effective, null);
  assert.deepEqual(Object.keys(crossed.values.fieldErrors).sort(), ['site', 'theme', 'token']);
  assert.ok(crossed.values.missing.includes('token'));
  assert.equal(JSON.stringify(crossed).includes('vault:x'), false, 'a refused handle is not carried anywhere');
});

test('stale stored values (setup.version moved) are repair-required, never reinterpreted', () => {
  const r = resolve({ ...desired('personal', {}, SECRETS), setupVersion: 0 });
  assert.equal(r.effective, null);
  assert.equal(r.blocking[0].error, 'repair-required');
});

// ── digests ─────────────────────────────────────────────────────────────────

test('digests: stable across key order; configDigest follows values; grantDigest only the privilege-bearing part; handles by name only', () => {
  const p = ports({ grants: PRIVATE_GRANTS });
  const base = resolve(desired('personal', { auth: 'native' }, SECRETS), p);
  const reordered = (() => {
    const m = openWebui();
    m.services[0].env = Object.fromEntries(Object.entries(m.services[0].env).reverse());
    const s = Object.fromEntries(Object.entries(SECRETS).reverse());
    return resolve(desired('personal', { auth: 'native' }, s), p, AppManifestSchema.parse(m));
  })();
  assert.equal(reordered.configDigest, base.configDigest);
  assert.equal(reordered.grantDigest, base.grantDigest);
  assert.match(base.configDigest, /^sha256:[0-9a-f]{64}$/);

  const aura = resolve(desired('personal', { auth: 'aura' }, SECRETS), p);
  assert.notEqual(aura.configDigest, base.configDigest, 'a value change moves configDigest');
  assert.equal(aura.grantDigest, base.grantDigest, 'a plain value change leaves grantDigest');

  const rotated = resolve(desired('personal', { auth: 'native' }, { adminPassword: 'vault:h-admin-2', terminalKey: 'vault:h-term-2', sessionKey: 'vault:h-sess-2' }), p);
  assert.equal(rotated.configDigest, base.configDigest, 'handle identities are not in the digest');
  const fewer = resolve(desired('personal', { auth: 'native' }, { terminalKey: 'vault:h-term-1', sessionKey: 'vault:h-sess-1' }), p);
  assert.notEqual(fewer.configDigest, base.configDigest, 'secret field names are');

  const priv = resolve(desired('personal-private', { auth: 'native' }, SECRETS), p);
  assert.notEqual(priv.grantDigest, base.grantDigest, 'home and network change grantDigest');
  const net = { ...base.requested, networks: { ...base.requested.networks, webui: 'instance' } };
  assert.notEqual(grantDigestOf(net), base.grantDigest, 'a network change alone');
  const perm = { ...base.requested, permissions: [...base.requested.permissions, 'apps.list'] };
  assert.notEqual(grantDigestOf(perm), base.grantDigest, 'a permission change');
  assert.equal(grantDigestOf({ ...base.requested, permissions: [...perm.permissions].reverse() }), grantDigestOf(perm), 'list order does not count');
  assert.equal(configDigestOf(base.requested), base.configDigest);
  assert.equal(base.effective.configDigest, base.configDigest);
  assert.equal(base.effective.grantDigest, base.grantDigest);

  const leaked = JSON.stringify([base.configDigest, base.grantDigest, base.blocking, aura.blocking, resolve(desired('team', {}, SECRETS)).blocking]);
  for (const h of Object.values(SECRETS)) assert.equal(leaked.includes(h), false);
});

test('optional requirements unmet are degraded, never satisfied by weakening; required capability/grant subjects go through the ports', () => {
  const m = AppManifestSchema.parse({
    id: 'com.example.req', name: 'R', version: '1.0.0', sandbox: 'container',
    setup: { requirements: [
      { capability: 'ripgrep', level: 'optional', reason: 'faster search' },
      { capability: 'git', level: 'required' },
      { grant: 'apps.view:com.example.other', level: 'required' },
    ] },
  });
  const none = resolveEffective(input(m, desired(null)), ports());
  assert.equal(none.effective, null);
  assert.deepEqual(none.degraded.map((d) => d.requirement.capability), ['ripgrep']);
  assert.deepEqual(none.blocking.map((b) => [b.error, b.manifestField]), [
    ['requirement-unauthorized', 'setup.requirements[2]'], ['requirement-unsupported', 'setup.requirements[1]'],
  ]);
  const notGranted = resolveEffective(input(m, desired(null)), ports({ caps: { git: { installed: true, granted: false } }, grants: ['apps.view:com.example.other'] }));
  assert.deepEqual(notGranted.blocking.map((b) => b.error), ['requirement-unauthorized']);
  const ok = resolveEffective(input(m, desired(null)), ports({ caps: { git: { installed: true, granted: true } }, grants: ['apps.view:com.example.other'] }));
  assert.ok(ok.effective);
  assert.deepEqual(ok.effective.degraded.map((d) => d.requirement.capability), ['ripgrep']);
});
