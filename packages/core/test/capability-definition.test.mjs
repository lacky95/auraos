// SF-2: capability definitions are data (capabilities/definition.ts): strict,
// validated, digest-bound; the owner's additions are sealed (CapabilityRegistryStore).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  CAPABILITY_REGISTRY_KEY, CapabilityDefinitionError, CapabilityRegistryStore, capabilityDigest,
  findBinaryPath, parseCapabilityDefinition, parseCapabilityRegistry,
} from '../dist/index.js';

const SHA = 'a'.repeat(64);
const bad = (name, def) => assert.throws(() => parseCapabilityDefinition(name, def), CapabilityDefinitionError, JSON.stringify(def));

test('the release registry validates whole; no entry carries a shell command', () => {
  const text = readFileSync(new URL('../../../.aura/capabilities.yaml', import.meta.url), 'utf8');
  const reg = parseCapabilityRegistry(parseYaml(text));
  assert.ok(Object.keys(reg).length >= 20);
  assert.doesNotMatch(text, /install_cmd|source:\s*curl|\|\s*bash/);
  for (const [name, def] of Object.entries(reg)) {
    for (const s of def.steps ?? []) {
      for (const k of ['download', 'extract', 'deb']) if (s[k]) assert.match(s[k].sha256, /^[a-f0-9]{64}$/, `${name} pins ${k}`);
    }
  }
});

test('D96: aliases, tags and login probes are validated data; binary_path is never tied to one architecture', () => {
  const def = parseCapabilityDefinition('agent-a', {
    source: 'npm', package: 'agent-a', binary: 'a', aliases: ['a-cli'], tags: ['agent'], login_probe: ['.a/creds.json'],
    binary_path: '/usr/local/lib/node_modules/agent-a/node_modules/agent-a-linux-*/bin/a',
  });
  assert.deepEqual([def.aliases, def.tags, def.login_probe], [['a-cli'], ['agent'], ['.a/creds.json']]);
  bad('x1', { source: 'npm', package: 'x', aliases: ['x1'] });
  bad('x1', { source: 'npm', package: 'x', aliases: ['a b'] });
  bad('x1', { source: 'npm', package: 'x', aliases: 'x2' });
  for (const p of ['/abs', '../x', '.a/../../etc/shadow', 'a//b', 'a/', '$(id)']) bad('x1', { source: 'npm', package: 'x', login_probe: [p] });
  bad('x1', { source: 'npm', package: 'x', tags: ['Agent!'] });
  for (const p of ['/usr/local/**/x', '/usr/local/lib/../x', 'usr/x', '/usr/local/lib/x?']) bad('x1', { source: 'npm', package: 'x', binary_path: p });
  // The release registry: no x86-only path for a binary.
  const text = readFileSync(new URL('../../../.aura/capabilities.yaml', import.meta.url), 'utf8');
  for (const [name, d] of Object.entries(parseCapabilityRegistry(parseYaml(text)))) {
    assert.doesNotMatch(d.binary_path ?? '', /x64|x86_64|amd64|aarch64|arm64/, `${name} binary_path`);
  }
});

test('findBinaryPath: a plain path, or the first existing match of a pattern', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binpath-'));
  mkdirSync(join(dir, 'pkg-linux-arm64', 'vendor', 'aarch64-musl', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'pkg-linux-arm64', 'vendor', 'aarch64-musl', 'bin', 'tool'), '');
  mkdirSync(join(dir, 'other'));
  assert.equal(findBinaryPath(`${dir}/pkg-linux-*/vendor/*-musl/bin/tool`), `${dir}/pkg-linux-arm64/vendor/aarch64-musl/bin/tool`);
  assert.equal(findBinaryPath(`${dir}/pkg-linux-arm64/vendor/aarch64-musl/bin/tool`), `${dir}/pkg-linux-arm64/vendor/aarch64-musl/bin/tool`);
  assert.equal(findBinaryPath(`${dir}/pkg-mac-*/bin/tool`), null);
  assert.equal(findBinaryPath(`${dir}/nope`), null);
  assert.equal(findBinaryPath(undefined), null);
});

test('free-form commands and unknown fields are refused', () => {
  bad('x1', { source: 'curl', install_cmd: 'curl https://x | bash' });
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', install_cmd: 'id', steps: [{ mkdir: ['/usr/local/lib/x1'] }] });
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ run: 'id' }] });
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ shell: ['sh', '-c', 'id'] }] });
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ mkdir: ['/usr/local/lib/a'], apt: ['nano'] }] });
  bad('x1', { source: 'apt', package: 'nano', start_cmd: 'id' });
});

test('command and argument injection in names and packages is refused', () => {
  for (const pkg of ['nano; id', '$(id)', '-oAPT::Get::AllowUnauthenticated=true', '--allow-unauthenticated', 'nano=1', 'nano/sid', 'nano:amd64', 'nano-', '/tmp/x.deb', 'x.deb', 'http://evil/x']) {
    bad('x1', { source: 'apt', package: pkg });
    bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ apt: [pkg] }] });
  }
  for (const pkg of ['--registry=http://evil', '-g', 'git+https://evil/x.git', 'https://evil/x.tgz', 'file:../x', '../x', 'x; id', 'evil/x', 'x@latest; id']) bad('x1', { source: 'npm', package: pkg });
  for (const name of ['-x', 'X', '../x', 'x y', 'x;id', '']) assert.throws(() => parseCapabilityDefinition(name, { source: 'builtin' }), CapabilityDefinitionError, name);
  bad('x1', { source: 'builtin', binary: '../../etc/passwd' });
  bad('x1', { source: 'builtin', binary: '-x' });
});

