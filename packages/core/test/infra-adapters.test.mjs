// D94 IC-3 + IC-4: the alpha adapters (goldens, idempotent re-apply, never a
// TLS bypass, no canary secret in a public output), the real tools reading the
// rendered system layer with user and project files still winning, the image
// build helper (os/infra/build-env.sh), and the Dockerfile/compose rules.
//
// Golden: test/golden/infra-adapters.json. An intended change to an adapter's
// output updates it in the same commit; a missing file is written from the
// current code and the test fails (like golden-spawn-args).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, tmp } from './release-fixtures.mjs';
import { CANARY, EXAMPLE, exampleFixture } from './infra-fixtures.mjs';

const C = await import(join(ROOT, 'os/infra/config.mjs'));
const A = await import(join(ROOT, 'os/infra/adapters/index.mjs'));
const R = await import(join(ROOT, 'os/infra/render.mjs'));
const SEC = await import(join(ROOT, 'os/infra/secrets.mjs'));
const STORE = await import(join(ROOT, 'os/infra/store.mjs'));
const INST = await import(join(ROOT, 'os/install/installer.mjs'));
const YAML = createRequire(import.meta.url)('yaml');
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'infra-adapters.json');

// The example as the store keeps it (file paths rewritten), with fixed stand-in PEMs: goldens stay byte-stable.
const storeForm = (text) => text.replace('./certs/corp-root.pem', 'trust/corp-root.pem').replace('./certs/aura-system.crt', 'trust/client-artifactory-mtls.crt');
const FILES = { 'trust/corp-root.pem': '-----BEGIN CERTIFICATE-----\nCORP-ROOT\n-----END CERTIFICATE-----\n', 'trust/client-artifactory-mtls.crt': '-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----\n' };
const SYSTEM = '-----BEGIN CERTIFICATE-----\nPUBLIC-ROOTS\n-----END CERTIFICATE-----\n';
const cfgOf = (text) => C.parseInfraConfig(text).config;
const VIEW = { files: FILES, systemBundle: SYSTEM };
const CASES = {
  example: storeForm(EXAMPLE),
  'proxy-only': 'version: 1\nnetwork:\n  proxy:\n    https: http://proxy.corp.example:3128\n',
  'ca-replace': 'version: 1\ntrust:\n  caCertificates:\n    - { name: corp-root, file: trust/corp-root.pem }\n  publicRoots: replace\n',
  'http-index': 'version: 1\nregistries:\n  python: { index: "http://pypi.internal/simple" }\n  npm: { url: "http://npm.internal/" }\n',
};
const walk = (d) => readdirSync(d, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => relative(d, join(e.parentPath ?? e.path, e.name))).sort();

test('goldens: each case renders byte-stable files, env and system paths', () => {
  const got = Object.fromEntries(Object.entries(CASES).map(([k, t]) => [k, A.renderInfra(cfgOf(t), VIEW)]));
  if (!existsSync(GOLDEN)) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
    assert.fail(`wrote ${GOLDEN}: review and commit it`);
  }
  assert.deepEqual(got, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});

test('no config, or one without network/trust/registries, renders nothing (today\'s behaviour)', () => {
  for (const c of [null, cfgOf('version: 1\n'), cfgOf('version: 1\nnetwork:\n  dns: host\n'), cfgOf('version: 1\npolicy:\n  publicFallback: allow\n')]) {
    const r = A.renderInfra(c, VIEW);
    assert.ok(A.isEmptyRender(r), JSON.stringify(r));
    assert.deepEqual(r.systemPaths, {});
    assert.deepEqual(A.renderSecrets(c, () => null), {});
  }
  // The proxy alone touches only what reads a proxy; no CA env, no registry pointer.
  const p = A.renderInfra(cfgOf(CASES['proxy-only']), VIEW);
  assert.deepEqual(Object.keys(p.env).filter((k) => /CA|CERT|REGISTRY|GLOBALCONFIG|GIT_CONFIG/.test(k)), ['NPM_CONFIG_GLOBALCONFIG']);
  assert.equal(p.env.NODE_USE_ENV_PROXY, '1');
});

