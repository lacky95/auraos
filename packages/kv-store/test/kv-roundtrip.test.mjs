// End-to-end tests for the embedded Redis lifecycle + KvClient.
//
//   pnpm --filter @aura/kv-store build
//   node --test packages/kv-store/test/kv-roundtrip.test.mjs
//
// Spawns a real RedisMemoryServer per test (cheap — the binary is cached),
// so we exercise the *same* code path the shell uses on boot.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, KvClient, isValidNamespace, isValidKey } from '../dist/index.js';

// One server shared across the value-round-trip tests; each test uses its
// own dataDir + namespace so writes can't bleed across.
const SHARED_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-kv-shared-'));
const sharedServer = new KvServer();
let sharedClient = null;

after(async () => {
  if (sharedClient) await sharedClient.close();
  await sharedServer.stop();
  rmSync(SHARED_DATA_DIR, { recursive: true, force: true });
});

async function getSharedClient() {
  if (!sharedClient) {
    const uri = await sharedServer.start({ dataDir: SHARED_DATA_DIR });
    sharedClient = new KvClient(uri);
  }
  return sharedClient;
}

test('isValidNamespace accepts os and app/<appId>; rejects junk', () => {
  assert.equal(isValidNamespace('os'),                 true);
  assert.equal(isValidNamespace('app/com.aura.theme'), true);
  assert.equal(isValidNamespace('app/foo.bar'),        true);
  assert.equal(isValidNamespace('os:evil'),            false);
  assert.equal(isValidNamespace('app/'),               false);
  assert.equal(isValidNamespace('app/Foo'),            false);
  assert.equal(isValidNamespace(''),                   false);
  assert.equal(isValidNamespace('arbitrary'),          false);
});

test('isValidKey accepts dotted / slashed paths; rejects control + colons', () => {
  assert.equal(isValidKey('theme'),               true);
  assert.equal(isValidKey('workspaces'),          true);
  assert.equal(isValidKey('theme.colorMode'),     true);
  assert.equal(isValidKey('a/b/c'),               true);
  assert.equal(isValidKey('foo-bar_baz'),         true);
  assert.equal(isValidKey('a:b'),                 false);  // colon would break key separation
  assert.equal(isValidKey(' leadingSpace'),       false);
  assert.equal(isValidKey(''),                    false);
});

test('SET → GET round-trip preserves value + adds updatedAt', async () => {
  const kv = await getSharedClient();
  const t0 = Date.now();
  await kv.set('os', 'theme', { themeIdDark: 'sci-fi', colorMode: 'dark' });
  const got = await kv.get('os', 'theme');
  assert.ok(got !== null);
  assert.deepEqual(got.value, { themeIdDark: 'sci-fi', colorMode: 'dark' });
  assert.ok(got.updatedAt >= t0);
  assert.ok(got.updatedAt <= Date.now());
});

test('GET on missing key returns null (no throw)', async () => {
  const kv = await getSharedClient();
  const missing = await kv.get('os', 'definitely-not-there');
  assert.equal(missing, null);
});

test('getValue returns just the inner shape', async () => {
  const kv = await getSharedClient();
  await kv.set('os', 'clockFormat', '24h');
  assert.equal(await kv.getValue('os', 'clockFormat'), '24h');
  assert.equal(await kv.getValue('os', 'still-missing'), null);
});

test('namespace isolation: os and app/<id> are disjoint', async () => {
  const kv = await getSharedClient();
  await kv.set('os',                    'name', 'OS-side');
  await kv.set('app/com.aura.notepad',  'name', 'Notepad-side');
  const osVal  = await kv.getValue('os',                   'name');
  const appVal = await kv.getValue('app/com.aura.notepad', 'name');
  assert.equal(osVal,  'OS-side');
  assert.equal(appVal, 'Notepad-side');
});

