// Private Nexus sources: logins for OCI registries and store discovery. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/registry-auth.test.mjs
//
// A customer adds a private store (registry URL + username + password, or
// just the store's address). The password must reach `oras` only as a
// short-lived auth file, only for the registry host it was entered for, and
// never end up in argv or the (app-readable) sources config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  secretKeyFor, sealedLoginValue, passwordForHost, authFileContent, orasTargetHost,
  isAuthFailure, authFailureReason, orasSync, orasAsync, OrasAuthError, SOURCE_SECRET_PATTERN,
  parseImageRef, resolvePullCredential, writeAuthConfig, redactLogin,
} from '../dist/nexus/RegistryAuth.js';
import { parseStoreDescriptor, wellKnownUrl, discoverStore, StoreDiscoveryError } from '../dist/nexus/StoreDiscovery.js';
import { isSourceEntry, isSourceAuth } from '../dist/nexus/SourcesConfig.js';

test('secret keys are derived from the source name and match the Context key rules', () => {
  assert.equal(secretKeyFor('acme'), 'NEXUS_SRC_ACME_PASSWORD');
  assert.equal(secretKeyFor('my-store.io'), 'NEXUS_SRC_MY_STORE_IO_PASSWORD');
  assert.equal(secretKeyFor('---'), 'NEXUS_SRC_SOURCE_PASSWORD');
  assert.match(secretKeyFor('acme'), SOURCE_SECRET_PATTERN);
});

test('a sealed login is only handed out for the host it was entered for', () => {
  const v = sealedLoginValue('registry.acme.com', 's3cret');
  assert.equal(passwordForHost(v, 'registry.acme.com'), 's3cret');
  assert.equal(passwordForHost(v, 'evil.example.com'), null);
  // Some other secret (e.g. GITHUB_TOKEN) referenced by a forged source entry.
  assert.equal(passwordForHost('ghp_abcdef', 'registry.acme.com'), null);
  assert.equal(passwordForHost(null, 'registry.acme.com'), null);
});

test('the oras auth file is a docker-style config for exactly one host', () => {
  const json = JSON.parse(authFileContent('registry.acme.com', { username: 'cust', password: 'pw:with:colons' }));
  assert.deepEqual(Object.keys(json.auths), ['registry.acme.com']);
  assert.equal(Buffer.from(json.auths['registry.acme.com'].auth, 'base64').toString(), 'cust:pw:with:colons');
});

test('the target host is read from every oras call form Nexus uses', () => {
  assert.equal(orasTargetHost(['repo', 'ls', 'registry.acme.com', '--plain-http']), 'registry.acme.com');
  assert.equal(orasTargetHost(['manifest', 'fetch', 'reg.io:5000/aura-apps/x:latest']), 'reg.io:5000');
  assert.equal(orasTargetHost(['pull', 'reg.io/aura-apps/x:1.0', '-o', '/tmp/s']), 'reg.io');
  assert.equal(orasTargetHost(['resolve', 'reg.io/aura-apps/x:stable']), 'reg.io');
  assert.equal(orasTargetHost(['push', 'reg.io/aura-apps/x:1.0', 'bundle.tar.gz:application/x']), 'reg.io');
  assert.equal(orasTargetHost(['tag', 'reg.io/aura-apps/x:1.0', 'latest']), 'reg.io');
  assert.equal(orasTargetHost(['version']), null);
});

test('rejected logins are recognised in oras output', () => {
  assert.ok(isAuthFailure('Error: response status code 401: unauthorized: authentication required'));
  assert.ok(isAuthFailure('Error: failed to authorize: basic credential not found'));
  assert.ok(!isAuthFailure('Error: response status code 404: name unknown'));
  assert.ok(!isAuthFailure('dial tcp: lookup registry.acme.com: no such host'));
  assert.ok(!isAuthFailure('open /data/nexus/staging/x: permission denied'));
});

test('a refused action is told apart from a wrong or missing login', () => {
  // What zot answers a read-only customer that tries to push.
  const zot403 = 'Error response from registry: denied: requested access to the resource is denied: map[description:The access controller denied access for the operation on a resource.]';
  assert.equal(authFailureReason(zot403, true), 'forbidden');
  assert.equal(authFailureReason('response status code 401: unauthorized', true), 'rejected');
  assert.equal(authFailureReason(zot403, false), 'missing');
});

