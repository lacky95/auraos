// Phase 6 K: the shared bootstrap (bootSystem). The golden boot order, idempotence across
// module copies, readiness in status.json, hooks per composition, the one shutdown sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/system/bootstrap.ts', import.meta.url));
const APP_MANAGER = fileURLToPath(new URL('../src/app-manager/AppManager.ts', import.meta.url));
const SYSTEM_KEY = Symbol.for('aura.system');

/** The calls in source order inside one function body. */
function order(file, fnStart, markers) {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(fnStart);
  assert.ok(start >= 0, `${fnStart} in ${file}`);
  const at = markers.map((m) => [m, src.indexOf(m, start)]);
  for (const [m, i] of at) assert.ok(i > start, `${m} is in ${fnStart}`);
  return at.slice().sort((a, b) => a[1] - b[1]).map(([m]) => m);
}

test('golden boot order: identity first (A2), then KV, seeds, before-apps hooks, context, app manager, ready', () => {
  const golden = [
    'ensureSystemIdentity(dataDir)',
    'state.opts.early?.(dataDir)',
    'kvServer.start(',
    'bootstrapKv(',
    'seedInfraPolicy(dataDir',
    'importBootstrapCredentials(',
    'retireSharedAdminCredential(',
    'getNotificationService().start()',
    "hook.phase === 'beforeApps'",
    '.materializeAll()',
    '.ensureAll()',
    'initAppManager(',
    'mgr.interfaces.setCustom(',
    'await mgr.init()',
    'st.kernelReadyAt = now()',
  ];
  assert.deepEqual(order(SRC, 'async function bootKernel(', golden), golden);
});

test('golden boot order, step 0 (D94 IC-5, acceptance 4): infrastructure is loaded before the kernel boot can reach the network', () => {
  const golden = ['g[SYSTEM_KEY] = state;', 'loadInfrastructure({', 'installSignalHandlers()', 'await opts.kernel(', 'await bootKernel(state'];
  assert.deepEqual(order(SRC, 'export function bootSystem(', golden), golden);
});

test('golden: AppManager.init, the boot reconciliation order (enable state, adoption, reconcile, sidecars, migrations, respawn, reconciler, starts)', () => {
  // ari-gap-review §5.4 (Phase 6 K): adoption, then each group's actual state against the kernel's
  // desired state, then reapply; the PRoot respawn (5b RS) from the record read before anything changed it.
  const golden = [
    'await this.hydrateEnabledState()',
    'readRespawnRecord(this.dataDir)',
    'await this.registry.init()',
    'this.adoptOrphans()',
    'await this.reconcileSurvivors()',
    'await this.stopTokenlessSurvivors()',
    'await this.syncSidecars(1)',
    'await this.migrateAppHosts()',
    'await this.migrateRuntimes()',
    'await this.migrateContext()',
    'this.respawnFromRecord(respawn)',
    'this.startReconciler()',
    'this.startService(m.id)',
    'this.start(m.id)',
  ];
  assert.deepEqual(order(APP_MANAGER, '  async init(): Promise<void> {', golden), golden);
});

function fresh() {
  delete globalThis[SYSTEM_KEY];
  return mkdtempSync(join(tmpdir(), 'aura-boot-'));
}
const statusOf = (dir) => JSON.parse(readFileSync(join(dir, 'aura', 'boot', 'status.json'), 'utf8'));

test('bootSystem is idempotent across two module copies: one boot, one handle (R4)', async () => {
  const dir = fresh();
  try {
    const a = await import('../dist/system/bootstrap.js?copy=a');
    const b = await import('../dist/system/bootstrap.js?copy=b');
    let runs = 0;
    const kernel = async () => { runs++; };
    const h1 = a.bootSystem({ entry: 'server.mjs', dataDir: dir, composition: 'server', kernel });
    const h2 = b.bootSystem({ entry: 'astro-dev', dataDir: dir, kernel });
    assert.equal(h1, h2);
    await h1.ready;
    assert.equal(runs, 1);
    assert.equal(b.getSystem(), h1);
    const st = statusOf(dir);
    assert.equal(st.v, 1);
    assert.equal(st.entry, 'server.mjs');
    assert.equal(st.composition, 'server');
    assert.ok(st.kernelReadyAt);
    assert.equal(st.acceptingWrites, true);
    await h1.shutdown('stop');
  } finally { delete globalThis[SYSTEM_KEY]; rmSync(dir, { recursive: true, force: true }); }
});

