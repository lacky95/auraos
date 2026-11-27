// D94 IC-5..IC-8 and philosophy audit #7: the propagation API with a real rendered config, the
// workload argv (no config = today), boot step 0 (internal traffic direct, the kernel's own fetch
// through the proxy), the bootstrap credential import and host binding, the O2 policy seed, the
// D64 entries and refusals, AuraOS's own endpoints, the doctor (categories, never a value) and
// install-time mTLS (adapter + the image build helper).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tmp } from './release-fixtures.mjs';
import { CANARY, EXAMPLE, exampleFixture } from './infra-fixtures.mjs';
import { BUILD_SECRET_IDS, INFRA_ROOT } from '../dist/infra/types.js';
import { InfraCredentialError, InfraPropagationError, buildSecrets, infraExecEnv, readInfraManifest, renderDigest } from '../dist/infra/propagate.js';
import { importBootstrapCredentials, credentialResolver, systemKeyFor } from '../dist/infra/credentials.js';
import { artifactUrl, infraPolicyOf, infraSpawnView, refusePublic, seedInfraPolicy } from '../dist/infra/policy.js';
import { DEFAULT_ENDPOINTS, infraEndpoints } from '../dist/infra/endpoints.js';
import { infraImageRef } from '../dist/infra/images.js';
import { isInternalHost, noProxyMatches } from '../dist/infra/kernel.js';
import { runInfraDoctor } from '../dist/infra/doctor.js';
import { containerInfraArgs, prootInfraBinds, sidecarInfraEnv } from '../dist/runtimes/spawn/infraArgs.js';
import { SECURITY_OPTIONS, securityOption, POLICY_OPTION_IDS, INFRA_PUBLIC_FALLBACK, INFRA_PROXY, INFRA_INHERIT, INFRA_PUBLIC_ROOTS, INFRA_CREDENTIAL_GRANTS } from '../dist/security/options.js';

const C = await import(join(ROOT, 'os/infra/config.mjs'));
const STORE = await import(join(ROOT, 'os/infra/store.mjs'));
const R = await import(join(ROOT, 'os/infra/render.mjs'));
const MTLS = await import(join(ROOT, 'os/infra/adapters/mtls.mjs'));
const A = await import(join(ROOT, 'os/infra/adapters/index.mjs'));
const INST = await import(join(ROOT, 'os/install/installer.mjs'));

const ENDPOINTS = `endpoints:
  nexusIndex: https://store.corp.example/index.yaml
  nexusStoreRepo: corp/auraos-store
  github: https://ghe.corp.example/
  githubApi: https://ghe.corp.example/api/v3
`;

/** A data dir with the example config stored and rendered (the shell's own system bundle). */
function renderedData(config = EXAMPLE) {
  const f = exampleFixture(config);
  const data = tmp('aura-infra-data-');
  const dir = STORE.infraDir(data);
  STORE.writeStore(dir, STORE.stageConfig(f.file));
  const r = R.applyGenerated(dir);
  return { ...f, data, dir, digest: r.digest };
}
const noCanary = (text, what) => {
  for (const v of [...Object.values(CANARY), 'PRIVATE KEY']) assert.ok(!String(text).includes(v.split(':').pop()), `${what} carries a secret`);
};

test('no config = today: no env, no spawn view, empty workload argv, no secrets, default endpoints', async () => {
  const data = tmp('aura-infra-none-');
  assert.equal(renderDigest(data), null);
  assert.equal(readInfraManifest(data), null);
  for (const c of ['kernel', 'app', 'sidecar', 'terminal', 'cap-installer', 'nexus', 'release-build']) assert.deepEqual(infraExecEnv(c, { dataDir: data }), {});
  assert.equal(await infraSpawnView(data, { inherit: 'defaults' }), null);
  assert.deepEqual(containerInfraArgs({ infra: undefined, appDataVolume: 'v' }), []);
  assert.deepEqual(prootInfraBinds({ infra: undefined, dataDir: data }), []);
  assert.deepEqual(sidecarInfraEnv(null), {});
  const s = await buildSecrets({ jobDir: join(data, 'job'), dataDir: data });
  assert.deepEqual(s.secrets, {});
  assert.deepEqual({ ...infraEndpoints(data), configured: [] }, { ...DEFAULT_ENDPOINTS, configured: [] });
  assert.equal(infraImageRef('postgres:16', data), 'postgres:16');
  assert.deepEqual(artifactUrl('https://github.com/x/y', data), { url: 'https://github.com/x/y', rewritten: false });
});