/** A fake `oras` on PATH that records its argv and the auth file it was given. */
function withFakeOras(script, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-oras-'));
  const bin = join(dir, 'oras');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try { return fn(dir); } finally { process.env.PATH = old; }
}

test('orasSync passes the login as a temporary --registry-config file, never in argv, and deletes it', () => {
  withFakeOras(
    'for a in "$@"; do echo "ARG $a"; done; prev=""; for a in "$@"; do [ "$prev" = "--registry-config" ] && echo "FILE $a" && cat "$a" && echo; prev="$a"; done',
    () => {
      const out = orasSync(['repo', 'ls', 'registry.acme.com'], {}, { username: 'cust', password: 'hunter2' }).toString();
      assert.ok(!out.includes('hunter2'), 'password must not appear in argv');
      const file = /FILE (\S+)/.exec(out)?.[1];
      assert.ok(file, 'an auth file was passed');
      assert.match(out, /"registry\.acme\.com"/);
      assert.equal(existsSync(file), false, 'the auth file is deleted afterwards');
    },
  );
});

test('orasSync without a login runs plain, and a 401 becomes a readable OrasAuthError', () => {
  withFakeOras('echo "ARGS $*"', () => {
    assert.equal(orasSync(['repo', 'ls', 'public.example.com']).toString().trim(), 'ARGS repo ls public.example.com');
  });
  withFakeOras('echo "Error: response status code 401: unauthorized" >&2; exit 1', () => {
    assert.throws(
      () => orasSync(['repo', 'ls', 'registry.acme.com'], {}, { username: 'cust', password: 'wrong' }),
      (err) => err instanceof OrasAuthError && /login to registry\.acme\.com failed/.test(err.message),
    );
    assert.throws(
      () => orasSync(['repo', 'ls', 'registry.acme.com']),
      (err) => err instanceof OrasAuthError && /needs a login/.test(err.message),
    );
  });
});

test('a source entry can carry a login reference, never a password', () => {
  const base = { kind: 'oci', name: 'acme', url: 'https://registry.acme.com', priority: 5 };
  assert.ok(isSourceEntry({ ...base, auth: { type: 'basic', username: 'cust', secret: 'NEXUS_SRC_ACME_PASSWORD' } }));
  assert.ok(!isSourceAuth({ type: 'basic', username: 'cust', secret: 'NEXUS_SRC_ACME_PASSWORD', password: 'x' }));
  assert.ok(!isSourceEntry({ ...base, auth: { type: 'basic', username: 'cust', secret: 'GITHUB_TOKEN' } }));
  assert.ok(!isSourceEntry({ kind: 'git-index', name: 'x', url: 'https://x/index.yaml', priority: 1,
    auth: { type: 'basic', username: 'u', secret: 'NEXUS_SRC_X_PASSWORD' } }));
});

test('a store address becomes its well-known descriptor URL (https only)', () => {
  assert.equal(wellKnownUrl('apps.acme.com'), 'https://apps.acme.com/.well-known/aura-store.json');
  assert.equal(wellKnownUrl('https://apps.acme.com/whatever?x=1'), 'https://apps.acme.com/.well-known/aura-store.json');
  assert.throws(() => wellKnownUrl('http://apps.acme.com'), StoreDiscoveryError);
  assert.throws(() => wellKnownUrl('  '), StoreDiscoveryError);
});

test('store descriptors are validated', () => {
  assert.deepEqual(
    parseStoreDescriptor({ name: 'ACME', title: 'ACME Apps', kind: 'oci', url: 'https://registry.acme.com/', auth: 'basic' }),
    { name: 'acme', title: 'ACME Apps', kind: 'oci', url: 'https://registry.acme.com', auth: 'basic' },
  );
  assert.equal(parseStoreDescriptor({ name: 'pub', url: 'https://r.example.com' }).auth, 'none');
  assert.throws(() => parseStoreDescriptor({ name: 'x', url: 'http://r.example.com' }), /must use https/);
  assert.throws(() => parseStoreDescriptor({ name: 'x', url: 'https://u:p@r.example.com' }), /must not contain a login/);
  assert.throws(() => parseStoreDescriptor({ name: 'x', url: 'https://r.example.com', kind: 'git-index' }), /not supported/);
  assert.throws(() => parseStoreDescriptor({ name: 'Bad Name!', url: 'https://r.example.com' }), /"name"/);
  assert.throws(() => parseStoreDescriptor([]), StoreDiscoveryError);
});

