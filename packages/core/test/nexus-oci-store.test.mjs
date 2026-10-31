// Publishing to and listing from OCI stores on any registry. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/nexus-oci-store.test.mjs
//
// Three things a store on a shared registry (GitLab, GHCR, …) needs:
//   • a publish ships only the app — never its runtime data or logins,
//     even when the app dir is also where its instance keeps state;
//   • an app list that doesn't depend on /v2/_catalog (OciCatalog);
//   • one address (`host/<prefix>`) and a login check that works where
//     `oras repo ls` is refused to everyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { publishFileList, withheldReason } from '../dist/nexus/PublishFiles.js';
import { parseCatalog, catalogRepo } from '../dist/nexus/OciCatalog.js';
import { checkRegistryLogin, probeRegistryAddress, parseChallenge } from '../dist/nexus/RegistryProbe.js';
import { splitOciUrl, orasHostFromUrl } from '../dist/nexus/RegistryConfig.js';
import { artifactTypeOf, ARTIFACT_TYPE_ANNOTATION } from '../dist/nexus/RegistryAuth.js';
import { discoverStore } from '../dist/nexus/StoreDiscovery.js';

function appDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aura-pubfiles-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const APP = {
  'app.manifest.json': '{}',
  'src/pages/index.astro': '<h1/>',
  'entrypoint.sh': 'echo',
  '.env.example': 'KEY=',
  // everything below must never ship
  '.env': 'TOKEN=abc',
  'config/.env.production': 'TOKEN=abc',
  'io.example.app/trilium-credentials.json': '{"token":"x"}',
  '.sidecars/db/data/pg_wal/0001': 'wal',
  '.pnpm-store/v11/index.db': 'x',
  'node_modules/x/index.js': '',
  'tools/node_modules/y/index.js': '',
  '.data/projector.db': 'x',
  'state/app.sqlite': 'x',
  'state/app.sqlite-wal': 'x',
  'agent/openclaw.sqlite.lock.sqlite': 'x',
  'certs/server.pem': 'x',
  'certs/server.key': 'x',
  '.ssh/id_ed25519': 'x',
  'credentials.json': '{}',
  '.npmrc': '//registry.npmjs.org/:_authToken=npm_secret\n',
  'sub/.npmrc': 'node-linker=hoisted\n',
};

test('the deny list keeps runtime data and secrets out of a walked app dir', () => {
  const dir = appDir(APP);
  const { files, withheld } = publishFileList(dir, { appId: 'io.example.app' });
  assert.deepEqual(files, ['.env.example', 'app.manifest.json', 'entrypoint.sh', 'src/pages/index.astro', 'sub/.npmrc']);
  for (const bad of ['.env', 'config/.env.production', 'state/app.sqlite', 'certs/server.key', '.npmrc', 'credentials.json']) {
    assert.ok(withheld.includes(bad), `${bad} reported as withheld`);
  }
});

test('in a git work tree .gitignore counts, and the deny list still applies to tracked files', () => {
  const dir = appDir({ ...APP, '.gitignore': 'generated/\n', 'generated/big.bin': 'x', 'untracked-new.ts': 'x' });
  execFileSync('git', ['init', '-q', dir]);
  // Even a secret someone committed by mistake is not shipped.
  execFileSync('git', ['-C', dir, 'add', '-f', 'app.manifest.json', '.env', 'src']);
  const { files } = publishFileList(dir, { appId: 'io.example.app' });
  assert.ok(files.includes('untracked-new.ts'), 'untracked but not ignored ships');
  assert.ok(!files.includes('generated/big.bin'), '.gitignore honoured');
  assert.ok(!files.includes('.env'), 'committed .env still withheld');
  assert.ok(!files.some((f) => f.startsWith('.sidecars/') || f.startsWith('io.example.app/')));
});

test('manifest.publish.ignore: bare names match any segment, paths match a prefix', () => {
  const dir = appDir({ 'app.manifest.json': '{}', 'src/a.ts': '', 'lib/src/b.ts': '', 'docs/x/y.md': '', 'docs/z.md': '' });
  const { files } = publishFileList(dir, { appId: 'a.b', ignore: ['src', 'docs/x'] });
  assert.deepEqual(files, ['app.manifest.json', 'docs/z.md']);
});

test('symlinks are listed as links, not followed', () => {
  const dir = appDir({ 'app.manifest.json': '{}' });
  symlinkSync('/etc', join(dir, 'etc-link'));
  const { files } = publishFileList(dir, { appId: 'a.b' });
  assert.deepEqual(files, ['app.manifest.json', 'etc-link']);
});

test('withheldReason: the app data dir only at the root', () => {
  assert.equal(withheldReason('io.x.y/state.json', 'io.x.y'), 'app data dir');
  assert.equal(withheldReason('src/io.x.y/ok.ts', 'io.x.y'), null);
  assert.equal(withheldReason('.env.sample', 'a'), null);
});

test('catalog documents stay inside their prefix', () => {
  const doc = parseCatalog({ apps: [
    { id: 'io.a.one', repo: 'team/apps/io.a.one', version: '1.0.0' },
    { id: 'io.a.one', repo: 'team/apps/io.a.one-dupe' },
    { id: 'io.evil', repo: 'other/place/io.evil' },
    { id: 'io.trav', repo: 'team/apps/../../x' },
    { id: 'catalog', repo: 'team/apps/catalog' },
    { id: 'bad id!', repo: 'team/apps/bad' },
  ] }, 'team/apps/');
  assert.deepEqual(doc.apps, [{ id: 'io.a.one', repo: 'team/apps/io.a.one', version: '1.0.0' }]);
  assert.equal(catalogRepo('team/apps/'), 'team/apps/catalog');
});

