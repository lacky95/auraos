// Fewer boot requests: the shared /api/apps snapshot and ETag answers
// (lib/appsSnapshot.ts, lib/etag.ts).
//
//   cd packages/shell && npx tsx --test test/boot-fetch-diet.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAppsSnapshot, appsSnapshotStats, _resetAppsSnapshot } from '../src/lib/appsSnapshot.ts';
import { etagOf, isFresh, withEtag } from '../src/lib/etag.ts';

let calls = 0;
const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  _resetAppsSnapshot();
  calls = 0;
  g['fetch'] = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify([{ manifest: { id: 'a', name: 'A' } }]), { status: 200 });
  };
  delete g['window'];
});

test('concurrent callers share one request; a young copy is reused', async () => {
  const [a, b, c] = await Promise.all([getAppsSnapshot(), getAppsSnapshot(), getAppsSnapshot()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  await getAppsSnapshot();
  assert.equal(calls, 1);
  assert.deepEqual(appsSnapshotStats(), { network: 1, shared: 2, cached: 1, adoptedBoot: 0 });
});

test('fresh skips the copy; an expired copy refetches', async () => {
  await getAppsSnapshot();
  await getAppsSnapshot({ fresh: true });
  assert.equal(calls, 2);
  await new Promise((r) => setTimeout(r, 10));
  await getAppsSnapshot({ maxAgeMs: 1 });
  assert.equal(calls, 3);
});

test('the head probe promise is adopted instead of a second request', async () => {
  g['window'] = { __auraAppsBoot: Promise.resolve([{ manifest: { id: 'boot' } }]) };
  const list = await getAppsSnapshot();
  assert.equal(calls, 0);
  assert.equal(list[0]!.manifest!.id, 'boot');
  assert.equal((g['window'] as Record<string, unknown>)['__auraAppsBoot'], undefined);
});

test('a failed head probe falls back to the network', async () => {
  g['window'] = { __auraAppsBoot: Promise.resolve(null) };
  const list = await getAppsSnapshot();
  assert.equal(calls, 1);
  assert.equal(list[0]!.manifest!.id, 'a');
});

test('ETag: 304 for a matching If-None-Match, 200 otherwise', async () => {
  const tag = etagOf('body');
  assert.equal(tag, etagOf('body'));
  assert.notEqual(tag, etagOf('other'));
  const req = (inm?: string) => new Request('http://x/', inm ? { headers: { 'if-none-match': inm } } : {});
  assert.equal(isFresh(req(tag), tag), true);
  assert.equal(isFresh(req(`W/${tag}, "zzz"`), tag), true);
  assert.equal(isFresh(req('"zzz"'), tag), false);
  const fresh = withEtag(req(tag), 'body', 'text/css');
  assert.equal(fresh.status, 304);
  assert.equal(fresh.headers.get('etag'), tag);
  const full = withEtag(req(), 'body', 'text/css');
  assert.equal(full.status, 200);
  assert.equal(await full.text(), 'body');
  assert.equal(full.headers.get('cache-control'), 'no-cache');
});
