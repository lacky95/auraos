// D108 P4: value delivery. The app's own view (`setupConfigView`), the env
// literals of `fromSetup` (+ `map`, arrays refused), `fromSecret` as a
// reference in the sidecar spec (hash over the reference, never the value),
// the value read server-side at create through the app's own handle, the
// fail-closed refusal without a resolver, and vault `generate` secrets bound
// to the installation (idempotent, revocable, never replaceable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as core from '../dist/index.js';
import { SidecarManager } from '../dist/app-manager/SidecarManager.js';
import { containerSidecars } from '../dist/runtimes/container/sidecars.js';
import { InstanceTokens } from '../dist/app-manager/InstanceTokens.js';

const {
  setupConfigView, setupEnvLiteral, sidecarSetupValues, secretReadableWithoutGrant, vaultSecretReader, generateSetupSecrets,
  SetupValueError, resolveSidecarSpec, specHash, SpecError, CredentialVault, CREDENTIAL_HANDLE_RE, SETUP_SECRET_PREFIX, setupSecretName,
} = core;

const APP = 'io.test.app';
const INST = 'io.test.app-2';
const INSTALL = '6f1c1c7e-4d7a-4c55-9b2e-000000000001';
const H1 = 'cred_' + 'A'.repeat(22);
const H2 = 'cred_' + 'B'.repeat(22);

const effective = (over = {}) => ({
  appId: APP, installationId: INSTALL, profile: 'personal', setupVersion: 1,
  permissions: [], tools: [], context: [], homeEnvironment: 'app', ownerEnvironmentSidecars: [], instanceScope: 'per-user',
  environmentScope: 'user', sandbox: 'container', networks: {}, resources: null,
  values: { auth: 'native', debug: true, port: 8080, tags: ['a', 'b'] },
  secrets: { sessionKey: H1 },
  services: [{ name: 'web', env: {
    MODE: { fromSetup: 'auth', map: { native: 'True', aura: 'False' } },
    DEBUG: { fromSetup: 'debug' }, PORT: { fromSetup: 'port' },
    KEY: { fromSecret: 'sessionKey' }, ADMIN: { fromSecret: 'adminPassword' }, GONE: { fromSetup: 'inactive' }, PLAIN: 'x',
  }, home: 'none' }],
  degraded: [{ requirement: { capability: 'git', level: 'optional' }, reason: 'not installed' }],
  configDigest: 'sha256:c', grantDigest: 'sha256:g',
  ...over,
});

// ── the app server's view ───────────────────────────────────────────────────

test('setupConfigView: own values, secrets as handles, degraded, digest; nothing else of the configuration', () => {
  const e = effective();
  const v = setupConfigView(e);
  assert.deepEqual(Object.keys(v).sort(), ['appId', 'configDigest', 'degraded', 'installationId', 'profile', 'secrets', 'values']);
  assert.deepEqual(v.secrets, { sessionKey: H1 });
  assert.deepEqual(v.values, e.values);
  v.values.auth = 'changed';
  assert.equal(e.values.auth, 'native', 'a copy, not the engine\'s object');
});

// ── literals ────────────────────────────────────────────────────────────────

test('fromSetup literals: strings as is, booleans and integers deterministic, map applied', () => {
  assert.equal(setupEnvLiteral('a b', { fromSetup: 'f' }, 'E'), 'a b');
  assert.equal(setupEnvLiteral(true, { fromSetup: 'f' }, 'E'), 'true');
  assert.equal(setupEnvLiteral(false, { fromSetup: 'f' }, 'E'), 'false');
  assert.equal(setupEnvLiteral(42, { fromSetup: 'f' }, 'E'), '42');
  assert.equal(setupEnvLiteral('native', { fromSetup: 'f', map: { native: 'True' } }, 'E'), 'True');
  assert.equal(setupEnvLiteral(true, { fromSetup: 'f', map: { true: '1', false: '0' } }, 'E'), '1');
});