test('a rendered config: the non-secret env per consumer, NO_PROXY extras, infra-inherit none, never a credential', async () => {
  const d = renderedData();
  assert.match(renderDigest(d.data), /^sha256:[0-9a-f]{64}$/);
  const env = infraExecEnv('cap-installer', { dataDir: d.data });
  assert.equal(env.HTTPS_PROXY, 'http://proxy.corp.example:3128');
  assert.equal(env.SSL_CERT_FILE, `${INFRA_ROOT}/ca-bundle.pem`);
  assert.equal(env.NPM_CONFIG_GLOBALCONFIG, `${INFRA_ROOT}/npmrc`);
  const app = infraExecEnv('app', { dataDir: d.data, noProxyExtra: ['aura-com.example.x', 'aura-com.example.x--db'] });
  for (const k of ['NO_PROXY', 'no_proxy']) assert.match(app[k], /aura-shell.*aura-com\.example\.x,aura-com\.example\.x--db$/);
  assert.deepEqual(infraExecEnv('app', { dataDir: d.data, inherit: 'none' }), {});
  assert.deepEqual(infraExecEnv('sidecar', { dataDir: d.data, inherit: 'none' }), {});
  assert.notDeepEqual(infraExecEnv('terminal', { dataDir: d.data, inherit: 'none' }), {}, 'infra-inherit is about apps');
  noCanary(JSON.stringify(env), 'the exec env');
  // The workload view and argv.
  const view = await infraSpawnView(d.data, { inherit: 'defaults' });
  assert.equal(view.subpath, `aura/infra/generated/${d.digest.slice(7)}`);
  assert.equal(await infraSpawnView(d.data, { inherit: 'none' }), null);
  const argv = containerInfraArgs({ infra: view, appDataVolume: 'aura_aura-app-data', noProxyExtra: ['aura-x'] });
  assert.deepEqual(argv.slice(0, 2), ['--mount', `type=volume,source=aura_aura-app-data,target=/etc/aura/infra,volume-subpath=${view.subpath},readonly`]);
  assert.ok(argv.includes('HTTPS_PROXY=http://proxy.corp.example:3128'));
  assert.ok(argv.some((a) => /^NO_PROXY=.*,aura-x$/.test(a)));
  assert.deepEqual(prootInfraBinds({ infra: view, dataDir: d.data }), [`--bind=${join(d.data, view.subpath)}:/etc/aura/infra`]);
  assert.deepEqual(Object.keys(sidecarInfraEnv(view)).sort(), ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'], 'a foreign image gets no file pointer');
  noCanary(argv.join(' '), 'the container argv');
  // Mirrors: images and downloads.
  assert.equal(infraImageRef('postgres:16', d.data), 'artifactory.corp.example/docker-remote/library/postgres:16');
  assert.equal(infraImageRef('ghcr.io/o/i:1', d.data), 'artifactory.corp.example/ghcr-remote/o/i:1');
  assert.equal(infraImageRef('quay.io/o/i:1', d.data), 'quay.io/o/i:1');
  assert.deepEqual(artifactUrl('https://github.com/docker/compose/releases/download/v2/docker-compose-linux-', d.data),
    { url: 'https://artifactory.corp.example/github-releases/docker/compose/releases/download/v2/docker-compose-linux-', rewritten: true });
});

test('buildSecrets: every ref resolves or the build is refused; 0400 files of BUILD_SECRET_IDS, removed by dispose', async () => {
  const d = renderedData();
  const job = tmp('aura-job-');
  await assert.rejects(buildSecrets({ jobDir: job, dataDir: d.data, resolve: () => null }), (e) => e instanceof InfraCredentialError && e.code === 'infra-credential-unresolved' && !/CANARY/.test(e.message));
  const resolve = (await import(join(ROOT, 'os/infra/secrets.mjs'))).bootstrapResolver(d.creds);
  const s = await buildSecrets({ jobDir: job, dataDir: d.data, resolve });
  assert.deepEqual(Object.keys(s.secrets).sort(), ['infra_apt_auth', 'infra_git', 'infra_mtls', 'infra_npm_basic', 'infra_npmrc', 'infra_proxy']);
  for (const [id, f] of Object.entries(s.secrets)) {
    assert.ok(BUILD_SECRET_IDS.includes(id));
    assert.equal(statSync(f).mode & 0o777, 0o400);
  }
  assert.equal(statSync(join(job, 'infra-secrets')).mode & 0o777, 0o700);
  assert.match(readFileSync(s.secrets.infra_mtls, 'utf8'), /^# aura-mtls artifactory-mtls\n-----BEGIN PRIVATE KEY-----/);
  await s.dispose();
  assert.equal(existsSync(join(job, 'infra-secrets')), false);
});

test('a broken render fails closed: infraExecEnv and the spawn view refuse (infra-not-propagated)', async () => {
  const d = renderedData();
  writeFileSync(join(d.data, 'aura/infra/generated/current/manifest.json'), '{');
  assert.throws(() => infraExecEnv('app', { dataDir: d.data }), (e) => e instanceof InfraPropagationError);
  await assert.rejects(infraSpawnView(d.data, { inherit: 'defaults' }), (e) => e.code === 'infra-not-propagated');
});

test('first-boot import: bootstrap files sealed into the System Context (host-bound), refs rewritten, files deleted', async () => {
  const d = renderedData();
  const before = R.applyGenerated(d.dir).digest;
  INST.writeData({ data: d.data, credentials: d.creds });
  const imp = join(d.dir, 'import');
  assert.equal(statSync(imp).mode & 0o777, 0o700);
  for (const f of readdirSync(imp)) assert.equal(statSync(join(imp, f)).mode & 0o777, 0o600);
  const sealed = new Map();
  const r = await importBootstrapCredentials({ dataDir: d.data, context: { set: async (k, v, kind, inject) => { assert.equal(kind, 'secret'); assert.deepEqual(inject, []); sealed.set(k, v); } } });
  assert.deepEqual(r.imported.sort(), ['artifactory', 'artifactory-mtls-key', 'git', 'proxy']);
  assert.equal(r.bootstrapRefsLeft, 0);
  assert.equal(existsSync(imp), false, 'the import dir is gone');
  const text = readFileSync(join(d.dir, 'config.yaml'), 'utf8');
  assert.doesNotMatch(text, /bootstrap:/);
  assert.match(text, /system:INFRA_ARTIFACTORY_MTLS_KEY/);
  noCanary(text, 'the rewritten config');
  assert.ok(existsSync(join(d.dir, 'config.yaml.prev')));
  assert.equal(R.applyGenerated(d.dir).digest, before, 'the render does not change (refs are not rendered)');
  assert.deepEqual(JSON.parse(sealed.get(systemKeyFor('proxy'))).hosts, ['proxy.corp.example']);
  // The resolver reads them back for builds; a ref pointed at another host is refused.
  const cfg = STORE.readStore(d.dir).config;
  const ctx = { get: async (k) => sealed.get(k) ?? null };
  const res = await credentialResolver({ dataDir: d.data, refs: C.refsOf(cfg), context: ctx });
  assert.equal(res('system:INFRA_PROXY').password, CANARY.proxy.split(':')[1]);
  const moved = structuredClone(cfg);
  moved.network.proxy.https = 'http://evil.example:3128';
  await assert.rejects(credentialResolver({ dataDir: d.data, refs: C.refsOf(moved), context: ctx }), (e) => e.code === 'infra-credential-binding' && !/CANARY/.test(e.message));
  // Idempotent: nothing left to import.
  assert.deepEqual((await importBootstrapCredentials({ dataDir: d.data, context: { set: async () => assert.fail('no second import') } })).imported, []);
});

test('O2 seed: the policy block becomes the D64 values once (operator, audited) and leaves the config', async () => {
  const d = renderedData();
  const set = [], audit = [];
  const written = await seedInfraPolicy(d.data, { securityPolicy: { set: async (id, v) => { set.push([id, v]); } }, audit: { record: async (e) => { audit.push(e); } } });
  assert.deepEqual(written, [INFRA_PUBLIC_FALLBACK, INFRA_PROXY]);
  assert.deepEqual(set, [[INFRA_PUBLIC_FALLBACK, 'deny'], [INFRA_PROXY, 'configured']]);
  assert.equal(audit[0].action, 'infra.policy-seeded');
  assert.equal(audit[0].by.kind, 'operator');
  assert.equal(STORE.readStore(d.dir).config.policy, undefined);
  assert.deepEqual(await seedInfraPolicy(d.data, { securityPolicy: { set: async () => assert.fail('seeded twice') }, audit: { record: async () => undefined } }), []);
});

test('D64 infra-* entries (IC-6): registered with defaults = today, fresh, documented; deny refuses public endpoints', () => {
  const want = { [INFRA_PUBLIC_FALLBACK]: ['allow', ['allow', 'deny']], [INFRA_PROXY]: ['off', ['off', 'configured']], [INFRA_INHERIT]: ['defaults', ['defaults', 'none']], [INFRA_PUBLIC_ROOTS]: ['keep', ['keep', 'replace']] };
  for (const [id, [def, values]] of Object.entries(want)) {
    const o = securityOption(id);
    assert.deepEqual([o.default, [...o.values], o.source, o.change], [def, values, 'policy', 'fresh'], id);
    assert.ok(POLICY_OPTION_IDS.includes(id));
  }
  assert.equal(securityOption(INFRA_CREDENTIAL_GRANTS).source, 'reserved');
  assert.deepEqual(infraPolicyOf({}), { publicFallback: 'allow', proxy: 'off', inherit: 'defaults', publicRoots: 'keep' });
  assert.equal(infraPolicyOf({ [INFRA_PUBLIC_FALLBACK]: 'deny', [INFRA_INHERIT]: 'none' }).publicFallback, 'deny');
  assert.doesNotThrow(() => refusePublic({ publicFallback: 'allow' }, 'x', 'https://github.com/a', 'fix'));
  assert.throws(() => refusePublic({ publicFallback: 'deny' }, 'capability download', 'https://github.com/a/b', 'add a mirror'),
    (e) => e.code === 'infra-public-fallback-denied' && /capability download: github\.com .*deny; add a mirror/.test(e.message));
  assert.ok(SECURITY_OPTIONS.findIndex((o) => o.id === INFRA_PUBLIC_FALLBACK) > 0);
});

test('audit #7: endpoints in the config schema; the render carries them; the kernel reads them over the defaults', () => {
  const ok = C.parseInfraConfig(`version: 1\n${ENDPOINTS}`).config;
  assert.equal(ok.endpoints.nexusStoreRepo, 'corp/auraos-store');
  for (const [bad, path] of [['nexusIndex: https://x.example/catalog', 'endpoints.nexusIndex'], ['nexusStoreRepo: nope', 'endpoints.nexusStoreRepo'], ['github: https://u:p@ghe.example', 'endpoints.github'], ['gitlab: https://x', 'endpoints.gitlab']]) {
    assert.throws(() => C.parseInfraConfig(`version: 1\nendpoints:\n  ${bad}\n`), (e) => e.errors.some((x) => x.path === path), bad);
  }
  const d = renderedData(`version: 1\n${ENDPOINTS}`);
  const e = infraEndpoints(d.data);
  assert.deepEqual([e.nexusIndex, e.nexusStoreRepo, e.github, e.githubApi], ['https://store.corp.example/index.yaml', 'corp/auraos-store', 'https://ghe.corp.example', 'https://ghe.corp.example/api/v3']);
  assert.deepEqual([...e.configured].sort(), ['github', 'githubApi', 'nexusIndex', 'nexusStoreRepo']);
  assert.deepEqual(infraExecEnv('kernel', { dataDir: d.data }), {}, 'endpoints alone set no env');
  assert.ok(C.endpointsOf(ok).some((x) => x.kind === 'nexus'));
});

test('boot step 0 helpers: internal destinations stay direct; NO_PROXY matching like the tools', () => {
  for (const h of ['localhost', 'aura-shell', 'aura-com.aura.counter', 'aura-com.x--db', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '::1', 'fd00::1', 'valkey']) assert.ok(isInternalHost(h), h);
  for (const h of ['registry.npmjs.org', '8.8.8.8', '172.32.0.1', 'github.com', '2001:db8::1']) assert.ok(!isInternalHost(h), h);
  assert.ok(noProxyMatches('a.corp.example', '.corp.example,10.0.0.0/8'));
  assert.ok(noProxyMatches('corp.example', '.corp.example'));
  assert.ok(noProxyMatches('x.y', '*'));
  assert.ok(!noProxyMatches('github.com', '.corp.example,localhost'));
});

const STEP0 = `
import http from 'node:http';
const { loadInfrastructure } = await import(process.argv[1]);
const D = Symbol.for('undici.globalDispatcher.1');
const before = globalThis[D]?.constructor?.name ?? null;
const agent = http.globalAgent;
const st = loadInfrastructure({ dataDir: process.argv[2] });
const srv = http.createServer((q, s) => s.end('direct')).listen(0, '127.0.0.2');
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;
const viaHttp = await new Promise((r) => http.get({ host: '127.0.0.2', port }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(b)); }).on('error', (e) => r('err ' + e.code)));
const viaFetch = await fetch('http://127.0.0.2:' + port + '/').then((r) => r.text(), (e) => 'err ' + (e.cause?.code ?? e.message));
const external = await fetch('http://registry.example.test/x').then(() => 'answered', (e) => String(e.cause?.port ?? e.cause?.code ?? e.message));
srv.close();
console.log(JSON.stringify({ st, before, after: globalThis[D]?.constructor?.name ?? null, agentReplaced: http.globalAgent !== agent, viaHttp, viaFetch, external }));
`;

function step0(data, env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', STEP0, join(ROOT, 'packages/core/dist/infra/kernel.js'), data], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('boot step 0 without a config: the process is left exactly as it is (status none)', () => {
  const out = step0(tmp('aura-step0-none-'), {});
  assert.equal(out.st.state, 'none');
  assert.equal(out.st.configured, false);
  assert.equal(out.before, out.after);
  assert.equal(out.agentReplaced, false);
  assert.equal(out.viaHttp, 'direct');
});

test('boot step 0 with a proxy (as os/boot.sh starts the shell): internal traffic direct, the kernel\'s own fetch through the proxy', () => {
  const d = renderedData('version: 1\nnetwork:\n  proxy:\n    http: http://127.0.0.1:9\n    https: http://127.0.0.1:9\n');
  const env = Object.fromEntries(readFileSync(join(d.data, 'aura/infra/generated/current/env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  const out = step0(d.data, env);
  assert.equal(out.st.state, 'ok');
  assert.equal(out.st.proxy, 'configured');
  assert.equal(out.st.kernelProxy, true);
  assert.equal(out.before, 'EnvHttpProxyAgent');
  assert.equal(out.after, 'RoutingDispatcher');
  assert.equal(out.agentReplaced, true);
  assert.equal(out.viaHttp, 'direct', 'http to an internal host is not sent to the proxy');
  assert.equal(out.viaFetch, 'direct', 'fetch to an internal host is not sent to the proxy');
  assert.equal(out.external, '9', 'an external fetch goes to the configured proxy (127.0.0.1:9)');
});

test('boot step 0: a proxy configured after the shell started is reported (restart required), never half-applied', () => {
  const d = renderedData('version: 1\nnetwork:\n  proxy:\n    https: http://127.0.0.1:9\n');
  const out = step0(d.data, {});
  assert.equal(out.st.state, 'degraded');
  assert.equal(out.st.restartRequired, true);
  assert.match(out.st.issues.join(), /aura restart os/);
  assert.equal(out.viaHttp, 'direct');
});

test('doctor (IC-7) offline: config, render, certificates, policy consistency, credential refs; never a value', async () => {
  const none = await runInfraDoctor({ dataDir: tmp('aura-doc-none-'), network: false, policy: infraPolicyOf({}) });
  assert.deepEqual([none.configured, none.ok], [false, true]);
  const d = renderedData();
  const r = await runInfraDoctor({ dataDir: d.data, network: false, policy: infraPolicyOf({}) });
  assert.equal(r.configured, true);
  const by = (id) => r.checks.filter((c) => c.id === id);
  assert.equal(by('render')[0].status, 'ok');
  assert.ok(by('certificate').every((c) => c.status === 'ok'));
  assert.ok(by('policy').some((c) => /infra-proxy is off/.test(c.message)), 'proxy configured but the switch is off');
  assert.ok(by('credential').every((c) => c.status === 'fail'), 'bootstrap refs not imported');
  assert.equal(r.ok, false);
  noCanary(JSON.stringify(r), 'the doctor report');
  // Network probes with a fake fetch: categories, never a value.
  const net = await runInfraDoctor({
    dataDir: d.data, policy: infraPolicyOf({ [INFRA_PROXY]: 'configured' }), tcp: async () => true,
    fetch: async (url) => { if (String(url).includes('pypi')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }); return new Response('', { status: 200 }); },
  });
  assert.ok(net.checks.some((c) => c.id === 'proxy' && c.status === 'ok'));
  assert.ok(net.checks.some((c) => c.id === 'registry:python' && c.status === 'fail' && /TLS verification failed/.test(c.message)));
  assert.ok(net.checks.some((c) => c.id === 'registry:npm' && c.status === 'ok'));
  noCanary(JSON.stringify(net), 'the doctor report');
});

test('IC-8 mTLS: public certificates and the host table render; keys only in infra_mtls; one rule per tool', () => {
  const f = exampleFixture();
  const staged = STORE.stageConfig(f.file);
  const r = A.renderInfra(staged.config, { files: staged.files, systemBundle: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n' });
  assert.equal(r.files['mtls/clients'], 'artifactory-mtls\tartifactory.corp.example\n');
  assert.match(r.files['mtls/artifactory-mtls.crt'], /BEGIN CERTIFICATE/);
  noCanary(JSON.stringify(r), 'the public render');
  const resolve = (ref) => (ref === 'bootstrap:artifactory-mtls-key' ? { kind: 'private-key', pem: '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n' } : null);
  const sec = MTLS.secretFiles(staged.config, {}, resolve);
  assert.deepEqual(MTLS.splitKeys(sec.infra_mtls), { 'artifactory-mtls': '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n' });
  const t = MTLS.toolConfig(staged.config, (n) => ({ cert: `/c/${n}.crt`, key: `/k/${n}.key` }));
  assert.deepEqual(t.gitconfig, ['[http "https://artifactory.corp.example/"]', '\tsslCert = /c/artifactory-mtls.crt', '\tsslKey = /k/artifactory-mtls.key']);
  assert.deepEqual(t.npmrc, ['//artifactory.corp.example/:certfile=/c/artifactory-mtls.crt', '//artifactory.corp.example/:keyfile=/k/artifactory-mtls.key']);
  assert.match(t.aptconf.join('\n'), /Acquire::https::artifactory\.corp\.example::SslKey "\/k\/artifactory-mtls\.key";/);
  assert.deepEqual(t.pip, { cert: '/c/artifactory-mtls.crt', key: '/k/artifactory-mtls.key' });
});

test('IC-8 build-env.sh: the infra_mtls bundle is split into the step\'s tmpfs (0600); git, npm, apt and pip use it', () => {
  const f = exampleFixture();
  const staged = STORE.stageConfig(f.file);
  const ai = tmp('aura-ai-'), as = tmp('aura-as-'), aw = join(tmp('aura-aw-'), 'w'), ae = tmp('aura-ae-');
  R.writeTree(ai, R.renderTree(A.renderInfra(staged.config, { files: staged.files, systemBundle: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n' })).tree);
  const key = readFileSync(join(f.creds, 'artifactory-mtls-key'), 'utf8');
  writeFileSync(join(as, 'infra_mtls'), `# aura-mtls artifactory-mtls\n${key}`);
  writeFileSync(join(as, 'infra_git'), 'https://u:p@git.corp.example\n');
  mkdirSync(join(ae, 'sources.list.d'));
  writeFileSync(join(ae, 'sources.list'), 'deb http://deb.debian.org/debian bookworm main\n');
  const script = `. ${join(ROOT, 'os/infra/build-env.sh')}; env | grep -E '^(GIT_CONFIG|PIP_CLIENT_CERT|APT_CONFIG)' | sort; cat "$NPM_CONFIG_USERCONFIG"; cat "$APT_CONFIG"; stat -c %a ${aw}/mtls/artifactory-mtls.key`;
  const r = spawnSync('sh', ['-c', script], { env: { PATH: process.env.PATH, AURA_INFRA_DIR: ai, AURA_SECRETS_DIR: as, AURA_BUILD_TMP: aw, AURA_APT_ETC: ae }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /^GIT_CONFIG_COUNT=3$/m);
  assert.match(out, /^GIT_CONFIG_KEY_0=http\.https:\/\/artifactory\.corp\.example\/\.sslCert$/m);
  assert.match(out, new RegExp(`^GIT_CONFIG_VALUE_1=${aw}/mtls/artifactory-mtls\\.key$`, 'm'));
  assert.match(out, /^GIT_CONFIG_KEY_2=credential\.helper$/m);
  assert.match(out, /^\/\/artifactory\.corp\.example\/:keyfile=.*artifactory-mtls\.key$/m);
  assert.match(out, /Acquire::https::artifactory\.corp\.example::SslCert ".*\/mtls\/artifactory-mtls\.crt";/);
  assert.match(out, /^PIP_CLIENT_CERT=.*artifactory-mtls\.pip\.pem$/m);
  assert.match(out, /^600$/m);
  assert.equal(readFileSync(join(aw, 'mtls/artifactory-mtls.key'), 'utf8'), key);
  assert.doesNotMatch(readFileSync(join(ai, 'mtls/clients'), 'utf8') + readdirSync(ai, { recursive: true }).join(' '), /PRIVATE|\.key/);
});

test('twin: os/infra/propagate.mjs (builder, installer) answers exactly like core infra/propagate.ts on the same data roots', async () => {
  const OS = await import(join(ROOT, 'os/infra/propagate.mjs'));
  const none = tmp('aura-twin-none-');
  const d = renderedData();
  for (const data of [none, d.data]) {
    assert.equal(OS.renderDigest(data), renderDigest(data));
    for (const c of ['kernel', 'app', 'release-build']) {
      for (const o of [{}, { inherit: 'none' }, { noProxyExtra: ['aura-x'] }]) assert.deepEqual(OS.infraExecEnv(c, { dataDir: data, ...o }), infraExecEnv(c, { dataDir: data, ...o }));
    }
  }
  const SEC = await import(join(ROOT, 'os/infra/secrets.mjs'));
  const resolve = SEC.bootstrapResolver(d.creds);
  const [a, b] = [await OS.buildSecrets({ jobDir: tmp('aura-tw-a-'), dataDir: d.data, resolve }), await buildSecrets({ jobDir: tmp('aura-tw-b-'), dataDir: d.data, resolve })];
  assert.deepEqual(Object.keys(a.secrets).sort(), Object.keys(b.secrets).sort());
  for (const id of Object.keys(a.secrets)) assert.equal(readFileSync(a.secrets[id], 'utf8'), readFileSync(b.secrets[id], 'utf8'), id);
  await assert.rejects(OS.buildSecrets({ jobDir: tmp('aura-tw-c-'), dataDir: d.data, resolve: () => null }), (e) => e.code === 'infra-credential-unresolved');
  await a.dispose(); await b.dispose();
  writeFileSync(join(d.data, 'aura/infra/generated/current/manifest.json'), '{');
  assert.throws(() => OS.infraExecEnv('app', { dataDir: d.data }), (e) => e.code === 'infra-not-propagated');
});