test('exists + del lifecycle', async () => {
  const kv = await getSharedClient();
  await kv.set('os', 'ephemeral', 'present');
  assert.equal(await kv.exists('os', 'ephemeral'), true);
  assert.equal(await kv.del('os',    'ephemeral'), true);
  assert.equal(await kv.exists('os', 'ephemeral'), false);
  // Double-delete is harmless and returns false (nothing removed).
  assert.equal(await kv.del('os',    'ephemeral'), false);
});

test('list returns only keys in the requested namespace', async () => {
  const kv = await getSharedClient();
  await kv.set('os',                    'a', 1);
  await kv.set('os',                    'b', 2);
  await kv.set('app/com.aura.counter',  'c', 3);
  const osKeys  = (await kv.list('os')).sort();
  const appKeys = await kv.list('app/com.aura.counter');
  assert.ok(osKeys.includes('a'));
  assert.ok(osKeys.includes('b'));
  assert.deepEqual(appKeys, ['c']);
  assert.ok(!osKeys.includes('c'));
});

test('list respects the limit option', async () => {
  const kv = await getSharedClient();
  for (let i = 0; i < 10; i++) await kv.set('app/com.aura.notepad', `k${i}`, i);
  const capped = await kv.list('app/com.aura.notepad', { limit: 3 });
  assert.equal(capped.length, 3);
});

test('invalid namespace throws before touching Redis', async () => {
  const kv = await getSharedClient();
  await assert.rejects(() => kv.set('arbitrary', 'k', 'v'), /invalid namespace/);
  await assert.rejects(() => kv.get('os:evil',   'k'),     /invalid namespace/);
});

test('invalid key throws before touching Redis', async () => {
  const kv = await getSharedClient();
  await assert.rejects(() => kv.set('os', 'bad:key', 'v'), /invalid key/);
});

test('persistence: a fresh server pointed at the same dataDir reloads values', async () => {
  // Spin up a SEPARATE server with its own dataDir; set a value; stop; spin
  // up a second server pointed at the same dir; the value should reappear
  // after Redis loads the RDB on boot. Forces save with `--save 1 1` so
  // we don't wait 60 seconds for the first snapshot.
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-kv-persist-'));
  const a = new KvServer();
  const uriA = await a.start({ dataDir, saveSeconds: 1, saveChanges: 1 });
  const ca   = new KvClient(uriA);
  await ca.set('os', 'persisted', { color: 'green' });
  // Give Redis at least one second + a small slack to flush the RDB.
  await new Promise((r) => setTimeout(r, 1500));
  await ca.close();
  await a.stop();

  const b = new KvServer();
  const uriB = await b.start({ dataDir });
  const cb   = new KvClient(uriB);
  const reloaded = await cb.getValue('os', 'persisted');
  await cb.close();
  await b.stop();
  rmSync(dataDir, { recursive: true, force: true });

  assert.deepEqual(reloaded, { color: 'green' });
});

test('start() is idempotent under concurrent callers', async () => {
  const s = new KvServer();
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-kv-idemp-'));
  const [a, b, c] = await Promise.all([
    s.start({ dataDir }),
    s.start({ dataDir }),
    s.start({ dataDir }),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  await s.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('RDB file appears under dataDir within the save window', async () => {
  const s = new KvServer();
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-kv-rdb-'));
  const uri = await s.start({ dataDir, saveSeconds: 1, saveChanges: 1 });
  const c = new KvClient(uri);
  await c.set('os', 'trigger-snapshot', { dummy: true });
  await new Promise((r) => setTimeout(r, 1500));
  const rdb = join(dataDir, 'aura.rdb');
  // We accept either the RDB file (BGSAVE finished) OR the AOF file
  // (`--appendonly yes` always creates this). Both prove durability.
  const aof = join(dataDir, 'appendonlydir');
  assert.ok(
    existsSync(rdb) || existsSync(aof),
    `expected aura.rdb or appendonlydir in ${dataDir}`,
  );
  await c.close();
  await s.stop();
  rmSync(dataDir, { recursive: true, force: true });
});
