// D108 P0: the setup contracts. The manifest blocks `setup` and `profiles`
// (types/setupManifest.ts), the one field model (config/schema.ts) that the
// runtime settings keep using unchanged, the engine-side contracts
// (setup/contracts.ts), the `app.setup.apply` approval class and the D64 row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The composition root (Phase 6 K) wires the service accessors when the barrel loads.
import * as core from '../dist/index.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { resolveSidecarSpec, SpecError } from '../dist/app-manager/sidecar-spec.js';

const base = { id: 'com.example.notes', name: 'Notes', version: '1.0.0' };
const parse = (over = {}) => AppManifestSchema.parse({ ...base, ...over });
const issues = (over) => {
  const r = AppManifestSchema.safeParse({ ...base, ...over });
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const refused = (over, re) => {
  const list = issues(over);
  assert.ok(list.some((m) => re.test(m)), `expected ${re} in:\n${list.join('\n') || '(parsed)'}`);
};

// The worked example (review §2.6): Open WebUI with three profiles.
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

// ── simple apps: unchanged ──────────────────────────────────────────────────

test('binding: a manifest without setup/profiles parses with no D108 key and literal env unchanged', () => {
  const m = parse({ services: [{ name: 'db', image: 'postgres:16', env: { A: '1' } }] });
  for (const k of ['setup', 'profiles', 'homeEnvironments']) assert.equal(k in m, false, `${k} absent`);
  assert.deepEqual(m.services[0].env, { A: '1' });
  assert.equal(m.services[0].home, undefined);
  assert.equal(core.declaresSetup(m), false, 'no record, no state, no gate effect');
});

test('the Open WebUI example (review §2.6) parses: fields, secrets by reference, three profiles, home declaration', () => {
  const m = AppManifestSchema.parse(openWebui());
  assert.equal(m.setup.version, 1);
  assert.deepEqual(m.setup.renames, []);
  assert.deepEqual(m.setup.init, { hook: true, idempotent: true, timeoutSec: 300 });
  assert.deepEqual(m.profiles.map((p) => p.id), ['personal', 'personal-private', 'team']);
  assert.deepEqual(m.services[0].env.WEBUI_AUTH, { fromSetup: 'auth', map: { native: 'True', aura: 'False' } });
  assert.equal(core.isEnvValueRef(m.services[0].env.WEBUI_AUTH), true);
  assert.equal(core.isEnvValueRef(m.services[0].env.PLAIN), false);
  assert.equal(core.declaresSetup(m), true);
  // P3: the setup engine's gate decides; without the engine such an app is refused, never run unconfigured.
  assert.equal(core.operationalBlock(m), null);
  assert.equal(core.setupEngineMissing(m)?.error, 'setup-unsupported');
});

// ── overlay allowlist (decision 4) ──────────────────────────────────────────

test('a profile overlay sets only allowlisted keys and never adds a sidecar or an image', () => {
  const p = (overlay) => ({ profiles: [{ id: 'x', title: 'X', overlay }], services: [{ name: 'svc', image: 'a:1' }] });
  refused(p({ id: 'other' }), /may only set instanceScope, environmentScope/);
  refused(p({ execution: { runAs: 'root', reason: 'x' } }), /may only set/);
  refused(p({ entrypoint: 'evil.sh' }), /may only set/);
  refused(p({ services: { svc: { image: 'evil:1' } } }), /Unrecognized key|image/);
  refused(p({ services: { svc: { privileged: true } } }), /Unrecognized key|privileged/);
  refused(p({ services: { added: { env: { A: '1' } } } }), /no services\[\] template added: a profile can't add a sidecar/);
  assert.deepEqual(issues(p({ services: { svc: { env: { A: '1' }, network: 'instance', limits: { memory: '512m' } } }, resources: { cpus: 2 } })), []);
  for (const key of core.PROFILE_OVERLAY_KEYS) assert.ok(typeof key === 'string');
  assert.deepEqual([...core.SERVICE_OVERLAY_KEYS], ['env', 'home', 'network', 'limits', 'readiness']);
});

test('profiles: unique ids, kebab ids, one recommended, private needs the home declaration', () => {
  refused({ profiles: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }, /profiles\[\]\.id must be unique/);
  refused({ profiles: [{ id: 'Bad_Id', title: 'A' }] }, /kebab-case/);
  refused({ profiles: [{ id: 'a', title: 'A', recommended: true }, { id: 'b', title: 'B', recommended: true }] }, /at most one profile is recommended/);
  refused({ profiles: [{ id: 'a', title: 'A', overlay: { homeEnvironment: 'private' } }] }, /needs homeEnvironments\.supported to include "private"/);
  refused({ homeEnvironments: { supported: ['private'] } }, /must include "app"/);
  refused({ homeEnvironments: { supported: ['app'], recommended: 'private' } }, /recommended must be one of supported/);
});

// ── fields: tighten, never loosen; references ───────────────────────────────

test('a profile tightens a base field (enum subset, required) and never loosens or retypes it', () => {
  const w = (fields) => ({ setup: { fields: { mode: { type: 'string', enum: ['a', 'b'], title: 'Mode' } } }, profiles: [{ id: 'p', title: 'P', setup: { fields } }] });
  assert.deepEqual(issues(w({ mode: { enum: ['a'], required: true } })), []);
  refused(w({ mode: { enum: ['a', 'c'] } }), /must be a subset of the base field's/);
  refused(w({ mode: { type: 'integer', title: 'Mode' } }), /may tighten mode, not change its type/);
  refused(w({ extra: { required: true } }), /extra is not a base field, so the profile must declare it completely/);
  assert.deepEqual(issues(w({ extra: { type: 'boolean', title: 'Extra' } })), [], 'a complete profile-only field');
});

test('`when` names known fields and profiles; env references name fields of the right kind and need setup', () => {
  refused({ setup: { fields: { a: { type: 'string', title: 'A', when: { field: 'nope', in: ['x'] } } } } }, /when\.field names unknown field nope/);
  refused({ setup: { fields: { a: { type: 'string', title: 'A', when: { profile: ['ghost'] } } } } }, /unknown profile ghost/);
  refused({ setup: { requirements: [{ feature: 'network.isolation', level: 'required', when: { field: 'x', equals: true } }] } }, /unknown field x/);
  const svc = (env, setup = { fields: { s: { type: 'secret', title: 'S', secret: { source: 'ask' } }, v: { type: 'string', title: 'V' } } }) =>
    ({ ...(setup ? { setup } : {}), services: [{ name: 'svc', image: 'a:1', env }] });
  assert.deepEqual(issues(svc({ A: { fromSecret: 's' }, B: { fromSetup: 'v' } })), []);
  refused(svc({ A: { fromSecret: 'v' } }), /not a secret field/);
  refused(svc({ A: { fromSetup: 's' } }), /use fromSecret/);
  refused(svc({ A: { fromSetup: 'ghost' } }), /unknown field ghost/);
  refused(svc({ A: { fromSetup: 'v' } }, null), /need a setup block/);
  refused(svc({ A: '${v}', B: { template: '{{v}}' } }), /Expected string|Invalid input/);
});

test('field model: secrets carry no value or default, patterns that could hang the kernel are refused', () => {
  refused({ setup: { fields: { p: { type: 'secret', title: 'P', secret: { source: 'ask' }, default: 'hunter2' } } } }, /Unrecognized key/);
  refused({ setup: { fields: { p: { type: 'secret', title: 'P', secret: { source: 'ask', length: 32 } } } } }, /generated secrets only/);
  refused({ setup: { fields: { p: { type: 'string', title: 'P', pattern: '(a+)+$' } } } }, /no nested quantifier/);
  refused({ setup: { fields: { p: { type: 'string', title: 'P', pattern: '[' } } } }, /must compile/);
  refused({ setup: { fields: { p: { type: 'integer', title: 'P', default: 70000, maximum: 65535 } } } }, /default does not satisfy/);
  refused({ setup: { fields: { 'bad-name': { type: 'boolean', title: 'B' } } } }, /setup field names/);
  assert.equal(core.safeFieldPattern('^[a-z0-9.-]+$'), true);
  assert.equal(core.safeFieldPattern('(\\d+)*'), false);
});

test('checkConfigValues: unknown, invalid and missing required fields are named, values never echoed; secrets take no value', () => {
  const fields = {
    host: { type: 'string', title: 'Host', required: true, pattern: '[a-z.]+' },
    port: { type: 'integer', title: 'Port', default: 587, minimum: 1, maximum: 65535 },
    tls: { type: 'boolean', title: 'TLS' },
    pw: { type: 'secret', title: 'Password', required: true, secret: { source: 'ask' } },
  };
  const ok = core.checkConfigValues(fields, { host: 'mail.example', tls: 'true' });
  assert.deepEqual(ok, { values: { port: 587, host: 'mail.example', tls: true }, fieldErrors: {}, missing: [] });
  const bad = core.checkConfigValues(fields, { host: 'BAD HOST', port: 0, nope: 1, pw: 'hunter2' });
  assert.deepEqual(Object.keys(bad.fieldErrors).sort(), ['host', 'nope', 'port', 'pw']);
  assert.ok(!JSON.stringify(bad).includes('hunter2'), 'no secret value echoed');
  assert.ok(!JSON.stringify(bad.fieldErrors).includes('BAD HOST'), 'no value echoed');
  assert.deepEqual(core.checkConfigValues(fields, {}).missing, ['host'], 'a required secret is not a value (checked by handle)');
  assert.equal(core.conditionHolds({ field: 'auth', in: ['aura'] }, { auth: 'aura' }, null), true);
  assert.equal(core.conditionHolds({ field: 'auth', equals: 'aura' }, {}, null), false, 'absent is false');
  assert.equal(core.conditionHolds({ profile: ['a'] }, {}, 'a'), true);
  assert.equal(core.conditionHolds({ profile: ['a'] }, {}, null), false);
});

test('runtime settings keep their behaviour on the lifted field model (D36)', () => {
  const schema = { type: 'object', properties: {
    placement: { type: 'string', title: 'Placement', enum: ['own', 'pool'], default: 'own' },
    n: { type: 'integer', title: 'N', minimum: 1 },
    list: { type: 'array', items: { type: 'string' }, title: 'L' },
  } };
  assert.deepEqual(core.settingsDefaults(schema), { placement: 'own' });
  assert.deepEqual(core.validateSettings(schema, { n: '3', list: 'a, b' }), { placement: 'own', n: 3, list: ['a', 'b'] });
  assert.throws(() => core.validateSettings(schema, { placement: 'x' }), (e) => e instanceof core.RuntimeSettingsError && e.message === 'invalid value for placement (one of: own, pool)');
  assert.throws(() => core.validateSettings(schema, { zz: 1 }), /unknown setting: zz/);
  assert.throws(() => core.validateSettings(schema, []), /settings must be an object/);
});

// ── sidecars: references fail closed until value delivery (P4) ──────────────

test('a sidecar template with a setup reference is refused, never started with an empty or raw value', () => {
  const services = [{ name: 'svc', image: 'a:1', command: [], volumes: [], env: { A: '1', K: { fromSecret: 'k' } } }];
  const ctx = { appId: 'io.test.app', instanceId: 'io.test.app-2', manifest: { services, tools: [] }, can: () => false,
    appDataSubpath: 'x', appDataVolume: 'v', legacyVolumeExists: () => false };
  assert.throws(() => resolveSidecarSpec({ template: 'svc' }, ctx), (e) => e instanceof SpecError && e.status === 409 && /env K references a setup value/.test(e.message));
  services[0].env = { A: '1' };
  assert.deepEqual(resolveSidecarSpec({ template: 'svc' }, ctx).env, { A: '1' });
});

// ── engine contracts ────────────────────────────────────────────────────────

test('operational states: ready is entered only from initializing (or a reauthorized block); every code has a category', () => {
  const into = (s) => core.OPERATIONAL_STATES.filter((f) => core.OPERATIONAL_TRANSITIONS[f].includes(s));
  assert.deepEqual(into('ready'), ['initializing', 'blocked']);
  for (const s of core.OPERATIONAL_STATES) assert.ok(Array.isArray(core.OPERATIONAL_TRANSITIONS[s]), s);
  for (const c of core.SETUP_ERROR_CODES) assert.ok(core.CATEGORY_OF_SETUP_CODE[c], c);
  assert.equal(core.CATEGORY_OF_SETUP_CODE['setup-required'], 'needs-setup');
  const e = core.setupError('profile-required', 'pick a profile', { suggest: ['personal'] });
  assert.deepEqual(e, { error: 'profile-required', category: 'needs-setup', message: 'pick a profile', suggest: ['personal'] });
  assert.equal(core.configRecordKey('inst_1'), 'app:config:inst_1');
  assert.equal(core.configRecordKey('inst_1', 'u1'), 'app:config:inst_1:u:u1');
  assert.equal(core.homePrivateSidecarPermission('terminal'), 'home.private.sidecar:terminal');
});

test('app.setup.apply: class is the strictest contained part, from the server-built payload (decision 9)', () => {
  assert.ok(core.APPROVAL_ACTIONS.includes('app.setup.apply'));
  const adds = (over) => ({ adds: { permissions: [], tools: [], context: [], homePrivate: false, homePrivateSidecars: [], ...over } });
  assert.equal(core.approvalClassOf('app.setup.apply', adds({ permissions: ['network.internet'] })), 'deferrable');
  assert.equal(core.approvalClassOf('app.setup.apply', adds({ homePrivate: true })), 'forced');
  assert.equal(core.approvalClassOf('app.setup.apply', adds({ homePrivateSidecars: ['terminal'] })), 'forced');
  assert.equal(core.approvalClassOf('app.setup.apply', adds({ runAsRoot: true })), 'forced');
  assert.equal(core.setupApplyNeedsFresh(adds({ homePrivate: true })), true);
  assert.equal(core.approvalClassOf('app.setup.apply', null), 'deferrable', 'no privileged part: deferrable');
});

test('D64: app-private-home is one policy option (off | grant, default grant)', () => {
  const o = core.securityOption(core.APP_PRIVATE_HOME_OPTION);
  assert.deepEqual([o?.source, o?.type, o?.default, o?.change], ['policy', 'enum', 'grant', 'fresh']);
  assert.deepEqual(o?.values, ['off', 'grant']);
  assert.ok(core.POLICY_OPTION_IDS.includes('app-private-home'));
});