test('a value without a map entry, and a list, are refused (config-invalid), never passed through; the error names no value', () => {
  const refused = (fn) => assert.throws(fn, (e) => e instanceof SetupValueError && e.code === 'config-invalid'
    && e.body.category === 'invalid-request' && e.body.manifestField === 'setup.fields.f' && !e.message.includes('SECRETISH'));
  refused(() => setupEnvLiteral('SECRETISH', { fromSetup: 'f', map: { native: 'True' } }, 'E'));
  refused(() => setupEnvLiteral('toString', { fromSetup: 'f', map: {} }, 'E'));
  refused(() => setupEnvLiteral(['SECRETISH'], { fromSetup: 'f' }, 'E'));
  refused(() => setupEnvLiteral(['a'], { fromSetup: 'f', map: { a: 'x' } }, 'E'));
  refused(() => setupEnvLiteral(1.5, { fromSetup: 'f' }, 'E'));
});

// ── the sidecar resolver ────────────────────────────────────────────────────

test('sidecarSetupValues: effective service env; literals, secret references, inactive and unset fields unset', () => {
  const r = sidecarSetupValues(effective(), async () => null);
  const out = r.env('web', { IGNORED: 'base env is not used when the effective config has the service' });
  assert.deepEqual(out.env, { MODE: 'True', DEBUG: 'true', PORT: '8080', PLAIN: 'x' });
  assert.deepEqual(out.secretEnv, { KEY: { field: 'sessionKey', handle: H1 } });
  // A template the effective config doesn't carry: its own env.
  assert.deepEqual(r.env('other', { A: '1', B: { fromSetup: 'auth' } }), { env: { A: '1', B: 'native' }, secretEnv: {} });
  assert.throws(() => r.env('other', { T: { fromSetup: 'tags' } }), SetupValueError, 'arrays are refused');
});

const services = (env) => [{ name: 'web', image: 'a:1', command: [], volumes: [], env }];
const ctx = (env, setupEnv) => ({
  appId: APP, instanceId: INST, manifest: { services: services(env), tools: [] }, can: () => false,
  appDataSubpath: 'x', appDataVolume: 'v', legacyVolumeExists: () => false, ...(setupEnv ? { setupEnv } : {}),
});
const REFS = { MODE: { fromSetup: 'auth', map: { native: 'True', aura: 'False' } }, KEY: { fromSecret: 'sessionKey' }, PLAIN: 'x' };

test('no resolver (app not ready) → a reference refuses the sidecar (409); a template without references is unchanged', () => {
  assert.throws(() => resolveSidecarSpec({ template: 'web' }, ctx(REFS)),
    (e) => e instanceof SpecError && e.status === 409 && /env MODE references a setup value/.test(e.message));
  const plain = resolveSidecarSpec({ template: 'web' }, ctx({ A: '1' }));
  const withResolver = resolveSidecarSpec({ template: 'web' }, ctx({ A: '1' }, sidecarSetupValues(effective(), async () => null)));
  assert.equal('secretEnv' in plain, false);
  assert.equal(specHash(withResolver), specHash(plain), 'a resolver changes nothing for a template without references');
});

test('spec: fromSetup literal in env, fromSecret only as a reference; the hash covers the reference, never a value', () => {
  const e = effective({ services: [] });
  const spec = resolveSidecarSpec({ template: 'web' }, ctx(REFS, sidecarSetupValues(e, async () => 'never-called')));
  assert.deepEqual(spec.env, { MODE: 'True', PLAIN: 'x' });
  assert.deepEqual(spec.secretEnv, { KEY: { field: 'sessionKey', handle: H1 } });
  const h = specHash(spec);
  // The value behind the handle is not an input to the hash at all; another handle is a new spec.
  const other = resolveSidecarSpec({ template: 'web' }, ctx(REFS, sidecarSetupValues(effective({ services: [], secrets: { sessionKey: H2 } }), async () => null)));
  assert.notEqual(specHash(other), h);
  // A changed plain value is a changed spec (recreate), as for any env literal.
  assert.notEqual(specHash(resolveSidecarSpec({ template: 'web' }, ctx(REFS, sidecarSetupValues(effective({ services: [], values: { auth: 'aura' } }), async () => null)))), h);
  // The request wins over the template, also over a secret reference.
  const req = resolveSidecarSpec({ template: 'web', env: { KEY: 'mine' } }, ctx(REFS, sidecarSetupValues(e, async () => null)));
  assert.equal(req.env.KEY, 'mine');
  assert.equal('secretEnv' in req, false);
});