test('a registry URL path is the app prefix; hosts never carry it', () => {
  assert.deepEqual(splitOciUrl('https://registry.lakner.io/lakner-io/auraos/apps/'), { url: 'https://registry.lakner.io', prefix: 'lakner-io/auraos/apps' });
  assert.deepEqual(splitOciUrl('http://aura-com.aura.registry:4090'), { url: 'http://aura-com.aura.registry:4090' });
  assert.equal(orasHostFromUrl('https://registry.example.com/team/apps'), 'registry.example.com');
  assert.equal(orasHostFromUrl('http://aura-com.aura.registry:4090/'), 'aura-com.aura.registry:4090');
});

test('WWW-Authenticate challenges parse', () => {
  assert.deepEqual(parseChallenge('Bearer realm="https://gitlab.com/jwt/auth",service="container_registry"'),
    { scheme: 'bearer', realm: 'https://gitlab.com/jwt/auth', service: 'container_registry' });
  assert.equal(parseChallenge('Basic realm="zot"').scheme, 'basic');
  assert.equal(parseChallenge(null), null);
});

/** A fake GitLab-style registry: /v2/ always 401 + Bearer, token server checks the login. */
function gitlabLike({ user = 'me', pass = 'good' } = {}) {
  const calls = [];
  const f = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, auth: init.headers?.authorization });
    if (url === 'https://registry.example.com/v2/') {
      return new Response('{}', { status: 401, headers: {
        'www-authenticate': 'Bearer realm="https://auth.example.com/jwt/auth",service="container_registry"',
        'docker-distribution-api-version': 'registry/2.0',
      } });
    }
    if (url.startsWith('https://auth.example.com/jwt/auth')) {
      const ok = init.headers?.authorization === `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      return new Response(ok ? '{"token":"t"}' : '{}', { status: ok ? 200 : 401 });
    }
    return new Response('not found', { status: 404 });
  };
  return { f, calls };
}

test('checkRegistryLogin uses the token handshake (no /v2/_catalog needed)', async () => {
  const { f, calls } = gitlabLike();
  assert.equal(await checkRegistryLogin('https://registry.example.com', { username: 'me', password: 'good' }, 'team/apps/catalog', f), 'ok');
  const tokenCall = calls.find((c) => c.url.startsWith('https://auth.example.com'));
  assert.match(tokenCall.url, /service=container_registry/);
  assert.match(tokenCall.url, /scope=repository%3Ateam%2Fapps%2Fcatalog%3Apull/);
  assert.equal(await checkRegistryLogin('https://registry.example.com', { username: 'me', password: 'bad' }, 'x/catalog', f), 'rejected');
  assert.equal(await checkRegistryLogin('https://registry.example.com', null, 'x/catalog', f), 'required');
  assert.equal(await checkRegistryLogin('https://registry.example.com', null, 'x', async () => { throw new Error('ENOTFOUND'); }), 'unreachable');
});

test('checkRegistryLogin with a Basic registry', async () => {
  const good = `Basic ${Buffer.from('u:p').toString('base64')}`;
  const f = async (_u, init = {}) => init.headers?.authorization === good
    ? new Response('{}', { status: 200 })
    : new Response('{}', { status: 401, headers: { 'www-authenticate': 'Basic realm="zot"' } });
  assert.equal(await checkRegistryLogin('https://zot.example.com', { username: 'u', password: 'p' }, 'r', f), 'ok');
  assert.equal(await checkRegistryLogin('https://zot.example.com', { username: 'u', password: 'x' }, 'r', f), 'rejected');
});

test('an address without aura-store.json that is a registry becomes the store (host + prefix)', async () => {
  const { f } = gitlabLike();
  const reg = await probeRegistryAddress('registry.example.com/Team/Apps', f);
  assert.deepEqual(reg, { url: 'https://registry.example.com', prefix: 'team/apps', needsLogin: true });
  const store = await discoverStore('registry.example.com/team/apps', f);
  assert.deepEqual(store, {
    name: 'example.com', title: 'registry.example.com/team/apps', kind: 'oci',
    url: 'https://registry.example.com', auth: 'basic', appRepoPrefix: 'team/apps',
  });
  // A plain web host is not a registry.
  assert.equal(await probeRegistryAddress('www.example.com', async () => new Response('<html>', { status: 200 })), null);
});

test('the Aura artifact type is found wherever a registry let the push put it', () => {
  const t = 'application/vnd.aura.app.manifest.v1+json';
  assert.equal(artifactTypeOf({ artifactType: t }), t);                                    // OCI 1.1 artifact
  assert.equal(artifactTypeOf({ config: { mediaType: t } }), t);                           // 1.0, custom config
  assert.equal(artifactTypeOf({                                                            // GitLab fallback
    config: { mediaType: 'application/vnd.oci.image.config.v1+json' },
    annotations: { [ARTIFACT_TYPE_ANNOTATION]: t },
  }), t);
  assert.equal(artifactTypeOf({ config: { mediaType: 'application/vnd.oci.image.config.v1+json' } }), undefined);
});