test('NO_PROXY: AuraOS internals always, both cases, runtime extras appended', () => {
  const r = A.renderInfra(cfgOf(CASES.example), { ...VIEW, noProxyExtra: ['172.30.0.0/16', 'box.corp.example'] });
  assert.equal(r.env.NO_PROXY, r.env.no_proxy);
  const np = r.env.NO_PROXY.split(',');
  for (const n of [...C.INTERNAL_NO_PROXY, '.corp.example', '172.30.0.0/16', 'box.corp.example']) assert.ok(np.includes(n), n);
  assert.equal(new Set(np).size, np.length, 'no duplicates');
  assert.ok(A.proxy.bypassesProxy('artifactory.corp.example', r.env.NO_PROXY));
  assert.ok(!A.proxy.bypassesProxy('deb.debian.org', r.env.NO_PROXY));
});

test('trust: keep needs the public roots; replace trusts only the corporate CAs (Node via the OpenSSL store)', () => {
  assert.throws(() => A.renderInfra(cfgOf(CASES.example), { files: FILES }), (e) => e.code === 'no-system-bundle');
  const keep = A.renderInfra(cfgOf(CASES.example), VIEW);
  assert.ok(keep.files['ca-bundle.pem'].includes('PUBLIC-ROOTS') && keep.files['ca-bundle.pem'].includes('CORP-ROOT'));
  assert.equal(keep.env.NODE_EXTRA_CA_CERTS, `${A.INFRA_ROOT}/corporate-ca.pem`);
  assert.equal(keep.env.NODE_OPTIONS, '--disable-warning=UNDICI-EHPA', 'keep: no --use-openssl-ca (the example has a proxy)');
  const rep = A.renderInfra(cfgOf(CASES['ca-replace']), { files: FILES });
  assert.ok(!rep.files['ca-bundle.pem'].includes('PUBLIC-ROOTS'));
  assert.equal(rep.env.NODE_OPTIONS, '--use-openssl-ca');
});

test('never a TLS bypass; trusted-host only for an explicit http:// index', () => {
  for (const [k, t] of Object.entries(CASES)) {
    const r = A.renderInfra(cfgOf(t), k === 'ca-replace' ? { files: FILES } : VIEW);
    const all = [...Object.values(r.files), ...Object.entries(r.env).map(([a, b]) => `${a}=${b}`)].join('\n');
    for (const re of A.TLS_BYPASS) assert.doesNotMatch(all, re, `${k}: ${re}`);
    const pip = r.files['xdg/pip/pip.conf'] ?? '';
    if (k === 'http-index') assert.match(pip, /^trusted-host = pypi\.internal$/m);
    else assert.doesNotMatch(pip, /trusted-host/);
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'os/infra/build-env.sh'), 'utf8').replace(/^#.*$/gm, ''), /--insecure|-k\b|NODE_TLS_REJECT|Verify-Peer|AllowInsecure|allow-unauthenticated/);
});