test('discoverStore fetches and validates, with readable errors', async () => {
  const ok = async (url) => {
    assert.equal(url, 'https://apps.acme.com/.well-known/aura-store.json');
    return new Response(JSON.stringify({ name: 'acme', url: 'https://registry.acme.com', auth: 'basic' }), { status: 200 });
  };
  assert.equal((await discoverStore('apps.acme.com', ok)).url, 'https://registry.acme.com');
  await assert.rejects(discoverStore('apps.acme.com', async () => new Response('nope', { status: 404 })), /has no AuraOS store/);
  await assert.rejects(discoverStore('apps.acme.com', async () => new Response('{oops', { status: 200 })), /not valid JSON/);
  await assert.rejects(discoverStore('apps.acme.com', async () => { throw new Error('ENOTFOUND'); }), /could not reach/);
});

test('orasAsync: same login handling, and the event loop keeps running meanwhile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-oras-'));
  const bin = join(dir, 'oras');
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try {
    writeFileSync(bin, '#!/bin/sh\nsleep 0.4; echo "ARGS $*"\n'); chmodSync(bin, 0o755);
    let ticked = false;
    setTimeout(() => { ticked = true; }, 50);
    const out = (await orasAsync(['repo', 'ls', 'public.example.com'])).toString().trim();
    assert.equal(out, 'ARGS repo ls public.example.com');
    assert.ok(ticked, 'a timer fired while oras was running — nothing blocked');

    writeFileSync(bin, '#!/bin/sh\necho "Error: response status code 401: unauthorized" >&2; exit 1\n');
    await assert.rejects(orasAsync(['repo', 'ls', 'registry.acme.com'], {}, { username: 'cust', password: 'x' }),
      (err) => err instanceof OrasAuthError && /login to registry\.acme\.com failed/.test(err.message));
  } finally { process.env.PATH = old; }
});

test('registry host and repository of an image reference', () => {
  assert.deepEqual(parseImageRef('registry.lakner.io/lakner-io/auraos/apps/x/runtime:1'), { host: 'registry.lakner.io', repository: 'lakner-io/auraos/apps/x/runtime' });
  assert.deepEqual(parseImageRef('reg.io:5000/a/b@sha256:abc'), { host: 'reg.io:5000', repository: 'a/b' });
  assert.deepEqual(parseImageRef('oci://reg.io/a/b:1.0'), { host: 'reg.io', repository: 'a/b' });
  assert.deepEqual(parseImageRef('localhost/x:1'), { host: 'localhost', repository: 'x' });
  assert.deepEqual(parseImageRef('alpine:3'), { host: 'docker.io', repository: 'library/alpine' });
  assert.deepEqual(parseImageRef('vendor/agent:latest'), { host: 'docker.io', repository: 'vendor/agent' });
});

