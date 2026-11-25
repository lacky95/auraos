// The Nexus config keys of the OS KV (`os/nexus/*`) are read and written in
// process (nexus/osKv.ts), against a REAL valkey-server. They used to go over
// the shell's own `/api/kv` on loopback as an anonymous caller, which
// `enforce` refuses: no fetch may happen here at all.
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kvServer, createRedis } from '@aura/kv-store';
import {
  DEFAULT_SOURCES_CONFIG, OsEventBus, loadSourcesConfig, readOsKey, saveSourcesConfig,
  seedSourcesConfigIfMissing, writeOsKey,
} from '../dist/index.js';
import { operatorRequestSubject } from '../dist/auth/setupTickets.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-nexus-kv-'));
let redis;
const realFetch = globalThis.fetch;

before(async () => {
  const uri = await kvServer.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
  globalThis.fetch = () => { throw new Error('no HTTP: the nexus config is read in process'); };
});

beforeEach(async () => { await redis.flushall(); });

after(async () => {
  globalThis.fetch = realFetch;
  redis?.disconnect();
  await kvServer.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const OCI = { kind: 'oci', name: 'mine', url: 'http://reg.example:5000', priority: 5, mirror: false };

test('nothing stored: the default sources, and seeding persists them', async () => {
  assert.deepEqual(await loadSourcesConfig(), DEFAULT_SOURCES_CONFIG);
  assert.equal(await readOsKey('nexus/sources'), undefined);
  await seedSourcesConfigIfMissing();
  assert.deepEqual(await readOsKey('nexus/sources'), DEFAULT_SOURCES_CONFIG);
});

test('a save is read back, under the same key the /api/kv proxy serves', async () => {
  const cfg = { schema: 1, sources: [OCI] };
  await saveSourcesConfig(cfg);
  assert.deepEqual(await loadSourcesConfig(), cfg);
  // The proxy's KvClient layout: namespace `os`, key `nexus/sources`.
  assert.equal(await redis.exists('os:nexus/sources'), 1);
});

test('the legacy registries key migrates once into sources', async () => {
  await writeOsKey('nexus/registries', { registries: [{ name: 'old', url: 'http://old:4090', priority: 1, mirror: true }] });
  const cfg = await loadSourcesConfig();
  assert.deepEqual(cfg.sources, [{ kind: 'oci', name: 'old', url: 'http://old:4090', priority: 1, mirror: true }]);
  assert.deepEqual(await readOsKey('nexus/sources'), cfg);
});

test('a write emits kv:changed as the proxy does', async () => {
  const seen = [];
  const fn = (ev) => seen.push(ev);
  OsEventBus.on('kv:changed', fn);
  try {
    await writeOsKey('nexus/source-seeds', { a: 1 });
  } finally {
    OsEventBus.off('kv:changed', fn);
  }
  assert.deepEqual(seen, [{ namespace: 'os', key: 'nexus/source-seeds', value: { a: 1 } }]);
});

test('an operator request subject names exactly one method and path', () => {
  const s = operatorRequestSubject('get', '/api/apps');
  assert.match(s, /^request:[0-9a-f]{64}$/);
  assert.equal(s, operatorRequestSubject('GET', '/api/apps'));
  assert.notEqual(s, operatorRequestSubject('POST', '/api/apps'));
  assert.notEqual(s, operatorRequestSubject('GET', '/api/apps/x'));
});
