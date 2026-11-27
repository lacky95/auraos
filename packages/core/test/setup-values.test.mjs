// D108 P4: value delivery. The app's own view (`setupConfigView`), the env
// literals of `fromSetup` (+ `map`, arrays refused), `fromSecret` as a
// reference in the sidecar spec (hash over the reference, never the value),
// the value read server-side at create through the app's own handle, the
// fail-closed refusal without a resolver, and vault `generate` secrets bound
// to the installation (idempotent, revocable, never replaceable). P4b (owner
// decisions 2 and 3): secrets reach a sidecar only through a 0600 env file
// that lives for the create (never an argv or log); generated secrets read
// grant-free only for their installation and field; generation, reads and
// revocation audited once each, without a value or handle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as core from '../dist/index.js';
import { SidecarManager } from '../dist/app-manager/SidecarManager.js';
import { containerSidecars } from '../dist/runtimes/container/sidecars.js';
import { InstanceTokens } from '../dist/app-manager/InstanceTokens.js';

const {
  setupConfigView, setupEnvLiteral, sidecarSetupValues, secretReadableWithoutGrant, vaultSecretReader, generateSetupSecrets,
  SetupValueError, resolveSidecarSpec, specHash, SpecError, CredentialVault, CREDENTIAL_HANDLE_RE, SETUP_SECRET_PREFIX, setupSecretName,
  vaultHandleRevoker,
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

/**
 * In-memory docker CLI recording every argv. At `create` and the seed's
 * `run`, an `--env-file` is looked at while docker runs: its mode, its dir's
 * mode and its content (owner decision 3).
 */
function fakeDocker(t, { failCreate = false } = {}) {
  const containers = new Map();
  const calls = [];
  const envFiles = [];
  const reply = (cb, code, stdout = '', stderr = '') => queueMicrotask(() => (code === 0 ? cb(null, stdout, stderr) : cb(Object.assign(new Error(stderr || 'failed'), { code }), stdout, stderr)));
  t.mock.method(childProcess, 'execFile', (cmd, args, _opts, cb) => {
    calls.push([...args]);
    const [verb] = args;
    const i = args.indexOf('--env-file');
    if (i >= 0) {
      const file = args[i + 1];
      envFiles.push({ verb, file, mode: statSync(file).mode & 0o777, dirMode: statSync(dirname(file)).mode & 0o777, content: readFileSync(file, 'utf8') });
    }
    if (verb === 'volume') reply(cb, 1, '', 'no such volume');
    else if (verb === 'image') reply(cb, 0, args.includes('{{.Id}}') ? 'sha256:x' : 'PATH=/bin\n');
    else if (verb === 'inspect') {
      const c = containers.get(args.at(-1));
      if (!c) reply(cb, 1, '', 'No such object');
      else reply(cb, 0, `/${c.name}\t${c.state}\t${JSON.stringify(c.labels)}\t0\n`);
    } else if (verb === 'ps') reply(cb, 0, '');
    else if (verb === 'create') {
      if (failCreate) { reply(cb, 125, '', 'Error response from daemon: Conflict'); return { stdin: { end() {} } }; }
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
  return { containers, calls, envFiles };
}

/** Everything written to the console while `fn` runs. */
async function console_(t, fn) {
  const out = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, m, (...a) => { out.push(a.map(String).join(' ')); });
  try { return { result: await fn(), out }; } finally { for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m].mock.restore(); }
}

function manager(t, env, setupValues, tpl = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-sv-'));
  const runner = {
    sidecarRuntime: () => ({ dataDir, appDataVolume: 'appvol', nodeModulesVolume: 'nm', network: 'aura-net',
      osApiBase: 'http://aura-shell:3000', shellHostname: 'aura-shell', workspaceRoot: '/ws', toolsMode: 'hardlink' }),
    mountRootDir: (k) => join(dataDir, 'm', k), mountRootSubpath: (k) => `m/${k}`, isolatedNetwork: (id) => `n-${id}`,
    toolsDir: (k) => join(dataDir, 't', k), clearToolsDir: () => undefined,
  };
  return new SidecarManager({
    runner, workloads: containerSidecars(runner, { baseImage: 'aura-base' }),
    registry: { getById: (id) => (id === APP ? { id: APP, services: [{ ...services(env)[0], ...tpl }], tools: [], permissions: [] } : undefined) },
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

test('spawn (owner decision 3): the secret value reaches the container only through a 0600 env file that exists only during create; never on any argv, label, answer or log', async (t) => {
  const d = fakeDocker(t);
  const reads = [];
  const values = sidecarSetupValues(effective({ services: [] }), async (ref) => { reads.push(ref); return ref.handle === H1 ? VALUE : null; });
  const mgr = manager(t, REFS, async (id) => { assert.equal(id, INST); return values; });
  const { result: res, out } = await console_(t, () => mgr.spawn(INST, { template: 'web' }, { instanceId: INST }));
  assert.equal(res.created, true);
  assert.deepEqual(reads, [{ field: 'sessionKey', handle: H1 }], 'read for its field, by the app\'s handle');
  for (const argv of d.calls) assert.ok(!argv.some((a) => a.includes(VALUE)), `no value on argv: docker ${argv[0]}`);
  const c = d.containers.get(`aura-${INST}--web`);
  const env = c.args.flatMap((a, i) => (c.args[i - 1] === '-e' ? [a] : []));
  assert.ok(!env.some((e) => e.startsWith('KEY=')), 'the secret variable is not a -e');
  assert.ok(env.includes('MODE=True') && env.includes('PLAIN=x'), 'plain values stay -e');
  // The env file: given to create, 0600 in a 0700 dir, holding exactly the secret; gone after create.
  assert.equal(d.envFiles.length, 1);
  const [f] = d.envFiles;
  assert.equal(f.verb, 'create');
  assert.equal(c.args[c.args.indexOf('--env-file') + 1], f.file);
  assert.equal(f.mode, 0o600);
  assert.equal(f.dirMode, 0o700);
  assert.equal(f.content, `KEY=${VALUE}\n`);
  assert.equal(existsSync(f.file), false, 'the env file is removed');
  assert.equal(existsSync(dirname(f.file)), false, 'its dir too');
  assert.ok(!JSON.stringify(c.labels).includes(VALUE), 'not in a label');
  assert.ok(!JSON.stringify(res).includes(VALUE), 'not in the answer');
  assert.ok(!out.join('\n').includes(VALUE), 'not in a log line');
  // Same spec again: adopted, the secret is not read again.
  const again = await mgr.spawn(INST, { template: 'web' }, { instanceId: INST });
  assert.equal(again.created, false);
  assert.equal(reads.length, 1);
});

test('spawn (owner decision 3): a failing create still removes the env file; the error carries no value', async (t) => {
  const d = fakeDocker(t, { failCreate: true });
  const values = sidecarSetupValues(effective({ services: [] }), async () => VALUE);
  const { result: err, out } = await console_(t, () => manager(t, REFS, async () => values).spawn(INST, { template: 'web' }, { instanceId: INST }).then(() => null, (e) => e));
  assert.ok(err instanceof Error && /docker create/.test(err.message));
  assert.ok(!err.message.includes(VALUE) && !String(err.stack).includes(VALUE));
  assert.equal(d.envFiles.length, 1);
  assert.equal(d.envFiles[0].mode, 0o600);
  assert.equal(existsSync(d.envFiles[0].file), false, 'removed after the failed create');
  assert.equal(existsSync(dirname(d.envFiles[0].file)), false);
  for (const argv of d.calls) assert.ok(!argv.some((a) => a.includes(VALUE)));
  assert.ok(!out.join('\n').includes(VALUE));
});

test('spawn (owner decision 3): the seed throwaway gets the secret by env file too; a secret wins over an inherited or literal variable of the same name', async (t) => {
  const d = fakeDocker(t);
  const values = sidecarSetupValues(effective({ services: [] }), async () => VALUE);
  const mgr = manager(t, { ...REFS }, async () => values, { seed: { command: ['init'] } });
  await mgr.spawn(INST, { template: 'web' }, { instanceId: INST });
  const run = d.calls.find((a) => a[0] === 'run');
  assert.ok(run && run.includes('--env-file'));
  assert.deepEqual(d.envFiles.map((f) => f.verb), ['run', 'create']);
  for (const f of d.envFiles) { assert.equal(f.mode, 0o600); assert.equal(f.content, `KEY=${VALUE}\n`); assert.equal(existsSync(f.file), false); }
  for (const argv of d.calls) assert.ok(!argv.some((a) => a.includes(VALUE)));
  // The containers module alone: a secret named like a request env variable goes only to the file.
  const { sidecarCreateEnv } = await import('../dist/runtimes/container/sidecars.js');
  const rt = { osApiBase: 'http://s', shellHostname: 's' };
  const spec = { name: 'web', inheritIdentity: true, inheritHome: false };
  const split = sidecarCreateEnv({ instanceId: INST, appId: APP, spec, env: { KEY: 'literal', A: '1' }, secretEnv: { KEY: VALUE, AURA_APP_ID: 'x' }, token: null }, rt);
  assert.deepEqual(split.file, { KEY: VALUE }, 'the OS identity still wins over a secret of its name');
  assert.equal(split.argv.KEY, undefined);
  assert.equal(split.argv.A, '1');
  assert.equal(split.argv.AURA_APP_ID, APP);
  // Without secrets: exactly the env as before (the golden argv, golden-workload-args.test.mjs).
  assert.deepEqual(sidecarCreateEnv({ instanceId: INST, appId: APP, spec, env: { A: '1' }, token: null }, rt).file, {});
});

test('spawn (owner decision 3): a secret an env file can\'t carry (a line break) is refused naming the variable, never sent', async (t) => {
  const d = fakeDocker(t);
  const bad = `${VALUE}\nEVIL=1`;
  const values = sidecarSetupValues(effective({ services: [] }), async () => bad);
  const err = await manager(t, REFS, async () => values).spawn(INST, { template: 'web' }, { instanceId: INST }).then(() => null, (e) => e);
  assert.ok(err instanceof Error && /env KEY: the secret value has a line break/.test(err.message));
  assert.ok(!err.message.includes(VALUE));
  assert.equal(d.calls.filter((a) => a[0] === 'create').length, 0);
  assert.equal(d.envFiles.length, 0);
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

test('owner decision 2: an app reads its own generated secret without a grant only for this installation and its declaring field; anything else needs the normal grant; every read is audited once, without the value', async () => {
  const v = vaultOf(memoryKv());
  const gen = await v.generate('default', { consumer: APP, installationId: INSTALL, field: 'k' });
  const gen2 = await v.generate('default', { consumer: APP, installationId: INSTALL, field: 'k2' });
  const otherInst = INSTALL.replace(/1$/, '9');
  const genOther = await v.generate('default', { consumer: APP, installationId: otherInst, field: 'k' });
  const genForeign = await v.generate('default', { consumer: 'io.other.app', installationId: INSTALL.replace(/1$/, '7'), field: 'k' });
  const typed = await v.store('default', 'API_KEY', VALUE, { consumer: APP });
  const foreign = await v.store('default', 'OTHER', 'x', { consumer: 'io.other.app' });
  const genValue = await v.reveal('default', setupSecretName(INSTALL, 'k'), APP);
  const audit = [];
  let granted = new Set();
  const current = { k: gen.handle, k2: gen2.handle, typed: typed.handle };
  const reader = (installationId = INSTALL, secrets = current) => vaultSecretReader({
    vault: v, userId: 'default', appId: APP, installationId, secrets, readGranted: async (n) => granted.has(n), audit: async (e) => { audit.push(e); },
  });
  // Its own: no grant.
  assert.equal(await reader()({ field: 'k', handle: gen.handle }), genValue);
  assert.equal(audit.length, 1, 'one audit row for the read');
  assert.deepEqual({ action: audit[0].action, grant: audit[0].detail.grant, field: audit[0].detail.field, via: audit[0].detail.via },
    { action: 'vault.read', grant: 'setup-generated', field: 'k', via: 'setup-env' });
  // Another installation of the same app (its record holds the handle, it is another installation's secret).
  assert.equal(await reader(otherInst, { k: gen.handle })({ field: 'k', handle: gen.handle }), null, 'another installation reading this one\'s');
  assert.equal(await reader()({ field: 'k', handle: genOther.handle }), null, 'this installation reading another\'s');
  // Another field of the same installation: the reference names k2 but the handle is k's, or k's handle is no longer current.
  assert.equal(await reader()({ field: 'k2', handle: gen.handle }), null, 'purpose-bound: another field');
  assert.equal(await reader(INSTALL, { k: gen2.handle })({ field: 'k', handle: gen.handle }), null, 'purpose-bound: not the field\'s current handle');
  assert.equal(await reader(INSTALL, {})({ field: 'k', handle: gen.handle }), null, 'purpose-bound: the field is gone');
  // A user-typed secret, a foreign app's handle and a foreign app's generated secret.
  assert.equal(await reader()({ field: 'typed', handle: typed.handle }), null, 'a typed secret without the grant');
  assert.equal(await reader()({ field: 'x', handle: foreign.handle }), null, 'another app\'s handle');
  assert.equal(await reader()({ field: 'k', handle: genForeign.handle }), null, 'another app\'s generated secret');
  assert.equal(await reader()({ field: 'k', handle: 'cred_' + 'Z'.repeat(22) }), null);
  assert.equal(audit.length, 1, 'a refused read reveals nothing and writes no read row');
  // With the normal grant they read (the grant path, not the generated one).
  granted = new Set(['API_KEY', setupSecretName(otherInst, 'k'), setupSecretName(INSTALL, 'k')]);
  assert.equal(await reader()({ field: 'typed', handle: typed.handle }), VALUE);
  assert.ok((await reader()({ field: 'k', handle: genOther.handle })).length === 32);
  assert.equal(await reader()({ field: 'k2', handle: gen.handle }), genValue);
  assert.equal(audit.length, 4);
  assert.deepEqual(audit.slice(1).map((e) => e.detail.grant), ['credential.read', 'credential.read', 'credential.read']);
  const trail = JSON.stringify(audit);
  for (const secret of [VALUE, genValue]) assert.ok(!trail.includes(secret), 'no value in the audit');
  for (const h of [gen.handle, gen2.handle, typed.handle]) assert.ok(!trail.includes(h), 'no handle in the audit');

  const binding = { installation: { installationId: INSTALL, field: 'k' } };
  assert.equal(secretReadableWithoutGrant({}, { installationId: INSTALL, secrets: { k: H1 } }, H1), false, 'no binding: typed');
  assert.equal(secretReadableWithoutGrant(binding, null, H1), false);
  assert.equal(secretReadableWithoutGrant(binding, { installationId: '', secrets: { k: H1 } }, H1), false);
  assert.equal(secretReadableWithoutGrant(binding, { installationId: INSTALL, secrets: { k: H1 } }, H1), true);
  assert.equal(secretReadableWithoutGrant(binding, { installationId: INSTALL, secrets: { k: H1 } }, H1, 'k'), true);
  assert.equal(secretReadableWithoutGrant(binding, { installationId: INSTALL, secrets: { k: H1 } }, H1, 'j'), false);
  assert.equal(secretReadableWithoutGrant(binding, { installationId: INSTALL, secrets: Object.create({ k: H1 }) }, H1), false, 'own fields only');
});

test('owner decision 2: generation and revocation (delete-app-data) each write one audit row without the value or handle; the next read fails', async () => {
  const v = vaultOf(memoryKv());
  const audit = [];
  const fields = {
    a: { type: 'secret', title: 'A', secret: { source: 'generate', length: 16 } },
    b: { type: 'secret', title: 'B', secret: { source: 'generate' } },
    c: { type: 'secret', title: 'C', secret: { source: 'ask' } },
  };
  const made = await generateSetupSecrets(v, { userId: 'default', appId: APP, installationId: INSTALL, fields, have: {}, audit: async (e) => { audit.push(e); } });
  assert.deepEqual(Object.keys(made), ['a', 'b']);
  assert.deepEqual(audit.map((e) => [e.action, e.detail.field, e.detail.created, e.detail.installation, e.detail.app]),
    [['vault.generated', 'a', true, INSTALL, APP], ['vault.generated', 'b', true, INSTALL, APP]]);
  const valueA = await v.reveal('default', setupSecretName(INSTALL, 'a'), APP);
  const reader = vaultSecretReader({ vault: v, userId: 'default', appId: APP, installationId: INSTALL, secrets: made, readGranted: async () => false, audit: async (e) => { audit.push(e); } });
  assert.equal(await reader({ field: 'a', handle: made.a }), valueA);
  assert.equal(audit.filter((e) => e.action === 'vault.read').length, 1);
  // Revocation: one row per handle, then the read fails (the entry is gone).
  const revoke = vaultHandleRevoker(v, { audit: async (e) => { audit.push(e); } });
  await revoke('default', made.a);
  await revoke('default', made.a);
  const revoked = audit.filter((e) => e.action === 'vault.revoked');
  assert.equal(revoked.length, 1, 'one row; a repeated revoke changes nothing and writes none');
  assert.deepEqual({ field: revoked[0].detail.field, installation: revoked[0].detail.installation, generated: revoked[0].detail.generated, via: revoked[0].detail.via },
    { field: 'a', installation: INSTALL, generated: true, via: 'delete-app-data' });
  assert.equal(await reader({ field: 'a', handle: made.a }), null, 'the next read fails');
  assert.equal(await v.describe('default', setupSecretName(INSTALL, 'a')), null);
  const trail = JSON.stringify(audit);
  assert.ok(!trail.includes(valueA) && !trail.includes(made.a) && !trail.includes(made.b), 'no value, no handle');
});