test('resolvePullCredential: only the install source login, only inside the app artifact repository', async () => {
  const cfg = { sources: [
    { kind: 'oci', name: 'acme', url: 'https://registry.acme.com', appRepoPrefix: 'grp/apps/', priority: 1, auth: { type: 'basic', username: 'cust', secret: 'NEXUS_SRC_ACME_PASSWORD' } },
    { kind: 'oci', name: 'other', url: 'https://registry.other.io/', priority: 2, auth: { type: 'basic', username: 'o', secret: 'NEXUS_SRC_OTHER_PASSWORD' } },
    { kind: 'oci', name: 'forged', url: 'https://registry.acme.com', priority: 3, auth: { type: 'basic', username: 'x', secret: 'NEXUS_SRC_FORGED_PASSWORD' } },
    { kind: 'oci', name: 'open', url: 'https://registry.open.io', priority: 4 },
    { kind: 'git-index', name: 'idx', url: 'https://idx.example.com/index.yaml', priority: 5 },
  ] };
  const sealed = {
    NEXUS_SRC_ACME_PASSWORD: sealedLoginValue('registry.acme.com', 'pw-acme'),
    NEXUS_SRC_OTHER_PASSWORD: sealedLoginValue('registry.other.io', 'pw-other'),
    // A source re-pointed at acme's host, holding a login sealed for another host.
    NEXUS_SRC_FORGED_PASSWORD: sealedLoginValue('registry.other.io', 'pw-other'),
  };
  const read = { sources: async () => cfg, secret: async (k) => sealed[k] ?? null };
  const fromStore = { id: 'io.x.app', source: 'index', ref: 'io.x.app', sourceName: 'acme' };
  const loginIn = async (origin, image) => {
    const c = await resolvePullCredential(origin, image, read);
    if (!c) return null;
    const f = c.authFile();
    try { return { source: c.source, repository: c.repository, cfg: JSON.parse(readFileSync(f.file, 'utf-8')) }; } finally { f.dispose(); }
  };
  const ok = await loginIn(fromStore, 'registry.acme.com/grp/apps/io.x.app/runtime:1');
  assert.equal(ok.source, 'acme');
  assert.equal(ok.repository, 'grp/apps/io.x.app/runtime');
  assert.equal(Buffer.from(ok.cfg.auths['registry.acme.com'].auth, 'base64').toString(), 'cust:pw-acme');
  assert.ok(await loginIn(fromStore, 'registry.acme.com/grp/apps/io.x.app:2'), 'the artifact repository itself');
  assert.equal(await loginIn(fromStore, 'registry.acme.com/grp/apps/io.y.app/runtime:1'), null, 'another app repository');
  assert.equal(await loginIn(fromStore, 'registry.acme.com/grp/apps/io.x.app-evil/runtime:1'), null, 'a sibling with the same prefix');
  assert.equal(await loginIn(fromStore, 'registry.acme.com/grp/other:1'), null, 'outside the store prefix');
  assert.equal(await loginIn(fromStore, 'registry.other.io/grp/apps/io.x.app/runtime:1'), null, 'never another source login');
  assert.equal(await loginIn({ ...fromStore, remoteId: 'io.remote.app' }, 'registry.acme.com/grp/apps/io.remote.app/r:1') !== null, true, 'installed under another local id: the source id counts');
  // A direct OCI install: its own ref is the artifact repository.
  const direct = { id: 'io.x.app', source: 'oci', ref: 'registry.acme.com/team/x:1.0', sourceName: 'acme' };
  assert.ok(await loginIn(direct, 'registry.acme.com/team/x/runtime:1'));
  assert.equal(await loginIn(direct, 'registry.acme.com/team/y:1'), null);
  assert.equal(await loginIn({ ...fromStore, sourceName: 'other' }, 'registry.acme.com/grp/apps/io.x.app/r:1'), null);
  assert.equal(await loginIn({ ...fromStore, sourceName: 'forged' }, 'registry.acme.com/aura-apps/io.x.app/r:1'), null, 'a login sealed for another host');
  assert.equal(await loginIn({ ...fromStore, sourceName: 'open' }, 'registry.open.io/aura-apps/io.x.app/r:1'), null, 'a source without a login');
  assert.equal(await loginIn({ ...fromStore, sourceName: 'idx' }, 'idx.example.com/aura-apps/io.x.app/r:1'), null, 'not an oci source');
  assert.equal(await loginIn({ ...fromStore, sourceName: 'gone' }, 'registry.acme.com/grp/apps/io.x.app/r:1'), null, 'a source that no longer exists');
  assert.equal(await loginIn(null, 'registry.acme.com/grp/apps/io.x.app/r:1'), null, 'not installed by Nexus');
  // The handle carries no secret as a field.
  const c = await resolvePullCredential(fromStore, 'registry.acme.com/grp/apps/io.x.app/r:1', read);
  assert.ok(!JSON.stringify(c).includes('pw-acme'));
  assert.equal(c.redact('x pw-acme y'), 'x *** y');
});

test('writeAuthConfig: a private dir with one host, removed by cleanup; redactLogin masks the secret', () => {
  const login = { username: 'u', password: 'pa55' };
  const a = writeAuthConfig('reg.io', login);
  assert.equal(statSync(a.dir).mode & 0o777, 0o700);
  assert.equal(statSync(a.file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(a.file, 'utf-8')).auths), ['reg.io']);
  a.cleanup();
  assert.equal(existsSync(a.dir), false);
  const b64 = Buffer.from('u:pa55').toString('base64');
  assert.equal(redactLogin(`x pa55 ${b64} y`, login), 'x *** *** y');
  assert.equal(redactLogin('x pa55', null), 'x pa55');
});