test('canary secrets: in the per-operation secret files only, never in the public render or the generated dir', () => {
  const f = exampleFixture();
  const cfg = C.parseInfraConfig(EXAMPLE).config;
  const resolve = SEC.bootstrapResolver(f.creds);
  const secrets = A.renderSecrets(cfg, resolve);
  assert.deepEqual(Object.keys(secrets), ['infra_apt_auth', 'infra_docker_config', 'infra_git', 'infra_npm_basic', 'infra_npmrc', 'infra_pip', 'infra_proxy']);
  assert.match(secrets.infra_npm_basic, /ART-CANARY/);
  assert.match(Buffer.from(JSON.parse(secrets.infra_docker_config).auths['artifactory.corp.example'].auth, 'base64').toString(), /ART-CANARY/);
  const staged = STORE.stageConfig(f.file);
  const pub = A.renderInfra(staged.config, { files: staged.files, systemBundle: SYSTEM });
  const { tree } = R.renderTree(pub);
  const text = Object.values(tree).join('\n');
  for (const v of Object.values(CANARY)) for (const part of [v, v.split(':')[1]]) assert.ok(!text.includes(part), `leaked ${part}`);
  assert.doesNotMatch(text, /PRIVATE KEY|_auth|password/i);
  // The redactor knows every secret form the adapters produce.
  const red = SEC.redactSecrets(Object.values(secrets).join('\n'), SEC.knownSecretValues(cfg, f.creds));
  for (const v of Object.values(CANARY)) assert.ok(!red.includes(v.split(':')[1]), 'redacted');
  assert.doesNotMatch(SEC.redactSecrets(secrets.infra_docker_config), /"auth": "[^*]/);
});

test('generated dir: atomic current link, re-apply idempotent, previous kept, no config removes it', () => {
  const f = exampleFixture();
  const data = tmp('aura-data-');
  const dir = STORE.infraDir(data);
  assert.deepEqual(R.applyGenerated(dir, { systemBundle: SYSTEM }), { digest: null, dir: null, changed: false });
  STORE.writeStore(dir, STORE.stageConfig(f.file));
  const a = R.applyGenerated(dir, { systemBundle: SYSTEM });
  assert.equal(a.changed, true);
  const cur = join(dir, 'generated', 'current');
  assert.ok(lstatSync(cur).isSymbolicLink());
  assert.equal(readlinkSync(cur), a.digest.slice(7));
  const m1 = statSync(join(cur, 'npmrc')).mtimeMs;
  const b = R.applyGenerated(dir, { systemBundle: SYSTEM });
  assert.deepEqual(b, { ...a, changed: false }, 're-apply: same digest, nothing written');
  assert.equal(statSync(join(cur, 'npmrc')).mtimeMs, m1);
  const manifest = JSON.parse(readFileSync(join(cur, 'manifest.json'), 'utf8'));
  assert.equal(manifest.digest, a.digest);
  assert.match(readFileSync(join(cur, 'env.sh'), 'utf8'), /^export NPM_CONFIG_GLOBALCONFIG='\/etc\/aura\/infra\/npmrc'$/m);
  for (const p of walk(cur)) assert.equal(statSync(join(cur, p)).mode & 0o022, 0, `${p} not group/other writable`);
  // A changed config renders a new digest; the previous dir stays for rollback, older ones go.
  STORE.writeStore(dir, STORE.stageConfig(writeCfg(f, EXAMPLE.replace('proxy.corp.example:3128', 'proxy2.corp.example:3128'))));
  const c = R.applyGenerated(dir, { systemBundle: SYSTEM });
  assert.notEqual(c.digest, a.digest);
  assert.deepEqual(readdirSync(join(dir, 'generated')).sort(), [a.digest.slice(7), c.digest.slice(7), 'current'].sort());
  // CLI: what os/boot.sh runs.
  const out = execFileSync(process.execPath, [join(ROOT, 'os/infra/render.mjs'), 'apply', '--data', data, '--system-bundle', writeSys()]).toString();
  assert.match(out, /^infra: sha256:[0-9a-f]{64} \((rendered|unchanged)\)$/m);
});

const writeCfg = (f, text) => { const p = join(f.dir, 'infra2.yaml'); writeFileSync(p, text); return p; };
const writeSys = () => { const p = join(tmp(), 'sys.pem'); writeFileSync(p, SYSTEM); return p; };

test('apt: mirrors keep the path; the managed block replaces only itself', () => {
  const m = { 'deb.debian.org': 'https://m.corp/debian-remote/', 'security.debian.org': 'https://m.corp/sec' };
  const deb822 = 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates\n\nTypes: deb\nURIs: http://deb.debian.org/debian-security\n';
  assert.equal(A.apt.rewriteAptSources(deb822, m), deb822.replaceAll('http://deb.debian.org', 'https://m.corp/debian-remote'));
  assert.equal(A.apt.rewriteAptSources('deb http://security.debian.org/debian-security bookworm-security main\ndeb http://deb.debian.org.evil/x y\n', m),
    'deb https://m.corp/sec/debian-security bookworm-security main\ndeb http://deb.debian.org.evil/x y\n');
  const orig = '# keep\nfoo\n';
  const once = A.apt.withManagedBlock(orig, 'a\nb');
  assert.ok(once.startsWith(orig));
  assert.equal(A.apt.withManagedBlock(once, 'a\nb'), once, 'idempotent');
  assert.equal(A.apt.withManagedBlock(A.apt.withManagedBlock(once, 'c'), null), orig, 'removal restores the text byte-identically');
});

// ── the image build helper ──────────────────────────────────────────────────

function runHelper({ files = {}, secrets = {}, sources = {}, script = 'env' } = {}) {
  const d = tmp('aura-buildenv-');
  const ai = join(d, 'infra'), as = join(d, 'secrets'), aw = join(d, 'build'), ae = join(d, 'apt');
  for (const [dir, map] of [[ai, files], [as, secrets], [ae, sources]]) {
    mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(map)) { mkdirSync(dirname(join(dir, k)), { recursive: true }); writeFileSync(join(dir, k), v); }
  }
  mkdirSync(join(ae, 'sources.list.d'), { recursive: true });
  const env = { PATH: process.env.PATH, AURA_INFRA_DIR: ai, AURA_SECRETS_DIR: as, AURA_BUILD_TMP: aw, AURA_APT_ETC: ae };
  const r = spawnSync('sh', ['-c', `. "$0" || exit 9; ${script}`, join(ROOT, 'os/infra/build-env.sh')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, aw, d };
}

test('build-env.sh without a config (the empty context): no env, URLs unchanged, nothing written', () => {
  const { out, aw } = runHelper({ script: 'env | grep -v "^AURA_\\|^PATH=\\|^PWD=\\|^SHLVL=\\|^_=" ; aura_url https://github.com/x/y' });
  assert.equal(out, 'https://github.com/x/y\n');
  assert.equal(existsSync(aw), false);
});

test('build-env.sh with the rendered config and secrets: env, rewrites, apt mirror parity, auth only in the tmpfs', () => {
  const cfg = cfgOf(CASES.example);
  const { tree } = R.renderTree(A.renderInfra(cfg, VIEW));
  const f = exampleFixture();
  const secrets = SEC.renderBuildSecrets(C.parseInfraConfig(EXAMPLE).config, f.creds);
  const deb822 = 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm\n\nTypes: deb\nURIs: http://deb.debian.org/debian-security\nSuites: bookworm-security\n';
  const { out, aw } = runHelper({
    files: tree, secrets, sources: { 'sources.list.d/debian.sources': deb822 },
    script: 'echo "P=$HTTPS_PROXY"; echo "N=$NO_PROXY"; echo "U=$NPM_CONFIG_USERCONFIG"; echo "A=$APT_CONFIG"; echo "G=$GIT_CONFIG_VALUE_0"; echo "C=$COREPACK_NPM_USERNAME"; aura_url https://github.com/project-zot/zot/releases/download/v1/zot; aura_url https://example.org/x',
  });
  const v = Object.fromEntries(out.trim().split('\n').filter((l) => /^[A-Z]=/.test(l)).map((l) => [l[0], l.slice(2)]));
  assert.equal(v.P, `http://${CANARY.proxy}@proxy.corp.example:3128/`, 'the secret proxy URL, for this step only');
  assert.match(v.N, /aura-shell/);
  assert.equal(v.U, join(aw, 'npmrc'));
  assert.match(readFileSync(v.U, 'utf8'), /registry=https:\/\/artifactory[\s\S]*_auth=/, 'public npmrc + auth (pnpm reads no global npmrc)');
  assert.equal(v.C, 'art');
  assert.match(v.G, /^store --file=.*infra_git$/);
  assert.match(out, /^https:\/\/artifactory\.corp\.example\/github-releases\/project-zot\/zot\/releases\/download\/v1\/zot$/m);
  assert.match(out, /^https:\/\/example\.org\/x$/m);
  const aptConf = readFileSync(v.A, 'utf8');
  assert.match(aptConf, /Acquire::https::CAInfo "\/etc\/aura\/infra\/ca-bundle\.pem";/);
  assert.match(aptConf, /Dir::Etc::netrc ".*infra_apt_auth";/);
  assert.doesNotMatch(aptConf, /CANARY/);
  const mirrored = readFileSync(join(aw, 'apt/sources.list.d/debian.sources'), 'utf8');
  assert.equal(mirrored, A.apt.rewriteAptSources(deb822, cfg.registries.apt.mirrors), 'sh and JS rewrite the same way');
});

// ── the real tools read the rendered system layer; user and project files win ──

function toolEnv(dir, extra = {}) {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { PATH: process.env.PATH, HOME: home, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '', ...extra };
}
const have = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

test('npm: the rendered npmrc is the global layer; ~/.npmrc and a project .npmrc win', { skip: !have('npm') && 'no npm' }, () => {
  const d = tmp('aura-tools-');
  const { tree } = R.renderTree(A.renderInfra(cfgOf(CASES.example), VIEW));
  writeFileSync(join(d, 'npmrc'), tree.npmrc);
  const env = toolEnv(d, { NPM_CONFIG_GLOBALCONFIG: join(d, 'npmrc') });
  const proj = join(d, 'proj'); mkdirSync(proj); writeFileSync(join(proj, 'package.json'), '{}');
  const get = () => execFileSync('npm', ['config', 'get', 'registry'], { cwd: proj, env }).toString().trim();
  assert.equal(get(), 'https://artifactory.corp.example/api/npm/npm-remote/');
  writeFileSync(join(env.HOME, '.npmrc'), 'registry=https://user.example/\n');
  assert.equal(get(), 'https://user.example/');
  writeFileSync(join(proj, '.npmrc'), 'registry=https://proj.example/\n');
  assert.equal(get(), 'https://proj.example/');
});

test('pnpm: the rendered npmrc as a system operation\'s user config; a project .npmrc still wins', { skip: !have('pnpm') && 'no pnpm' }, (t) => {
  const d = tmp('aura-tools-');
  const { tree } = R.renderTree(A.renderInfra(cfgOf(CASES.example), VIEW));
  writeFileSync(join(d, 'npmrc'), tree.npmrc);
  const proj = join(d, 'proj'); mkdirSync(proj); writeFileSync(join(proj, 'package.json'), '{}');
  const env = toolEnv(d, { NPM_CONFIG_USERCONFIG: join(d, 'npmrc') });
  const get = () => { const r = spawnSync('pnpm', ['config', 'get', 'registry'], { cwd: proj, env, encoding: 'utf8' }); return `${r.stdout}${r.stderr}`.trim(); };
  const first = get();
  if (/Could not download/.test(first)) {
    // pnpm 12's launcher wants a native binary this host has not cached: that download itself must
    // already go to the rendered registry (it reads the same user config).
    assert.match(first, /artifactory\.corp\.example\/api\/npm\/npm-remote/, first);
    return t.skip('pnpm native binary not cached here: only its download path was checked');
  }
  assert.equal(first.split('\n').pop(), 'https://artifactory.corp.example/api/npm/npm-remote/');
  writeFileSync(join(proj, '.npmrc'), 'registry=https://proj.example/\n');
  assert.equal(get().split('\n').pop(), 'https://proj.example/');
});

test('git: GIT_CONFIG_SYSTEM carries the CA and mirror rewrites; ~/.gitconfig wins', { skip: !have('git') && 'no git' }, () => {
  const d = tmp('aura-tools-');
  const { tree } = R.renderTree(A.renderInfra(cfgOf(CASES.example), VIEW));
  writeFileSync(join(d, 'gitconfig'), tree.gitconfig);
  const env = toolEnv(d, { GIT_CONFIG_SYSTEM: join(d, 'gitconfig') });
  delete env.GIT_CONFIG_NOSYSTEM;
  const get = (k) => execFileSync('git', ['config', '--get', k], { env }).toString().trim();
  assert.equal(get('http.sslCAInfo'), '/etc/aura/infra/ca-bundle.pem');
  assert.equal(get('url.https://git.corp.example/mirror/github/.insteadOf'), 'https://github.com/');
  writeFileSync(join(env.HOME, '.gitconfig'), '[http]\n\tsslCAInfo = /home/me/ca.pem\n');
  assert.equal(get('http.sslCAInfo'), '/home/me/ca.pem');
});

test('apt: the drop-in parses (apt-config), proxy, DIRECT and CA as rendered', { skip: !have('apt-config') && 'no apt-config' }, () => {
  const d = tmp('aura-tools-');
  const { tree } = R.renderTree(A.renderInfra(cfgOf(CASES.example), VIEW));
  const f = join(d, '90aura-infra');
  writeFileSync(f, tree['apt/apt.conf.d/90aura-infra']);
  const dump = execFileSync('apt-config', ['-c', f, 'dump', 'Acquire'], { env: { PATH: process.env.PATH } }).toString();
  assert.match(dump, /Acquire::https::Proxy "http:\/\/proxy\.corp\.example:3128";/);
  assert.match(dump, /Acquire::https::Proxy::artifactory\.corp\.example "DIRECT";/);
  assert.match(dump, /Acquire::https::CAInfo "\/etc\/aura\/infra\/ca-bundle\.pem";/);
});

test('node: the flags the env enables exist in this Node', () => {
  const help = execFileSync(process.execPath, ['--help']).toString();
  for (const f of ['--use-env-proxy', '--use-openssl-ca']) assert.ok(help.includes(f), f);
  // The rendered Node env (env proxy, extra CAs, --use-openssl-ca, the experimental-proxy warning off) starts a process cleanly.
  const d = tmp('aura-node-');
  writeFileSync(join(d, 'ca.pem'), execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', join(d, 'k'), '-days', '2', '-subj', '/CN=t']));
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    env: { PATH: process.env.PATH, ...A.renderInfra(cfgOf(CASES['ca-replace'].replace('version: 1\n', 'version: 1\nnetwork:\n  proxy:\n    https: http://127.0.0.1:9\n')), { files: FILES }).env, NODE_EXTRA_CA_CERTS: join(d, 'ca.pem') }, encoding: 'utf8',
  });
  assert.equal(r.stdout, 'ok', r.stderr);
  assert.doesNotMatch(r.stderr, /Warning|Ignoring/);
});

