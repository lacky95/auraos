// D94 IC-1 (+ the installer's IC-2 rendering): the infrastructure config
// schema, its YAML subset, the store, credential refs and the secret rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { ROOT, tmp } from './release-fixtures.mjs';
import { CANARY, EXAMPLE, exampleFixture } from './infra-fixtures.mjs';

const C = await import(join(ROOT, 'os/infra/config.mjs'));
const SEC = await import(join(ROOT, 'os/infra/secrets.mjs'));
const STORE = await import(join(ROOT, 'os/infra/store.mjs'));
const INST = await import(join(ROOT, 'os/install/installer.mjs'));
const YAML = createRequire(import.meta.url)('yaml');

const walk = (d) => readdirSync(d, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => relative(d, join(e.parentPath ?? e.path, e.name)));
const errorsOf = (text) => { try { C.parseInfraConfig(text); return []; } catch (e) { return e.errors.map((x) => `${x.path}: ${x.message}`); } };

test('the YAML subset reads the D94 example exactly like the yaml package', () => {
  assert.deepEqual(C.parseYaml(EXAMPLE), YAML.parse(EXAMPLE));
  const more = 'a:\n  - x\n  - y: 1\n    z: [1, 2]\n  -\n    w: "q\\"uote"\nb: \'it\'\'s\'\nc: ~\nd: true\ne:\n- 1\nf: {}\ng: []\n';
  assert.deepEqual(C.parseYaml(more), YAML.parse(more));
  assert.deepEqual(C.parseYaml('{"version": 1, "policy": {"proxy": "off"}}'), { version: 1, policy: { proxy: 'off' } }, 'JSON is accepted');
  for (const bad of ['a: &x 1\nb: *x\n', 'a: |\n  text\n', 'a: !!str 1\n', 'a:\n\t- 1\n', 'a: 1\n---\nb: 2\n', 'a: 1\na: 2\n', 'a: [1, 2\n', 'a: @x\n']) {
    assert.throws(() => C.parseYaml(bad), (e) => e.code === 'yaml', JSON.stringify(bad));
  }
});

test('the toYaml output reads back the same', () => {
  const cfg = C.parseYaml(EXAMPLE);
  assert.deepEqual(C.parseYaml(C.toYaml(cfg)), cfg);
  assert.deepEqual(YAML.parse(C.toYaml(cfg)), cfg);
});

test('the D94 example is valid; NO_PROXY always carries the AuraOS internal names', () => {
  const { config, warnings } = C.parseInfraConfig(EXAMPLE);
  assert.deepEqual(warnings, []);
  const np = C.computeNoProxy(config).split(',');
  for (const n of ['.corp.example', 'localhost', '127.0.0.1', 'aura-shell']) assert.ok(np.includes(n), n);
  assert.equal(C.computeNoProxy({}), C.INTERNAL_NO_PROXY.join(','));
  assert.equal(C.rewriteImage('node:22.23.5-bookworm', config.registries.oci.mirrors), 'artifactory.corp.example/docker-remote/library/node:22.23.5-bookworm');
  assert.equal(C.rewriteImage('ghcr.io/o/i:1', config.registries.oci.mirrors), 'artifactory.corp.example/ghcr-remote/o/i:1');
  assert.equal(C.rewriteImage('quay.io/o/i:1', config.registries.oci.mirrors), 'quay.io/o/i:1');
  assert.equal(C.rewriteUrl('https://github.com/a/b', config.registries.artifacts.rewrites), 'https://artifactory.corp.example/github-releases/a/b');
});

