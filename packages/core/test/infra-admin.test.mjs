// D94 IC-1 (the management API's core: one implementation over os/infra) and the release build's
// infrastructure inputs (IC-5, the U call site): validate/diff/apply with the store and render,
// idempotent; refusals name paths, never values; credentials bound to the hosts their refs use;
// the build inputs file and its secrets, swept when stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tmp } from './release-fixtures.mjs';
import { CANARY, exampleFixture } from './infra-fixtures.mjs';
import { InfraAdminError, applyInfra, infraDiff, setInfraCredential, showInfra, validateInfra } from '../dist/infra/admin.js';
import { releaseBuildInfra, sweepInfraRuns } from '../dist/infra/build.js';
import { renderDigest } from '../dist/infra/propagate.js';

const STORE = await import(join(ROOT, 'os/infra/store.mjs'));
const SEC = await import(join(ROOT, 'os/infra/secrets.mjs'));
const PROXY = 'version: 1\nnetwork:\n  proxy:\n    https: http://proxy.corp.example:3128\n    credential: { ref: "system:INFRA_PROXY" }\n';
const WITH_CA = (pem) => ({ config: 'version: 1\ntrust:\n  caCertificates:\n    - { name: corp-root, file: certs/corp-root.pem }\n', files: { 'certs/corp-root.pem': pem } });

test('validate: schema errors by path, the policy seed refused after install, no path escape; diff against the stored config', async () => {
  const data = tmp('aura-adm-');
  await assert.rejects(validateInfra({ config: 'version: 1\nnetwork:\n  proxy:\n    https: http://u:p@proxy.example:1\n' }, { dataDir: data }),
    (e) => e instanceof InfraAdminError && e.code === 'invalid-config' && e.errors.some((x) => x.path === 'network.proxy.https') && !/u:p/.test(JSON.stringify(e.errors)));
  await assert.rejects(validateInfra({ config: 'version: 1\npolicy: { publicFallback: deny }\n' }, { dataDir: data }), (e) => e.code === 'policy-in-config');
  await assert.rejects(validateInfra({ config: 'version: 1\n', files: { '../x.pem': 'x' } }, { dataDir: data }), (e) => e.code === 'invalid-request');
  await assert.rejects(validateInfra({ config: 42 }, { dataDir: data }), (e) => e.code === 'invalid-request');
  const v = await validateInfra({ config: PROXY }, { dataDir: data });
  assert.equal(v.changed, true);
  assert.ok(v.diff.some((l) => l === '+   proxy:' || /^\+ .*https: /.test(l)));
  assert.deepEqual(infraDiff('a\nb\n', 'a\nc\n'), ['- b', '+ c']);
});

test('apply: stored (prev kept), rendered, idempotent; show lists the credential refs and their state, never a value', async () => {
  const data = tmp('aura-adm-');
  const f = exampleFixture();
  const ca = readFileSync(join(f.dir, 'certs/corp-root.pem'), 'utf8');
  const a = await applyInfra(WITH_CA(ca), { dataDir: data });
  assert.equal(a.changed, true);
  assert.match(a.renderDigest, /^sha256:/);
  assert.equal(renderDigest(data), a.renderDigest);
  assert.match(readFileSync(join(data, 'aura/infra/trust/corp-root.pem'), 'utf8'), /BEGIN CERTIFICATE/);
  assert.equal((await applyInfra(WITH_CA(ca), { dataDir: data })).changed, false, 'the same config changes nothing');
  const b = await applyInfra({ config: PROXY }, { dataDir: data });
  assert.equal(b.changed, true);
  assert.ok(existsSync(join(data, 'aura/infra/config.yaml.prev')));
  const ctx = { get: async () => null };
  const s = await showInfra({ dataDir: data, context: ctx });
  assert.deepEqual(s.credentials, [{ ref: 'system:INFRA_PROXY', path: 'network.proxy.credential', hosts: ['proxy.corp.example'], status: 'missing' }]);
});

