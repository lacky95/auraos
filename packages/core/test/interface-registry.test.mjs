// Tests for the Interface Registry — the catalog/live projection, the
// leak-proofing, and the manifest schema that feeds it.
//
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/interface-registry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InterfaceRegistry, interfaceUrl } from '../dist/interfaces/InterfaceRegistry.js';
import { AppManifestSchema } from '../dist/types/manifest.js';

/** Minimal valid manifest; `over` patches whatever the test cares about. */
function manifest(over = {}) {
  return AppManifestSchema.parse({
    id: 'com.acme.api',
    name: 'API',
    version: '1.0.0',
    entrypoint: 'index.js',
    ...over,
  });
}

function instance(over = {}) {
  return {
    instanceId: 'com.acme.api',
    appId: 'com.acme.api',
    state: 'resumed',
    pid: 1234,
    port: 4002,
    startedAt: new Date(),
    lastTransitionAt: new Date(),
    restartCount: 0,
    ...over,
  };
}

const REST = { name: 'transcribe', kind: 'rest', address: '/api/transcribe' };

// ─────────────────────────────── schema ───────────────────────────────────

test('provides/consumes default to empty arrays', () => {
  const m = manifest();
  assert.deepEqual(m.provides, []);
  assert.deepEqual(m.consumes, []);
});

test('path kinds require a leading slash; event/kv must not have one', () => {
  assert.throws(() => manifest({ provides: [{ name: 'x', kind: 'rest', address: 'api/x' }] }));
  assert.throws(() => manifest({ provides: [{ name: 'x', kind: 'event', address: '/topic' }] }));
  // The valid forms of each.
  assert.ok(manifest({ provides: [{ name: 'x', kind: 'mcp', address: '/mcp' }] }));
  assert.ok(manifest({ provides: [{ name: 'x', kind: 'event', address: 'api:done' }] }));
});

test('duplicate provides[].name is rejected — the ref would be ambiguous', () => {
  assert.throws(() => manifest({
    provides: [
      { name: 'dup', kind: 'rest', address: '/a' },
      { name: 'dup', kind: 'ws',   address: '/b' },
    ],
  }));
});

test('interface names must be kebab-case', () => {
  assert.throws(() => manifest({ provides: [{ name: 'Not_Kebab', kind: 'rest', address: '/a' }] }));
});

// ─────────────────────────────── catalog ──────────────────────────────────

test('catalog: a declared-but-never-started app is discoverable, with no url', () => {
  const reg = new InterfaceRegistry();
  reg.reload([manifest({ provides: [REST] })]);
  const [view] = reg.list();
  assert.equal(view.id, 'com.acme.api/transcribe');
  assert.equal(view.status, 'catalog');
  assert.equal(view.url, undefined);
  assert.equal(view.version, '1');           // schema default
});

test('catalog: reload replaces wholesale — an uninstalled app disappears', () => {
  const reg = new InterfaceRegistry();
  reg.reload([manifest({ provides: [REST] })]);
  assert.equal(reg.list().length, 1);
  reg.reload([]);
  assert.equal(reg.list().length, 0);
});

// ──────────────────────────────── live ────────────────────────────────────

test('live: a running instance turns a catalog entry into a dialable address', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  reg.registerInstance(instance(), m);

  const [view] = reg.list();
  assert.equal(view.status, 'live');
  assert.equal(view.source, 'manifest');
  assert.equal(view.instanceId, 'com.acme.api');
  assert.equal(view.url, '/api/proxy/com.acme.api/api/transcribe');
  // One entry, not two — the live view represents the catalog entry.
  assert.equal(reg.list().length, 1);
});

test('live: warm-pool members register nothing', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);

  reg.registerInstance(instance({ inPool: true }), m);
  assert.equal(reg.list()[0].status, 'catalog', 'a pool member must not claim an address');

  reg.registerInstance(instance({ inPool: false }), m);
  assert.equal(reg.list()[0].status, 'live');
});

test('live: a portless or dying instance is down, not live', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);

  reg.registerInstance(instance({ port: null }), m);
  let [view] = reg.list();
  assert.equal(view.status, 'down');
  assert.equal(view.url, undefined);

  reg.registerInstance(instance({ state: 'error' }), m);
  [view] = reg.list();
  assert.equal(view.status, 'down');
});

test('live: a paused instance stays live — the port is still bound', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  reg.registerInstance(instance({ state: 'paused' }), m);

  const [view] = reg.list();
  assert.equal(view.status, 'live');
  assert.equal(view.state, 'paused');
});