test('schema: no secrets, no TLS weakening, no userinfo, no unknown or beta fields', () => {
  const cases = {
    'network:\n  proxy:\n    http: http://u:p@proxy:3128\n': /no user:password in URLs/,
    'registries:\n  npm: { url: "https://r/", strict-ssl: false }\n': /TLS verification can never be turned off/,
    'registries:\n  python: { index: "https://r/simple", trusted-host: r }\n': /TLS verification/,
    'network:\n  proxy:\n    http: http://proxy:3128\n    password: hunter2\n': /secrets never go into the config/,
    'registries:\n  npm: { url: "https://r/?_authToken=abcdefabcdefabcdef" }\n': /credentials in the query/,
    'registries:\n  maven: { url: "https://r/" }\n': /beta/,
    'mystery: 1\n': /unknown field/,
    'network:\n  proxy:\n    http: http://proxy:3128\n    credential: { ref: "user:mine" }\n': /user: refs/,
    'network:\n  proxy:\n    http: http://proxy:3128\n    noProxy: ["*"]\n': /bypass/,
    'network:\n  dns: [8.8.8.8, not-an-ip]\n': /IP address/,
    'clientCertificates:\n  - name: x\n    hosts: [h.example]\n    certificate: { file: c.crt }\n    key: "-----BEGIN PRIVATE KEY-----abc"\n': /private key in the config/,
    'policy:\n  proxy: enforced\n': /beta/,
  };
  for (const [body, re] of Object.entries(cases)) {
    const errs = errorsOf(`version: 1\n${body}`);
    assert.ok(errs.some((e) => re.test(e)), `${body} → ${errs.join(' | ')}`);
  }
  assert.ok(errorsOf('version: 2\n').some((e) => /version/.test(e)));
  const { warnings } = C.parseInfraConfig('version: 1\nregistries:\n  npm: { url: "http://npm.internal/" }\n');
  assert.ok(warnings.some((w) => /unencrypted/.test(w.message)), 'http:// registries are allowed and reported (D91)');
  for (const dns of ['host', 'default', '[10.1.1.1, 10.1.1.2]', '{ servers: [10.1.1.1], search: [corp.example] }']) {
    assert.deepEqual(errorsOf(`version: 1\nnetwork:\n  dns: ${dns}\n`), [], dns);
  }
});

test('refs carry their allowed hosts (host binding, D94 §7.4)', () => {
  const refs = C.refsOf(C.parseInfraConfig(EXAMPLE).config);
  const proxy = refs.find((r) => r.ref === 'bootstrap:proxy');
  assert.deepEqual(proxy.hosts, ['proxy.corp.example']);
  const git = refs.find((r) => r.ref === 'bootstrap:git');
  assert.deepEqual(git.hosts, ['git.corp.example']);
  assert.ok(refs.find((r) => r.path.startsWith('clientCertificates.')).hosts.includes('artifactory.corp.example'));
});

test('bootstrap credentials: 0600 and a valid format, checked without printing a value', () => {
  const f = exampleFixture();
  const cfg = C.parseInfraConfig(EXAMPLE).config;
  assert.equal(SEC.checkConfigCredentials(cfg, f.creds).ok, true);
  chmodSync(join(f.creds, 'proxy'), 0o644);
  const r = SEC.checkConfigCredentials(cfg, f.creds);
  assert.equal(r.ok, false);
  const bad = r.refs.find((x) => x.ref === 'bootstrap:proxy');
  assert.equal(bad.status, 'mode');
  assert.doesNotMatch(JSON.stringify(r), /CANARY/);
  chmodSync(join(f.creds, 'proxy'), 0o600);
  writeFileSync(join(f.creds, 'git'), 'no-colon-here\n', { mode: 0o600 });
  assert.equal(SEC.checkConfigCredentials(cfg, f.creds).refs.find((x) => x.ref === 'bootstrap:git').status, 'format');
  assert.equal(SEC.checkConfigCredentials(cfg, undefined).ok, false);
});

