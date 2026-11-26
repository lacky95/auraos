// D48: the app contract — manifest declarations, the contract version, and
// the dataDir report helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppManifestSchema } from '../dist/types/manifest.js';
import {
  AURA_CONTRACT, contractDeclarations, contractFindings, contractStatus,
} from '../dist/contract/appContract.js';
import { dataDirReport, layerWrites, scanInstallWrites } from '../dist/contract/dataDirReport.js';

const base = { id: 'com.example.notes', name: 'Notes', version: '1.0.0' };
const parse = (over = {}) => AppManifestSchema.parse({ ...base, ...over });
const codes = (m) => contractFindings(m).map((f) => f.code);

test('the manifest declares auraContract and context keys; old manifests still parse', () => {
  const m = parse({ auraContract: 1, context: ['OPENAI_API_KEY'] });
  assert.equal(m.auraContract, 1);
  assert.deepEqual(m.context, ['OPENAI_API_KEY']);
  const old = parse();
  assert.equal(old.auraContract, undefined);
  assert.deepEqual(old.context, []);
  assert.equal(AppManifestSchema.safeParse({ ...base, context: ['lower-case'] }).success, false);
  assert.equal(AppManifestSchema.safeParse({ ...base, auraContract: 0 }).success, false);
});

test('contract status: none, current, unknown major', () => {
  assert.equal(AURA_CONTRACT, 1);
  assert.deepEqual(contractStatus({}), { version: null, status: 'none' });
  assert.deepEqual(contractStatus({ auraContract: 1 }), { version: 1, status: 'current' });
  assert.deepEqual(contractStatus({ auraContract: 2 }), { version: 2, status: 'unknown' });
});

test('declarations: permissions, context, sidecars with images, consumes, docker, privileged', () => {
  const m = parse({
    auraContract: 1, permissions: ['sidecars.spawn', 'sidecars.privileged'], tools: ['git', 'docker'], context: ['A_KEY'],
    services: [{ name: 'db', image: 'postgres:16' }],
    consumes: [{ name: 'search', kind: 'http/mcp', appId: 'com.aura.docs' }, { name: 'tts', kind: 'http/rest' }],
  });
  assert.deepEqual(contractDeclarations(m), {
    auraContract: 1, permissions: ['sidecars.spawn', 'sidecars.privileged'], context: ['A_KEY'],
    sidecars: [{ name: 'db', image: 'postgres:16' }], consumes: ['com.aura.docs/search', 'tts'], docker: true, privileged: true,
  });
  assert.equal(contractDeclarations(parse({ tools: ['*'] })).docker, true);
  assert.equal(contractDeclarations(parse({ tools: ['git'] })).docker, false);
});

test('findings: what the manifest uses but does not declare', () => {
  assert.deepEqual(codes(parse()), ['contract-missing']);
  assert.deepEqual(codes(parse({ auraContract: 9 })), ['contract-unknown']);
  assert.deepEqual(codes(parse({ auraContract: 1, services: [{ name: 'db', image: 'x' }] })), ['sidecars-undeclared']);
  assert.deepEqual(codes(parse({ auraContract: 1, permissions: ['sidecars.spawn'], services: [{ name: 'db', image: 'x', privileged: true }] })), ['privileged-undeclared']);
  assert.deepEqual(codes(parse({ auraContract: 1, permissions: ['sidecars.spawn'], services: [{ name: 'db', image: 'x', inheritDockerSocket: true }] })), ['docker-undeclared']);
  assert.deepEqual(codes(parse({ auraContract: 1, permissions: ['sidecars.spawn', 'sidecars.privileged'], services: [{ name: 'db', image: 'x', devices: ['/dev/x'] }] })), []);
  assert.deepEqual(codes(parse({ auraContract: 1, tools: ['docker'], services: [{ name: 'db', image: 'x', publish: [{ host: 1, container: 2 }] }] })), []);
});

test('layerWrites keeps written leaves outside scratch paths', () => {
  const r = layerWrites(['C /root', 'A /root/.npm', 'A /root/.npm/x.json', 'C /tmp', 'A /tmp/a', 'D /etc/old', 'C /etc', 'C /etc/hosts', 'A /var/run/x']);
  assert.deepEqual(r, { writes: ['/etc/hosts', '/root/.npm/x.json'], truncated: false });
  const many = layerWrites(Array.from({ length: 30 }, (_, i) => `A /f${i}`), 5);
  assert.equal(many.writes.length, 5);
  assert.equal(many.truncated, true);
});