test('live: liveness is read fresh, not from the snapshot taken at register time', () => {
  // AppManager REPLACES instance objects on every transition, so a registry
  // holding a reference would report a stale port forever.
  const table = new Map([['com.acme.api', instance()]]);
  const reg = new InterfaceRegistry((id) => table.get(id));
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  reg.registerInstance(instance(), m);
  assert.equal(reg.list()[0].status, 'live');

  table.set('com.acme.api', instance({ port: null, state: 'stopped' }));
  assert.equal(reg.list()[0].status, 'down', 'must follow the current instance record');
});

// ───────────────────────── runtime registration ───────────────────────────

test('runtime: register appears, and dies with the instance even without unregister', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  reg.registerInstance(instance(), m);

  assert.deepEqual(reg.register('com.acme.api', { name: 'live-feed', kind: 'ws', address: '/ws', version: '1' }), { ok: true });
  const dynamic = reg.list({ name: 'live-feed' })[0];
  assert.equal(dynamic.source, 'runtime');
  assert.equal(dynamic.url, '/api/proxy/com.acme.api/ws');

  // The app crashes without ever calling unregister().
  reg.unregisterInstance(instance());
  assert.equal(reg.list({ name: 'live-feed' }).length, 0, 'runtime entries must not leak');
  assert.equal(reg.list()[0].status, 'catalog', 'the declared one falls back to catalog');
});

test('runtime: an app that declares nothing can still register at runtime', () => {
  // The dynamic case: an app whose interface address is not known until it is
  // up has nothing to put in its manifest. Being live is what earns the slot.
  const reg = new InterfaceRegistry();
  const m = manifest();                       // no `provides` at all
  reg.reload([m]);
  reg.registerInstance(instance(), m);

  assert.deepEqual(reg.register('com.acme.api', { name: 'feed', kind: 'ws', address: '/ws', version: '1' }), { ok: true });
  const [view] = reg.list();
  assert.equal(view.source, 'runtime');
  assert.equal(view.status, 'live');
});

test('runtime: unknown instance → 404, manifest name → 409, runtime name → overwrite', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  reg.registerInstance(instance(), m);

  assert.equal(reg.register('nope', { ...REST, name: 'other', version: '1' }).status, 404);
  assert.equal(reg.register('com.acme.api', { ...REST, version: '1' }).status, 409);

  reg.register('com.acme.api', { name: 'feed', kind: 'ws', address: '/ws-1', version: '1' });
  reg.register('com.acme.api', { name: 'feed', kind: 'ws', address: '/ws-2', version: '1' });
  const feeds = reg.list({ name: 'feed' });
  assert.equal(feeds.length, 1, 're-registering moves the address, it does not duplicate');
  assert.equal(feeds[0].address, '/ws-2');
});

test('runtime: unregister removes only runtime entries, never a declaration', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  reg.registerInstance(instance(), m);
  reg.register('com.acme.api', { name: 'feed', kind: 'ws', address: '/ws', version: '1' });

  assert.equal(reg.unregister('com.acme.api', 'feed'), true);
  assert.equal(reg.unregister('com.acme.api', 'transcribe'), false, 'a declaration is not the app\'s to drop');
  assert.equal(reg.list({ name: 'transcribe' })[0].status, 'live');
});

/** The shape AppManager passes to reconcile(). */
function liveMap(...pairs) {
  return new Map(pairs.map(([inst, m]) => [inst.instanceId, { instance: inst, manifest: m }]));
}

test('reconcile drops records for instances the OS no longer tracks', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  const inst = instance();
  reg.registerInstance(inst, m);

  assert.deepEqual(reg.reconcile(liveMap([inst, m])), { dropped: 0, restored: 0 }, 'a tracked instance survives');
  assert.deepEqual(reg.reconcile(new Map()), { dropped: 1, restored: 0 });
  assert.equal(reg.list()[0].status, 'catalog');
});

test('reconcile restores a live instance that lost its declared interfaces', () => {
  // Observed for real: stop() deregisters BEFORE it transitions, so a stop that
  // then throws leaves a running, resumed app with no interfaces and nothing to
  // re-register it. Discovery would keep lying until the next restart.
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  const inst = instance();
  reg.registerInstance(inst, m);

  reg.unregisterInstance(inst);                       // the failed stop
  assert.equal(reg.list()[0].status, 'catalog', 'precondition: the entry is gone');

  const delta = reg.reconcile(liveMap([inst, m]));    // the app never actually stopped
  assert.deepEqual(delta, { dropped: 0, restored: 1 });
  assert.equal(reg.list()[0].status, 'live', 'the projection heals itself');
});