test('credential set: only for a system: ref the config uses, the right kind, bound to its hosts; the value never returned', async () => {
  const data = tmp('aura-adm-');
  await applyInfra({ config: PROXY }, { dataDir: data });
  const sealed = new Map();
  const ctx = { set: async (k, v, kind, inject) => { assert.deepEqual([kind, inject], ['secret', []]); sealed.set(k, v); } };
  const [user, password] = CANARY.proxy.split(':');
  const r = await setInfraCredential({ dataDir: data, name: 'proxy', credential: { kind: 'basic', user, password }, context: ctx });
  assert.deepEqual(r, { key: 'INFRA_PROXY', hosts: ['proxy.corp.example'] });
  assert.deepEqual(JSON.parse(sealed.get('INFRA_PROXY')).hosts, ['proxy.corp.example']);
  await assert.rejects(setInfraCredential({ dataDir: data, name: 'other', credential: { kind: 'basic', user, password }, context: ctx }), (e) => e.code === 'no-such-ref');
  await assert.rejects(setInfraCredential({ dataDir: data, name: 'proxy', credential: { kind: 'private-key', pem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' }, context: ctx }), (e) => e.code === 'invalid-request');
  await assert.rejects(setInfraCredential({ dataDir: data, name: 'proxy', credential: { kind: 'basic', user: 'a:b', password }, context: ctx }), (e) => e.code === 'invalid-request' && !e.message.includes(password));
});

test('release build inputs (U call site): an inputs file the builder reads, secrets 0400 in a 0700 run dir; none without a config; stale runs swept', async () => {
  assert.equal(await releaseBuildInfra({ runId: 'b1', dataDir: tmp('aura-adm-') }), null);
  const f = exampleFixture();
  const data = tmp('aura-adm-');
  STORE.writeStore(STORE.infraDir(data), STORE.stageConfig(f.file));
  (await import(join(ROOT, 'os/infra/render.mjs'))).applyGenerated(STORE.infraDir(data));
  await assert.rejects(releaseBuildInfra({ runId: 'b0', dataDir: data, resolve: () => null }), (e) => e.code === 'infra-credential-unresolved');
  assert.equal(existsSync(join(data, 'aura/infra/run/b0')), false, 'a refused build leaves nothing');
  const r = await releaseBuildInfra({ runId: 'b1', dataDir: data, resolve: SEC.bootstrapResolver(f.creds) });
  assert.equal(statSync(r.dir).mode & 0o777, 0o700);
  const inputs = JSON.parse(readFileSync(r.file, 'utf8'));
  assert.equal(inputs.v, 1);
  assert.equal(inputs.buildArgs.DOCKER_IO_REGISTRY, 'artifactory.corp.example/docker-remote');
  assert.equal(inputs.env.HTTPS_PROXY, 'http://proxy.corp.example:3128');
  assert.ok(inputs.publicContext.endsWith(inputs.digest.slice(7)));
  assert.ok(inputs.caBundle.endsWith('corporate-ca.pem') && inputs.gitConfig.endsWith('gitconfig'));
  for (const file of Object.values(inputs.secrets)) assert.equal(statSync(file).mode & 0o777, 0o400);
  const text = readFileSync(r.file, 'utf8');
  for (const v of Object.values(CANARY)) assert.ok(!text.includes(v.split(':')[1]), 'the inputs file names paths, never values');
  await assert.rejects(releaseBuildInfra({ runId: '../x', dataDir: data, resolve: SEC.bootstrapResolver(f.creds) }));
  mkdirSync(join(data, 'aura/infra/run/old'), { recursive: true });
  const t = (Date.now() - 7 * 3600e3) / 1000;
  utimesSync(join(data, 'aura/infra/run/old'), t, t);
  assert.equal(sweepInfraRuns(data), 1);
  assert.ok(existsSync(r.dir), 'a running build is kept');
});