test('sources: https only, sha256 pinned, no credentials', () => {
  const dl = (url, sha256 = SHA) => ({ source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ download: { url, sha256, to: '/usr/local/bin/x1' } }] });
  for (const url of ['http://example.com/x', 'ftp://example.com/x', 'file:///etc/passwd', 'https://user:pw@example.com/x', 'https://example.com/x y', 'https://example.com/$(id)', '-o/etc/x']) bad('x1', dl(url));
  bad('x1', dl('https://example.com/x', 'abc'));
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ download: { url: 'https://example.com/x', to: '/usr/local/bin/x1' } }] });
  bad('x1', { source: 'steps', binary_path: '/usr/bin/x1', steps: [{ deb: { url: 'https://example.com/x.deb' } }] });
  assert.ok(parseCapabilityDefinition('x1', dl('https://example.com/x')));
});

test('writes stay under the write roots; no traversal; a root is never replaced', () => {
  const at = (to) => ({ source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ download: { url: 'https://example.com/x', sha256: SHA, to } }] });
  for (const to of ['/etc/cron.d/x', '/usr/bin/x', '/usr/local/bin/../../etc/x', '/root/.ssh/authorized_keys', 'usr/local/bin/x', '/usr/local/bin/', '/usr/local/bin', '/data/aura/x']) bad('x1', at(to));
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ extract: { url: 'https://e.com/a.tgz', sha256: SHA, format: 'tar.gz', to: '/usr/local/bin' } }] });
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ extract: { url: 'https://e.com/a.tgz', sha256: SHA, format: 'tar.gz', members: ['../x'], to: '/usr/local/bin' } }] });
  bad('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ symlink: { target: '/etc/shadow', path: '/usr/local/bin/x1' } }] });
  assert.ok(parseCapabilityDefinition('x1', { source: 'steps', binary_path: '/usr/local/bin/x1', steps: [{ extract: { url: 'https://e.com/a.tgz', sha256: SHA, format: 'tar.gz', members: ['x1'], to: '/usr/local/bin' } }] }));
});

test('the digest binds the whole definition, independent of key order', () => {
  const a = parseCapabilityDefinition('x1', { source: 'apt', package: 'nano', binary: 'nano' });
  const b = parseCapabilityDefinition('x1', { binary: 'nano', package: 'nano', source: 'apt' });
  assert.equal(capabilityDigest('x1', a), capabilityDigest('x1', b));
  assert.notEqual(capabilityDigest('x1', a), capabilityDigest('x2', a));
  assert.notEqual(capabilityDigest('x1', a), capabilityDigest('x1', parseCapabilityDefinition('x1', { source: 'apt', package: 'vim', binary: 'nano' })));
});

function memoryRedis() {
  const data = new Map();
  return {
    data,
    redis: {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v, nx) => { if (nx === 'NX' && data.has(k)) return null; data.set(k, v); return 'OK'; },
      eval: async (_s, _n, k, expected, next) => { if (data.get(k) !== expected) return 0; data.set(k, next); return 1; },
    },
  };
}

test('the owner\'s entries are sealed: a Valkey writer can neither add nor change one', async () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), 'cap-reg-')), 'identity.key');
  const kv = memoryRedis();
  let tampered = 0;
  const store = new CapabilityRegistryStore({ identityKeyFile: keyFile, redis: () => kv.redis, onTampered: () => { tampered += 1; } });
  const def = { source: 'apt', package: 'nano', binary: 'nano' };
  const put = await store.put('mynano', def, { approval: 'apr_x' });
  assert.equal(put.ok, true);
  const listed = await store.list();
  assert.equal(listed.mynano.digest, capabilityDigest('mynano', parseCapabilityDefinition('mynano', def)));
  assert.equal(listed.mynano.approval, 'apr_x');

  // Change the package in place: the MAC fails, nothing is used.
  const raw = JSON.parse(kv.data.get(CAPABILITY_REGISTRY_KEY));
  raw.entries.mynano.definition.package = 'netcat-openbsd';
  kv.data.set(CAPABILITY_REGISTRY_KEY, JSON.stringify(raw));
  assert.deepEqual(await store.list(), {});
  assert.equal(tampered, 1);
  // A forged record without the key: nothing.
  kv.data.set(CAPABILITY_REGISTRY_KEY, JSON.stringify({ v: 1, entries: { evil: { definition: def, digest: 'x', addedAt: 'now' } }, mac: 'AAAA' }));
  assert.deepEqual(await store.list(), {});
  // put rejects an invalid definition.
  await assert.rejects(store.put('x1', { source: 'curl', install_cmd: 'id' }), CapabilityDefinitionError);
  assert.equal((await store.put('mynano', def)).ok, true);
  assert.equal((await store.remove('mynano')).changed, true);
  assert.deepEqual(await store.list(), {});
});