test('reconcile never resurrects runtime registrations', () => {
  // A runtime entry is a fact about a process; only that process can assert it.
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  const inst = instance();
  reg.registerInstance(inst, m);
  reg.register(inst.instanceId, { name: 'feed', kind: 'ws', address: '/ws', version: '1' });

  reg.unregisterInstance(inst);
  reg.reconcile(liveMap([inst, m]));
  assert.equal(reg.list({ name: 'transcribe' })[0].status, 'live', 'declared entries come back');
  assert.equal(reg.list({ name: 'feed' }).length, 0, 'runtime entries do not');
});

test('reconcile leaves pool members alone', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ provides: [REST] });
  reg.reload([m]);
  const pooled = instance({ inPool: true });

  assert.deepEqual(reg.reconcile(liveMap([pooled, m])), { dropped: 0, restored: 0 });
  assert.equal(reg.list()[0].status, 'catalog');
});

// ──────────────────────────── resolve / consumers ─────────────────────────

test('resolve prefers a resumed instance over any other live state', () => {
  const m = manifest({ instanceMode: 'multi', provides: [REST] });
  const table = new Map([
    ['com.acme.api-1', instance({ instanceId: 'com.acme.api-1', state: 'started' })],
    ['com.acme.api-2', instance({ instanceId: 'com.acme.api-2', state: 'resumed' })],
  ]);
  const reg = new InterfaceRegistry((id) => table.get(id));
  reg.reload([m]);
  for (const inst of table.values()) reg.registerInstance(inst, m);

  assert.equal(reg.list().length, 2, 'the phone book lists both numbers');
  assert.equal(reg.resolve('com.acme.api/transcribe').instanceId, 'com.acme.api-2');
});

test('resolve falls back to the catalog entry so callers see it exists but is stopped', () => {
  const reg = new InterfaceRegistry();
  reg.reload([manifest({ provides: [REST] })]);
  const view = reg.resolve({ name: 'transcribe', kind: 'rest' });
  assert.equal(view.status, 'catalog');
  assert.equal(reg.resolve('com.acme.api/nothing-here'), null);
});

test('consumers report live / installed / unmet', () => {
  const provider = manifest({ provides: [REST] });
  const consumer = AppManifestSchema.parse({
    id: 'com.acme.ui', name: 'UI', version: '1.0.0', entrypoint: 'index.js',
    consumes: [
      { name: 'transcribe', kind: 'rest' },
      { name: 'nowhere',    kind: 'mcp', required: false },
    ],
  });

  const reg = new InterfaceRegistry();
  reg.reload([provider, consumer]);

  let [transcribe, nowhere] = reg.consumers();
  assert.equal(transcribe.status, 'installed', 'declared but nothing running');
  assert.deepEqual(transcribe.matches, ['com.acme.api/transcribe']);
  assert.equal(nowhere.status, 'unmet');
  assert.equal(nowhere.need.required, false);

  reg.registerInstance(instance(), provider);
  [transcribe] = reg.consumers();
  assert.equal(transcribe.status, 'live');
});

test('a consumer pinned to an appId ignores a same-name provider from another app', () => {
  const other = AppManifestSchema.parse({
    id: 'com.other.api', name: 'Other', version: '1.0.0', entrypoint: 'index.js',
    provides: [REST],
  });
  const consumer = AppManifestSchema.parse({
    id: 'com.acme.ui', name: 'UI', version: '1.0.0', entrypoint: 'index.js',
    consumes: [{ name: 'transcribe', kind: 'rest', appId: 'com.acme.api' }],
  });

  const reg = new InterfaceRegistry();
  reg.reload([other, consumer]);
  assert.equal(reg.consumers()[0].status, 'unmet', 'the pin excludes the other app');
});

// ────────────────────────────── addresses ─────────────────────────────────

test('interfaceUrl routes each kind to the transport that already exists', () => {
  assert.equal(interfaceUrl('inst-1', 'mcp',   '/mcp'),        '/api/proxy/inst-1/mcp');
  assert.equal(interfaceUrl('inst-1', 'ws',    '/ws'),         '/api/proxy/inst-1/ws');
  assert.equal(interfaceUrl('inst-1', 'kv',    'app/x/jobs'),  '/api/kv/app/x/jobs');
  assert.equal(interfaceUrl('inst-1', 'event', 'api:done'),    '/api/apps/events?topics=api%3Adone');
});