test('scanInstallWrites lists files changed after the manifest, skipping build output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'datadir-'));
  const old = Date.now() / 1000 - 3600;
  writeFileSync(join(dir, 'app.manifest.json'), '{}');
  utimesSync(join(dir, 'app.manifest.json'), old, old);
  writeFileSync(join(dir, 'src.ts'), '');
  utimesSync(join(dir, 'src.ts'), old, old);
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'state', 'db.json'), '{}');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'x.js'), '');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  assert.deepEqual(scanInstallWrites(dir), { writes: ['state/db.json'], truncated: false });
  assert.deepEqual(scanInstallWrites(join(dir, 'missing')), { writes: [], truncated: false });
});

test('dataDirReport combines install folder, container layer and the home mount', async () => {
  const deps = {
    homePath: '/home/aura',
    installWrites: (dir) => ({ writes: dir === '/a' ? ['notes.db'] : [], truncated: false }),
    dockerDiff: async (c) => (c === 'aura-b-1' ? ['C /root', 'A /root/.cache-x'] : null),
    dockerMounts: async () => [{ destination: '/home/aura', rw: true }, { destination: '/data', rw: true }],
  };
  const r = await dataDirReport([
    { appId: 'a', scope: 'user', dir: '/a', sandbox: 'proot', instances: [{ instanceId: 'a' }] },
    { appId: 'b', scope: 'user', dir: '/b', sandbox: 'container', instances: [{ instanceId: 'b-1', container: 'aura-b-1' }] },
    { appId: 'c', scope: 'user', dir: '/c', sandbox: 'container', instances: [{ instanceId: 'c-1', container: 'aura-c-1' }] },
  ], deps);
  assert.deepEqual(r.map((x) => [x.appId, x.outside, x.home]), [['a', true, 'rw'], ['b', true, 'rw'], ['c', false, 'rw']]);
  assert.deepEqual(r[1].containerLayer, [{ instanceId: 'b-1', writes: ['/root/.cache-x'], truncated: false }]);
  assert.deepEqual(r[2].containerLayer, [{ instanceId: 'c-1', error: 'docker diff unavailable' }]);
});

test('source scan: undeclared context keys, raw Context reads, permissions, docker, interfaces', async () => {
  const { scanContractText, scanContractSources } = await import('../dist/contract/sourceScan.js');
  const m = parse({ auraContract: 1, context: ['GOOD_KEY'], permissions: ['user.confirm'], consumes: [{ name: 'search', kind: 'http/mcp' }] });
  const text = [
    "const a = await osClient.context.get('GOOD_KEY');",
    "const b = await osClient.context.get('BAD_KEY');",
    "// const c = await osClient.context.get('COMMENTED');",
    "const raw = readFileSync('/run/context/OPENAI_API_KEY', 'utf8');",
    "const env = process.env.OPENAI_API_KEY;",
    "await osClient.user.confirm({ action: 'x' });",
    "await osClient.storage.set('k', 1);",
    "execFile('docker', ['ps']);",
    "await osClient.interfaces.resolve('com.aura.docs/search');",
    "await osClient.interfaces.resolve('tts');",
  ].join('\n');
  const f = scanContractText('src/x.ts', text, m, ['OPENAI_API_KEY']);
  assert.deepEqual(f.map((x) => [x.line, x.code]), [
    [2, 'context-undeclared'], [4, 'context-raw'], [5, 'context-raw'], [7, 'permission-undeclared'], [8, 'docker-undeclared'], [10, 'interface-undeclared'],
  ]);
  assert.match(f[3].message, /storage\.read/);
  assert.equal(scanContractText('a.ts', "execFile('docker', ['ps']);", parse({ tools: ['docker'] })).length, 0);
  // Stream C: a declared key is in the env once granted, so its env read is not a finding.
  assert.equal(scanContractText('a.ts', 'const k = process.env.GOOD_KEY;', m, ['GOOD_KEY']).length, 0);
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'src', 'a.ts'), "cat('/run/context/X')\n");
  writeFileSync(join(dir, 'node_modules', 'b.js'), "cat('/run/context/X')\n");
  assert.deepEqual(scanContractSources(dir, parse()).map((x) => [x.file, x.code]), [['src/a.ts', 'context-raw']]);
});