test('a value the resolver refuses refuses the sidecar (409), naming the variable, not the value', () => {
  const e = effective({ services: [], values: { auth: 'SECRETISH' } });
  assert.throws(() => resolveSidecarSpec({ template: 'web' }, ctx(REFS, sidecarSetupValues(e, async () => null))),
    (err) => err instanceof SpecError && err.status === 409 && /env MODE/.test(err.message) && !err.message.includes('SECRETISH'));
});

// ── SidecarManager: the secret goes into the container env only ────────────

function fakeDocker(t) {
  const containers = new Map();
  const calls = [];
  const reply = (cb, code, stdout = '', stderr = '') => queueMicrotask(() => (code === 0 ? cb(null, stdout, stderr) : cb(Object.assign(new Error(stderr || 'failed'), { code }), stdout, stderr)));
  t.mock.method(childProcess, 'execFile', (cmd, args, _opts, cb) => {
    calls.push(args);
    const [verb] = args;
    if (verb === 'volume') reply(cb, 1, '', 'no such volume');
    else if (verb === 'image') reply(cb, 0, args.includes('{{.Id}}') ? 'sha256:x' : 'PATH=/bin\n');
    else if (verb === 'inspect') {
      const c = containers.get(args.at(-1));
      if (!c) reply(cb, 1, '', 'No such object');
      else reply(cb, 0, `/${c.name}\t${c.state}\t${JSON.stringify(c.labels)}\t0\n`);
    } else if (verb === 'ps') reply(cb, 0, '');
    else if (verb === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const labels = {};
      args.forEach((a, i) => { if (args[i - 1] === '--label') { const j = a.indexOf('='); labels[a.slice(0, j)] = a.slice(j + 1); } });
      containers.set(name, { name, state: 'created', labels, args });
      reply(cb, 0, `${name}\n`);
    } else if (verb === 'start') { const c = containers.get(args[1]); if (c) c.state = 'running'; reply(cb, 0); }
    else reply(cb, 0);
    return { stdin: { end() {} } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { containers, calls };
}

function manager(t, env, setupValues) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-sv-'));
  const runner = {
    sidecarRuntime: () => ({ dataDir, appDataVolume: 'appvol', nodeModulesVolume: 'nm', network: 'aura-net',
      osApiBase: 'http://aura-shell:3000', shellHostname: 'aura-shell', workspaceRoot: '/ws', toolsMode: 'hardlink' }),
    mountRootDir: (k) => join(dataDir, 'm', k), mountRootSubpath: (k) => `m/${k}`, isolatedNetwork: (id) => `n-${id}`,
    toolsDir: (k) => join(dataDir, 't', k), clearToolsDir: () => undefined,
  };
  return new SidecarManager({
    runner, workloads: containerSidecars(runner, { baseImage: 'aura-base' }),
    registry: { getById: (id) => (id === APP ? { id: APP, services: services(env), tools: [], permissions: [] } : undefined) },
    permissions: { hasPermission: () => false },
    tokens: new InstanceTokens(join(dataDir, 'k')),
    mounts: { reapplyConsumer: async () => ({}), removeAll: () => undefined, forgetConsumer: () => undefined },
    context: async () => ({ env: {}, known: new Set() }),
    instance: (id) => (id === INST ? { appId: APP, instanceDataDir: join(dataDir, 'apps', APP, INST) } : null),
    appHome: async () => null,
    ...(setupValues !== undefined ? { setupValues } : {}),
  });
}

const VALUE = 'v-' + randomBytes(12).toString('hex');

test('spawn: the secret value is read at create and is only in the container env, never in the record label or its hash', async (t) => {
  const d = fakeDocker(t);
  const reads = [];
  const values = sidecarSetupValues(effective({ services: [] }), async (h) => { reads.push(h); return h === H1 ? VALUE : null; });
  const mgr = manager(t, REFS, async (id) => { assert.equal(id, INST); return values; });
  const res = await mgr.spawn(INST, { template: 'web' }, { instanceId: INST });
  assert.equal(res.created, true);
  assert.deepEqual(reads, [H1]);
  const c = d.containers.get(`aura-${INST}--web`);
  const env = c.args.flatMap((a, i) => (c.args[i - 1] === '-e' ? [a] : []));
  assert.ok(env.includes(`KEY=${VALUE}`));
  assert.ok(env.includes('MODE=True'));
  assert.ok(!JSON.stringify(c.labels).includes(VALUE), 'not in a label');
  assert.ok(!JSON.stringify(res).includes(VALUE), 'not in the answer');
  // Same spec again: adopted, the secret is not read again.
  const again = await mgr.spawn(INST, { template: 'web' }, { instanceId: INST });
  assert.equal(again.created, false);
  assert.deepEqual(reads, [H1]);
});

test('spawn: a secret that can\'t be read, no effective config, or no port refuses the sidecar; nothing is created', async (t) => {
  const d = fakeDocker(t);
  const unreadable = manager(t, REFS, async () => sidecarSetupValues(effective({ services: [] }), async () => null));
  await assert.rejects(unreadable.spawn(INST, { template: 'web' }, { instanceId: INST }),
    (e) => e instanceof SpecError && e.status === 409 && /env KEY: the secret of setup field sessionKey can't be read/.test(e.message));
  await assert.rejects(manager(t, REFS, async () => null).spawn(INST, { template: 'web' }, { instanceId: INST }), /references a setup value/);
  await assert.rejects(manager(t, REFS).spawn(INST, { template: 'web' }, { instanceId: INST }), /references a setup value/);
  assert.equal(d.containers.size, 0);
  // A template without references never asks for setup values.
  let asked = 0;
  await manager(t, { A: '1' }, async () => { asked++; return null; }).spawn(INST, { template: 'web' }, { instanceId: INST });
  assert.equal(asked, 0);
});

// ── the vault: generated secrets, the read rule ─────────────────────────────

function memoryKv() {
  const m = new Map();
  return {
    m,
    kv: () => ({
      async get(ns, key) { return m.get(`${ns}|${key}`) ?? null; },
      async set(ns, key, value) { const e = { value: JSON.parse(JSON.stringify(value)), updatedAt: 1 }; m.set(`${ns}|${key}`, e); return e; },
      async del(ns, key) { return m.delete(`${ns}|${key}`); },
      async list(ns) { return [...m.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.slice(ns.length + 1)); },
    }),
  };
}
const key = randomBytes(32);
const vaultOf = (store) => new CredentialVault({ kv: store.kv, key });

test('generate: bound to (installation, field), idempotent, sealed, declared length; never replaceable by store', async () => {
  const store = memoryKv();
  const v = vaultOf(store);
  const a = await v.generate('default', { consumer: APP, installationId: INSTALL, field: 'sessionKey', length: 24 });
  assert.equal(a.created, true);
  assert.match(a.handle, CREDENTIAL_HANDLE_RE);
  const b = await v.generate('default', { consumer: APP, installationId: INSTALL, field: 'sessionKey', length: 24 });
  assert.deepEqual(b, { handle: a.handle, created: false });
  const [x, y] = await Promise.all([
    v.generate('default', { consumer: APP, installationId: INSTALL, field: 'other' }),
    v.generate('default', { consumer: APP, installationId: INSTALL, field: 'other' }),
  ]);
  assert.equal(x.handle, y.handle, 'concurrent first calls agree');
  const name = setupSecretName(INSTALL, 'sessionKey');
  assert.ok(name.startsWith(SETUP_SECRET_PREFIX) && !name.includes('sessionKey') && !name.includes(APP));
  const value = await v.reveal('default', name, APP);
  assert.equal(value.length, 24);
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.ok(!JSON.stringify([...store.m.values()]).includes(value), 'sealed at rest');
  assert.deepEqual(await v.resolve('default', a.handle), { name, consumer: APP, installation: { installationId: INSTALL, field: 'sessionKey' } });
  // Another installation of the same field is another secret.
  assert.notEqual((await v.generate('default', { consumer: APP, installationId: INSTALL.replace(/1$/, '2'), field: 'sessionKey' })).handle, a.handle);
  await assert.rejects(v.store('default', name, 'typed', { consumer: APP }), /reserved/);
  await assert.rejects(v.generate('default', { consumer: APP, installationId: INSTALL, field: 'x', length: 8 }), /16\.\.256/);
  await assert.rejects(v.generate('default', { consumer: APP, installationId: INSTALL, field: '../x' }), /invalid setup field/);
  // Another app can't adopt the reserved entry.
  await assert.rejects(v.generate('default', { consumer: 'io.other.app', installationId: INSTALL, field: 'sessionKey' }), /holds another entry/);
});

test('generate: revoking the app\'s handle (delete-app-data, setup store vaultHandleRevoker) removes the secret entirely', async () => {
  const store = memoryKv();
  const v = vaultOf(store);
  const { handle } = await v.generate('default', { consumer: APP, installationId: INSTALL, field: 'k' });
  await core.vaultHandleRevoker(v)('default', handle);
  assert.equal(await v.resolve('default', handle), null);
  assert.equal(await v.describe('default', setupSecretName(INSTALL, 'k')), null);
  const again = await v.generate('default', { consumer: APP, installationId: INSTALL, field: 'k' });
  assert.equal(again.created, true);
  assert.notEqual(again.handle, handle);
});

test('generateSetupSecrets: only missing generate-secret fields, sorted, handles only', async () => {
  const v = vaultOf(memoryKv());
  const fields = {
    a: { type: 'secret', title: 'A', secret: { source: 'generate', length: 16 } },
    b: { type: 'secret', title: 'B', secret: { source: 'ask' } },
    c: { type: 'secret', title: 'C', secret: { source: 'generate' } },
    d: { type: 'string', title: 'D' },
  };
  const out = await generateSetupSecrets(v, { userId: 'default', appId: APP, installationId: INSTALL, fields, have: { c: H1 } });
  assert.deepEqual(Object.keys(out), ['a']);
  assert.match(out.a, CREDENTIAL_HANDLE_RE);
});

test('vaultSecretReader: the app\'s own handle only; a generated secret of THIS installation needs no grant, anything else the credential.read grant', async () => {
  const v = vaultOf(memoryKv());
  const gen = await v.generate('default', { consumer: APP, installationId: INSTALL, field: 'k' });
  const typed = await v.store('default', 'API_KEY', VALUE, { consumer: APP });
  const foreign = await v.store('default', 'OTHER', 'x', { consumer: 'io.other.app' });
  const audit = [];
  let granted = false;
  const reader = (installationId = INSTALL) => vaultSecretReader({
    vault: v, userId: 'default', appId: APP, installationId, readGranted: async (n) => granted && n === 'API_KEY', audit: async (e) => { audit.push(e); },
  });
  assert.equal((await reader()(gen.handle)).length, 32);
  assert.equal(await reader(INSTALL.replace(/1$/, '9'))(gen.handle), null, 'another installation\'s generated secret');
  assert.equal(await reader()(typed.handle), null, 'a typed secret without the grant');
  granted = true;
  assert.equal(await reader()(typed.handle), VALUE);
  assert.equal(await reader()(foreign.handle), null, 'another app\'s handle');
  assert.equal(await reader()('cred_' + 'Z'.repeat(22)), null);
  assert.ok(audit.length >= 2 && audit.every((e) => e.action === 'vault.read' && e.detail.via === 'setup-env'));
  assert.ok(!JSON.stringify(audit).includes(VALUE), 'no value in the audit');
  assert.equal(secretReadableWithoutGrant({}, INSTALL), false);
  assert.equal(secretReadableWithoutGrant({ installation: { installationId: INSTALL, field: 'k' } }, null), false);
});