test('build secrets: per-ecosystem files from the credentials; never in public output', () => {
  const f = exampleFixture();
  const cfg = C.parseInfraConfig(EXAMPLE).config;
  const s = SEC.renderBuildSecrets(cfg, f.creds);
  assert.deepEqual(Object.keys(s).sort(), ['infra_apt_auth', 'infra_git', 'infra_mtls_artifactory_mtls_key', 'infra_npm_basic', 'infra_npmrc', 'infra_proxy']);
  assert.equal(s.infra_proxy, `http://${CANARY.proxy}@proxy.corp.example:3128/\n`);
  assert.match(s.infra_npmrc, /^\/\/artifactory\.corp\.example\/api\/npm\/npm-remote\/:_auth=/);
  assert.match(s.infra_apt_auth, /^machine artifactory\.corp\.example\/debian-remote login art password ART-CANARY-tok3n$/m);
  assert.match(s.infra_mtls_artifactory_mtls_key, /PRIVATE KEY/);
  // The non-secret override and env carry none of it.
  const override = INST.renderInfraOverride(cfg, { publicDir: '/x', hasCorporateCa: true });
  assert.doesNotMatch(override + JSON.stringify(INST.proxyEnv(cfg)), /CANARY|PRIVATE KEY/);
  assert.match(override, /NODE_EXTRA_CA_CERTS: \/etc\/aura\/infra-install\/corporate-ca.pem/);
  const o = YAML.parse(override);
  assert.deepEqual(o.services['aura-os'].volumes, ['/x:/etc/aura/infra-install:ro']);
  // O11: dns: host is the default resolver, so the override sets no dns; the image args are registry prefixes only.
  assert.equal(o.services['aura-os'].dns, undefined);
  assert.deepEqual(o.services['aura-base'].build.args, { DOCKER_IO_REGISTRY: 'artifactory.corp.example/docker-remote' });
  assert.deepEqual(o.services['aura-base'].build.additional_contexts, { 'aura-infra-public': '/x' });
  for (const [dns, want] of [['[10.1.1.1]', ['10.1.1.1']], ['{ servers: [10.2.2.2], search: [corp.example] }', ['10.2.2.2']], ['default', undefined]]) {
    const c = C.parseInfraConfig(`version: 1\nnetwork:\n  dns: ${dns}\n`).config;
    assert.deepEqual(YAML.parse(INST.renderInfraOverride(c, { publicDir: '/x' })).services['aura-os'].dns, want, dns);
  }
});

test('redactSecrets: userinfo, auth headers, npm auth, PEM keys and known values', () => {
  const pem = execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519']).toString();
  const text = [
    `fetch https://${['bob', 'hunter2'].join(':')}@git.corp.example/x.git`, 'Proxy-Authorization: Basic Ym9iOmh1bnRlcjI=', 'authorization: Bearer abc.def',
    '//r/:_authToken=npm_abcdef', '//r/:_auth=Ym9i', pem, 'value TOKEN-123-known', `b64 ${Buffer.from('TOKEN-123-known').toString('base64')}`,
  ].join('\n');
  const out = SEC.redactSecrets(text, ['TOKEN-123-known']);
  for (const leak of ['hunter2', 'Ym9iOmh1bnRlcjI=', 'abc.def', 'npm_abcdef', 'Ym9i\n', pem.split('\n')[1], 'TOKEN-123-known', Buffer.from('TOKEN-123-known').toString('base64')]) {
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  }
  assert.match(out, /https:\/\/\*\*\*@git\.corp\.example/);
});