test('readiness: not ready until the kernel steps finish; firstRequestAt comes after kernelReadyAt', async () => {
  const dir = fresh();
  try {
    const { bootSystem } = await import('../dist/system/bootstrap.js');
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = bootSystem({ entry: 'server.mjs', dataDir: dir, kernel: () => gate });
    assert.equal(h.isReady(), false);
    assert.equal(h.status().kernelReadyAt, null);
    release();
    await h.ready;
    assert.equal(h.isReady(), true);
    h.noteFirstRequest();
    const first = h.status().firstRequestAt;
    h.noteFirstRequest();
    assert.equal(h.status().firstRequestAt, first, 'stamped once');
    assert.ok(Date.parse(first) >= Date.parse(h.status().kernelReadyAt));
    await h.shutdown();
  } finally { delete globalThis[SYSTEM_KEY]; rmSync(dir, { recursive: true, force: true }); }
});

test('a failed boot is reported in status.json and rejects ready', async () => {
  const dir = fresh();
  try {
    const { bootSystem } = await import('../dist/system/bootstrap.js');
    const h = bootSystem({ entry: 'server.mjs', dataDir: dir, kernel: async () => { throw new Error('no valkey'); } });
    await assert.rejects(h.ready, /no valkey/);
    assert.equal(h.isReady(), false);
    assert.equal(statusOf(dir).error, 'no valkey');
    await h.shutdown();
  } finally { delete globalThis[SYSTEM_KEY]; rmSync(dir, { recursive: true, force: true }); }
});

test('hooks: server-layer hooks run in both compositions, Web Shell hooks only in desktop; server first', async () => {
  for (const composition of ['server', 'desktop']) {
    const dir = fresh();
    try {
      const { bootSystem } = await import('../dist/system/bootstrap.js');
      const ran = [];
      const h = bootSystem({
        entry: 'server.mjs', dataDir: dir, composition, kernel: async () => {},
        hooks: [
          { name: 'desk', layer: 'webshell', run: () => { ran.push('desk'); } },
          { name: 'srv', layer: 'server', run: () => { ran.push('srv'); } },
          { name: 'bad', layer: 'server', run: () => { throw new Error('boom'); } },
        ],
      });
      await h.ready;
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(ran, composition === 'desktop' ? ['srv', 'desk'] : ['srv']);
      assert.equal(h.status().hooks.bad.ok, false, 'a failing hook is recorded, never fatal');
      // late registration on a ready system runs at once
      h.onReady({ name: 'late', layer: 'server', run: () => { ran.push('late'); } });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(ran.includes('late'));
      await h.shutdown();
    } finally { delete globalThis[SYSTEM_KEY]; rmSync(dir, { recursive: true, force: true }); }
  }
});

test('shutdown: Web Shell hooks first, one sequence, bounded; stoppedAt in status.json', async () => {
  const dir = fresh();
  try {
    const { bootSystem, SHUTDOWN_BUDGET_MS, SHUTDOWN_HOOKS_MS } = await import('../dist/system/bootstrap.js');
    const seen = [];
    const h = bootSystem({
      entry: 'server.mjs', dataDir: dir, composition: 'desktop', kernel: async () => {},
      hooks: [
        { name: 'srv', layer: 'server', run() {}, shutdown: () => { seen.push('srv'); } },
        { name: 'desk', layer: 'webshell', run() {}, shutdown: () => { seen.push('desk'); return new Promise(() => {}); } },
      ],
    });
    await h.ready;
    const t0 = Date.now();
    const p1 = h.shutdown('stop');
    const p2 = h.shutdown('stop');
    await Promise.all([p1, p2]);
    const took = Date.now() - t0;
    assert.ok(took < SHUTDOWN_BUDGET_MS, `bounded (${took} ms)`);
    assert.ok(took >= SHUTDOWN_HOOKS_MS - 50, 'a hanging hook is cut at the hook budget');
    assert.deepEqual(seen, ['desk'], 'the hanging Web Shell hook ran first; the budget cut the rest');
    const st = statusOf(dir);
    assert.ok(st.stoppedAt && st.stoppingAt);
    assert.equal(st.stopReason, 'stop');
    assert.equal(h.isReady(), false);
  } finally { delete globalThis[SYSTEM_KEY]; rmSync(dir, { recursive: true, force: true }); }
});

test('composition from the environment: server or desktop (default)', async () => {
  const { compositionFromEnv } = await import('../dist/system/bootstrap.js');
  assert.equal(compositionFromEnv({ AURA_COMPOSITION: 'server' }), 'server');
  assert.equal(compositionFromEnv({}), 'desktop');
  assert.equal(compositionFromEnv({ AURA_COMPOSITION: 'bogus' }), 'desktop');
});