// ── Dockerfile and compose (IC-3) ───────────────────────────────────────────

const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const runs = () => DOCKERFILE.replace(/\\\n/g, ' ').split('\n').filter((l) => /^RUN /.test(l));

test('Dockerfile: every network step reads the infrastructure inputs; nothing secret in ARG/ENV', () => {
  const net = runs().filter((l) => /curl -|apt-get |git clone|pnpm install|corepack prepare|npm (i|install) /.test(l));
  assert.ok(net.length >= 10, `${net.length} network steps`);
  for (const l of net) {
    for (const need of ['source=os/infra/build-env.sh', 'from=aura-infra-public,target=/etc/aura/infra', 'id=infra_proxy ', 'type=tmpfs,target=/run/aura-build', '. /run/aura-infra/build-env.sh']) {
      assert.ok(l.includes(need), `${need} missing in: ${l.slice(0, 120)}`);
    }
    if (/apt-get /.test(l)) assert.ok(l.includes('id=infra_apt_auth'), l.slice(0, 120));
    for (const u of l.match(/curl[^&]*?https?:\/\/\S+/g) ?? []) assert.match(u, /aura_url "https?:/, `download not mirror-aware: ${u}`);
  }
  assert.match(DOCKERFILE, /^FROM scratch AS aura-infra-public$/m, 'the empty default context');
  for (const m of DOCKERFILE.matchAll(/^(ARG|ENV)\s+(\S+)/gm)) assert.doesNotMatch(m[2], /proxy|secret|token|auth|password|infra_/i, m[0]);
  assert.doesNotMatch(DOCKERFILE.replace(/^#.*$/gm, ''), /\/run\/secrets\/[^\s"]*\s*>/, 'a secret is never copied into a file of a layer');
  for (const m of DOCKERFILE.matchAll(/^FROM\s+(\S+)/gm)) assert.ok(m[1] === 'scratch' || m[1].startsWith('${DOCKER_IO_REGISTRY}/') || /^[a-z-]+$/.test(m[1]), `base image not mirror-aware: ${m[1]}`);
  assert.doesNotMatch(DOCKERFILE, /--from=[a-z0-9.-]+\/[^\s]+/, 'COPY --from an image goes through a stage (mirror-aware)');
});

test('Dockerfile: pnpm pinned, no agent CLI baked in, no silent install, buildx in the image', () => {
  const code = DOCKERFILE.replace(/^#.*$/gm, '');
  assert.doesNotMatch(code, /@latest/);
  assert.doesNotMatch(code, /claude-code|@anthropic-ai|@openai\/codex/);
  assert.doesNotMatch(code, /npm (i|install) -g[^\n]*\|\| true/);
  assert.match(code, /^ARG PNPM_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(code, /corepack prepare "pnpm@\$\{PNPM_VERSION\}" --activate/);
  assert.match(code, /cli-plugins\/docker-buildx/);
  assert.equal((code.match(/corepack prepare/g) ?? []).length, 1, 'pnpm is prepared once (base), not again per stage');
});

test('Dockerfile defaults: the same base images and downloads as before (no config = today)', () => {
  const r = INST.requirements(ROOT, null);
  assert.deepEqual(r.images.map((i) => i.image), ['debian:bookworm-slim', 'docker:29.3.1-cli', 'node:22.23.5-bookworm', 'node:22.23.5-bookworm-slim', 'valkey/valkey:8.1.3-bookworm@sha256:fea8b3e67b15729d4bb70589eb03367bab9ad1ee89c876f54327fc7c6e618571']); // + the builder runner (B), Valkey pinned (G)
  for (const i of r.images) assert.equal(i.via, i.image);
  const hosts = [...new Set(r.downloads.map((d) => new URL(d.url).host))].sort();
  assert.deepEqual(hosts, ['download.docker.com', 'github.com']);
  assert.ok(r.downloads.every((d) => !/\$\{[A-Z]+_VERSION\}/.test(d.url)), 'ARG defaults are expanded');
  assert.deepEqual(r.clones.map((c) => c.url), ['https://github.com/proot-me/proot']);
});

test('compose: no hard-coded DNS (O11: the host resolver unless configured)', () => {
  const compose = YAML.parse(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'));
  for (const [name, svc] of Object.entries(compose.services)) assert.equal(svc.dns, undefined, name);
  assert.doesNotMatch(readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8'), /8\.8\.8\.8|1\.1\.1\.1/);
});

test('boot.sh: pnpm install gets the rendered env only when a config exists', () => {
  const boot = readFileSync(join(ROOT, 'os/boot.sh'), 'utf8');
  assert.match(boot, /if \[ -f \/data\/aura\/infra\/config\.yaml \]; then\n\s+if run node \/workspace\/os\/infra\/render\.mjs apply --data \/data/);
  assert.match(boot, /exec pnpm install' boot-install "\$INFRA_ENV" "\$INFRA_NPMRC"/);
  assert.ok(boot.indexOf('render.mjs apply') < boot.indexOf('exec pnpm install'), 'rendered before the install');
});