test('store: staged paths, atomic write with .prev, seed import only when absent; certificates checked', () => {
  const f = exampleFixture();
  const staged = STORE.stageConfig(f.file);
  assert.deepEqual(Object.keys(staged.files).sort(), ['trust/client-artifactory-mtls.crt', 'trust/corp-root.pem']);
  assert.equal(staged.config.trust.caCertificates[0].file, 'trust/corp-root.pem');
  const seed = join(tmp(), 'seed');
  STORE.writeSeed(seed, staged);
  const data = tmp('aura-data-');
  const dir = STORE.infraDir(data);
  assert.deepEqual(STORE.importSeedIfAbsent(dir, seed), { imported: true, digest: staged.digest });
  assert.equal(statSync(join(dir, 'config.yaml')).mode & 0o777, 0o640);
  assert.equal(STORE.readStore(dir).digest, staged.digest);
  assert.deepEqual(STORE.importSeedIfAbsent(dir, seed), { imported: false, reason: 'present' }, 'never a silent overwrite');
  STORE.writeStore(dir, STORE.stageConfig(f.file));
  assert.ok(existsSync(join(dir, 'config.yaml.prev')));
  assert.doesNotMatch(readFileSync(join(dir, 'config.yaml'), 'utf8'), /CANARY/);
  // Invalid content never replaces the stored config.
  assert.throws(() => STORE.writeStore(dir, { text: 'version: 1\nbad: 1\n', files: {} }), (e) => e.code === 'invalid-config');
  assert.equal(STORE.readStore(dir).digest, staged.digest);
  // A CA file with a private key, or an expired certificate, is refused.
  writeFileSync(join(f.dir, 'certs/corp-root.pem'), execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519']));
  assert.throws(() => STORE.stageConfig(f.file), (e) => e.errors.some((x) => /private key/.test(x.message)));
  const expired = exampleFixture();
  assert.throws(() => STORE.stageConfig(expired.file, { now: new Date(Date.now() + 400 * 864e5) }), (e) => e.errors.some((x) => /expired/.test(x.message)));
  const soon = STORE.stageConfig(expired.file, { now: new Date(Date.now() + 75 * 864e5) });
  assert.ok(soon.warnings.some((w) => /expires/.test(w.message)));
});

test('installer stage: credentials 0600 outside the checkout, public and secret parts apart', () => {
  const f = exampleFixture();
  const state = tmp('aura-state-');
  const r = INST.stage({ config: f.file, credentialsDir: f.creds, stateDir: state });
  assert.deepEqual(r.credentials.sort(), ['artifactory', 'artifactory-mtls-key', 'git', 'proxy']);
  for (const n of r.credentials) assert.equal(statSync(join(state, 'credentials', n)).mode & 0o777, 0o600);
  assert.equal(statSync(join(state, 'credentials')).mode & 0o777, 0o700);
  for (const id of r.secrets) assert.equal(statSync(join(state, 'rendered/secrets', id)).mode & 0o777, 0o600);
  const pub = join(state, 'rendered/public');
  const publicText = ['compose.infra.yml', 'seed/config.yaml', ...walk(pub).map((f) => join('rendered/public', f))]
    .map((p) => readFileSync(join(state, p), 'utf8')).join('\n');
  for (const f of ['ca-bundle.pem', 'corporate-ca.pem', 'env', 'npmrc', 'gitconfig', 'apt/apt.conf.d/90aura-infra', 'manifest.json']) assert.ok(existsSync(join(pub, f)), f);
  assert.doesNotMatch(publicText, /CANARY|PRIVATE KEY/);
  const secretsOverride = readFileSync(join(state, 'compose.secrets.yml'), 'utf8');
  assert.doesNotMatch(secretsOverride, /CANARY/, 'the override names files, never values');
  assert.equal(YAML.parse(secretsOverride).secrets.infra_proxy.file, join(state, 'rendered/secrets/infra_proxy'));
});

test('requirements and the deny audit read the Dockerfile and lockfile', () => {
  const cfg = C.parseInfraConfig(EXAMPLE).config;
  const req = INST.requirements(ROOT, cfg);
  assert.ok(req.images.some((i) => /^node:22/.test(i.image)));
  assert.ok(req.images.some((i) => i.image === 'valkey/valkey:8-bookworm' && i.via === 'artifactory.corp.example/docker-remote/valkey/valkey:8-bookworm'));
  assert.ok(req.clones.some((c) => c.url === 'https://github.com/proot-me/proot' && c.via.startsWith('https://git.corp.example/')));
  assert.match(req.npm.pnpm, /^\d+\.\d+\.\d+$/, 'pnpm is pinned');
  assert.ok(req.npm.packages > 100);
  const open = C.parseInfraConfig('version: 1\npolicy:\n  publicFallback: deny\n').config;
  const hits = INST.auditPublic(ROOT, open);
  assert.ok(hits.some((h) => /^image node:/.test(h)) && hits.some((h) => /^npm:/.test(h)), hits.join('\n'));
  assert.deepEqual(INST.auditPublic(ROOT, C.parseInfraConfig('version: 1\n').config), [], 'allow (the default) audits nothing');
});
