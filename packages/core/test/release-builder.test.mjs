// Phase 6 stream B: the release builder (os/release/*.mjs), driven with a fake
// `docker` and real git: verification before anything runs, the staged-tree
// check, the activation lock, a failed build leaving the current release, the
// release record and its provenance, GC (current + previous), the D94 legacy
// builder refusal, the image fingerprint and the engines.node check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { ROOT, commitAll, git, release, throwawayKey, tmp, trustOf, write } from './release-fixtures.mjs';
import { auraSource, fakeDocker } from './release-builder-fixtures.mjs';

const B = await import(join(ROOT, 'os/release/builder.mjs'));
const LOCK = await import(join(ROOT, 'os/release/lock.mjs'));
const IMG = await import(join(ROOT, 'os/release/images.mjs'));
const LAYOUT = await import(join(ROOT, 'os/release/layout.mjs'));
const SERIES = await import(join(ROOT, 'os/release/series-slot.mjs'));

/** Runs build() with the fake docker on PATH (env applied for the call). */
async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function setup(opts = {}) {
  const key = throwawayKey();
  const src = auraSource(key, opts);
  const data = tmp('aura-data-');
  const fake = fakeDocker(data);
  const base = { dataRoot: data, dataVolume: 'test_aura-app-data', fetchFrom: src.dir, trust: trustOf(key), log: () => {} };
  const go = (o = {}, env = {}) => withEnv({ ...fake.env, ...env }, () => B.build({ ...base, ...o }));
  return { key, src, data, fake, base, go, L: LAYOUT.layout(data) };
}

const err = async (p) => { try { await p; } catch (e) { return e; } assert.fail('expected a refusal'); };
const stagingDirs = (L) => (existsSync(L.releases) ? readdirSync(L.releases).filter((n) => n.startsWith('.staging-')) : []);

test('a signed release builds into a read-only, complete release with its record and the first pointer', async () => {
  const s = setup();
  const r = await s.go({ firstInstall: true });
  assert.equal(r.ok, true);
  const dir = s.L.release(r.id);
  assert.ok(existsSync(join(dir, '.complete')));
  assert.equal(statSync(dir).mode & 0o222, 0, 'top dir read-only');
  assert.equal(statSync(join(dir, 'package.json')).mode & 0o222, 0, 'files read-only');
  assert.equal(existsSync(join(dir, '.git')), false, 'no .git in a release');
  const rec = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
  assert.equal(rec.v, 1);
  assert.equal(rec.commit, s.src.commit);
  assert.equal(rec.gitTree, git(s.src.dir, 'rev-parse', `${s.src.commit}^{tree}`));
  assert.equal(rec.provenance, 'upstream-signed');
  assert.deepEqual({ signed: rec.meta.signed, keyId: rec.meta.keyId }, { signed: true, keyId: s.key.keyId });
  assert.equal(rec.series.digest, SERIES.EMPTY_SERIES_DIGEST);
  assert.deepEqual(rec.series.order, []);
  assert.equal(rec.composition, 'desktop');
  assert.match(rec.images.shell, /^aura-shell:[0-9a-f]{16}$/);
  assert.match(rec.images.base, /^aura-base:[0-9a-f]{16}$/);
  assert.equal(rec.images.target, 'development', 'pre-L: no release target in the Dockerfile yet');
  assert.deepEqual(rec.node, { required: '>=22.23.4', base: 'v22.23.5', shell: 'v22.23.5' });
  assert.deepEqual(rec.components.source.filter((c) => c.kind !== 'root').map((c) => c.path),
    ['packages/core', 'packages/shell', 'apps/com.example.app', 'apps/com.example.raw', 'os']);
  assert.ok(rec.components.built.some((c) => c.name === 'com.example.app'));
  assert.deepEqual(rec.components.skipped, [{ name: 'com.example.raw', reason: 'own-entrypoint' }]);
  assert.equal(rec.auraContract, 1);
  assert.equal(rec.ari, 1);
  assert.match(rec.treeDigest, /^sha256:[0-9a-f]{64}$/);
  // treeDigest is recomputable from the finalized tree (diagnose/release).
  const V = await import(join(ROOT, 'os/release-verify.mjs'));
  assert.equal(rec.treeDigest, `sha256:${V.gitTreeOfDir(dir, { algo: 'sha256', skip: ['release.json', '.complete'] })}`);
  assert.deepEqual(B.readPointer(s.data), { v: 1, current: r.id, previous: null, switchedAt: B.readPointer(s.data).switchedAt, jobId: r.job });
  // The job checklist, the lock released, nothing left behind.
  const job = JSON.parse(readFileSync(s.L.job(r.job), 'utf8'));
  assert.equal(job.phase, 'done');
  assert.ok(job.steps.every((x) => x.status === 'done'), JSON.stringify(job.steps));
  assert.equal(existsSync(s.L.lock), false);
  assert.deepEqual(stagingDirs(s.L), []);
  assert.equal(existsSync(s.L.jobFiles(r.job)), false);
  assert.ok(existsSync(join(s.L.mirror, 'HEAD')), 'the mirror is under the data root');
});

test('the throwaway build containers get no socket, no home, no /data beyond staging + store; build and check run offline', async () => {
  const s = setup();
  await s.go({}, { FAKE_OFFLINE_RC: '1' });
  const runs = s.fake.calls().split('\n').filter((l) => l.includes('os/release/build.sh'));
  assert.equal(runs.length, 4, runs.join('\n'));   // deps --offline, deps, build, check
  for (const l of runs) {
    assert.doesNotMatch(l, /docker\.sock|\/home|aura-net|--privileged|-v \//);
    assert.match(l, /--cap-drop ALL --security-opt no-new-privileges/);
    assert.match(l, /target=\/workspace,volume-subpath=releases\/\.staging-/);
    assert.match(l, /target=\/pnpm-store,volume-subpath=aura\/pnpm-store/);
    assert.equal((l.match(/--mount/g) ?? []).length, 2, 'only staging and the store');
    // D106: the release limits profile through limits.mjs (= core limitArgs), no swap beyond memory
    assert.match(l, new RegExp(`--cpus=2 --memory=${6 * 1024 ** 3} --memory-swap=${6 * 1024 ** 3} --pids-limit=2048 `));
  }
  assert.match(runs[0], /--network none .* deps --offline$/);
  assert.match(runs[1], /--network bridge .* deps$/);
  assert.match(runs[2], /--network none .* build$/);
  assert.match(runs[3], /--network none .* check$/);
  assert.match(s.fake.calls(), /docker buildx build --load --target aura-base -t aura-base:[0-9a-f]{16}/);
});

test('the staged tree must equal the verified tree: an archive that differs is refused before any build', async () => {
  // export-ignore makes git archive leave a signed file out: the staged tree is not the signed tree.
  const s = setup({ extra: (d) => { write(d, '.gitattributes', 'secret.txt export-ignore\n'); write(d, 'secret.txt', 'x\n'); } });
  const e = await err(s.go());
  assert.equal(e.code, 'tree-mismatch');
  assert.equal(e.exit, 3);
  assert.match(e.message, /is not the verified tree/);
  assert.doesNotMatch(s.fake.calls(), /docker (run|build|buildx build)/, 'nothing built or run');
  assert.deepEqual(stagingDirs(s.L), [], 'staging removed');
  assert.equal(existsSync(s.L.lock), false);
});

test('a tampered or untrusted release is refused at verify, before anything is extracted', async () => {
  const s = setup();
  const e = await err(s.go({ trust: trustOf(throwawayKey()) }));
  assert.equal(e.code, 'verify-untrusted-key');
  assert.equal(e.step, 'verify');
  assert.equal(s.fake.calls(), '');
  assert.deepEqual(stagingDirs(s.L), []);
  const moved = await err(s.go({ expectCommit: '0'.repeat(40) }));
  assert.equal(moved.code, 'verify-moved');
});

test('lock contention: a second job is refused while the holder lives; a dead or silent holder is taken over (core release/lock.ts format)', async () => {
  const s = setup();
  const held = LOCK.acquireLock(s.L.lock, { jobId: '2026-01-01T00-00-00-000Z', autoHeartbeat: false });
  const h = JSON.parse(readFileSync(s.L.lock, 'utf8'));
  assert.deepEqual(Object.keys(h).sort(), ['at', 'by', 'heartbeatAt', 'host', 'jobId', 'pid', 'start'], 'lock.ts holder + heartbeatAt');
  assert.equal(s.L.lock, join(s.data, 'aura/release/lock'), "lock.ts activationLockPath(dataDir, 'system')");
  const e = await err(s.go());
  assert.equal(e.code, 'activation-busy');
  assert.match(e.message, /holds the activation lock: 2026-01-01T00-00-00-000Z/);
  assert.equal(s.fake.calls(), '', 'nothing ran');
  assert.equal(existsSync(s.L.mirror), false, 'not even fetched');
  assert.equal(held.owned(), true, 'the holder keeps it');
  held.release();
  const old = Date.now() - LOCK.STALE_MS - 1000;
  // A holder on this host whose process is gone (lock.ts staleHere).
  writeFileSync(s.L.lock, JSON.stringify({ jobId: '2026-01-02T00-00-00-000Z', pid: 2 ** 22 + 7, host: hostname(), start: null, at: Date.now(), by: 'x' }));
  const r = await s.go();
  const job = JSON.parse(readFileSync(s.L.job(r.job), 'utf8'));
  assert.match(job.steps.find((x) => x.key === 'lock').detail, /took over a stale lock of 2026-01-02T00-00-00-000Z/);
  // Another host (the updater container): busy while its heartbeat is fresh, stale after STALE_MS.
  writeFileSync(s.L.lock, JSON.stringify({ jobId: '2026-01-03T00-00-00-000Z', pid: 1, host: 'updater', start: null, at: old, heartbeatAt: Date.now() }));
  assert.equal((await err(s.go({ composition: 'server' }))).code, 'activation-busy');
  writeFileSync(s.L.lock, JSON.stringify({ jobId: '2026-01-03T00-00-00-000Z', pid: 1, host: 'updater', start: null, at: old, heartbeatAt: old }));
  assert.equal((await s.go({ composition: 'server' })).ok, true);
  assert.ok(LOCK.heartbeatStale({ at: old }) && !LOCK.heartbeatStale({ at: old, heartbeatAt: Date.now() }));
  // Same-process double acquire is refused too.
  const h2 = LOCK.acquireLock(s.L.lock, { jobId: '2026-01-04T00-00-00-000Z', autoHeartbeat: false });
  assert.throws(() => LOCK.acquireLock(s.L.lock, { jobId: '2026-01-05T00-00-00-000Z' }), (x) => x.code === 'activation-busy');
  h2.release();
});

test('durable: renames never replace; an exchange needs the rename-exchange helper (no two-rename fallback)', async () => {
  const D = await import(join(ROOT, 'os/release/durable.mjs'));
  const d = tmp('aura-durable-');
  mkdirSync(join(d, 'a')); mkdirSync(join(d, 'b'));
  const saved = process.env.AURA_RENAME_EXCHANGE;
  process.env.AURA_RENAME_EXCHANGE = join(d, 'no-helper');
  try {
    assert.throws(() => D.renameDurable(join(d, 'a'), join(d, 'b')), (e) => e.code === 'EEXIST');
    D.renameDurable(join(d, 'a'), join(d, 'c'));
    assert.ok(existsSync(join(d, 'c')) && !existsSync(join(d, 'a')));
    assert.throws(() => D.exchangeDurable(join(d, 'b'), join(d, 'c')), (e) => e.code === 'unsupported');
  } finally { if (saved === undefined) delete process.env.AURA_RENAME_EXCHANGE; else process.env.AURA_RENAME_EXCHANGE = saved; }
  assert.equal(readFileSync(join(ROOT, 'os/rename-exchange/rename-exchange.c'), 'utf8').includes('RENAME_EXCHANGE'), true, "Phase 7a's helper, the one implementation");
});

test('a failed build leaves the current release, the pointer and every other release untouched', async () => {
  const s = setup();
  const a = await s.go({ firstInstall: true });
  const ptr = readFileSync(s.L.pointer, 'utf8');
  write(s.src.dir, 'packages/core/src/x.ts', 'broken\n');
  commitAll(s.src.dir, 'v2');
  release(s.src.dir, '0.2.0', s.key);
  for (const [env, code] of [[{ FAKE_FAIL_BUILD: '1' }, 'build'], [{ FAKE_OFFLINE_RC: '1', FAKE_FAIL_DEPS: '1' }, 'deps'], [{ FAKE_FAIL_CHECK: '1' }, 'check'], [{ FAKE_FAIL_IMAGE: '1' }, 'image-build']]) {
    if (env.FAKE_FAIL_IMAGE) rmSync(join(s.fake.state, 'images'));   // force an image build
    const e = await err(s.go({}, env));
    assert.equal(e.code, code, e.message);
    assert.equal(readFileSync(s.L.pointer, 'utf8'), ptr, 'pointer unchanged');
    assert.ok(existsSync(join(s.L.release(a.id), '.complete')), 'current release intact');
    assert.deepEqual(readdirSync(s.L.releases), [a.id], 'no new release, no staging left');
    assert.equal(existsSync(s.L.lock), false, 'lock released');
    const jobs = readdirSync(s.L.jobs).filter((n) => n.endsWith('.json')).sort();
    const job = JSON.parse(readFileSync(join(s.L.jobs, jobs.at(-1)), 'utf8'));
    assert.equal(job.phase, 'failed');
    assert.equal(job.steps.find((x) => x.status === 'failed').key, code === 'image-build' ? 'images' : code);
    assert.equal(job.steps.find((x) => x.key === 'complete').status, 'done', 'the job acknowledged its end');
  }
  assert.match(s.fake.calls(), /ERR_PNPM|docker/);
});

test('base check: images whose Node is older than engines.node are refused before any build container', async () => {
  const s = setup();
  const e = await err(s.go({}, { FAKE_NODE: 'v22.22.3' }));
  assert.equal(e.code, 'base-check');
  assert.match(e.message, /aura-base:[0-9a-f]+ has Node v22\.22\.3, but this release requires >=22\.23\.4/);
  assert.doesNotMatch(s.fake.calls(), /os\/release\/build\.sh/);
});

test('provenance: main is upstream-unsigned and never a security update; a system patch series is refused in Phase 6', async () => {
  const s = setup();
  const r = await s.go({ channel: 'main', trust: undefined });
  assert.equal(r.release.provenance, 'upstream-unsigned');
  assert.deepEqual(r.release.meta, { signed: false, metaDigest: null, securityUpdate: false });
  assert.equal(r.release.channel, 'main');
  assert.match(r.id, /^main-[0-9a-f]{12}-[0-9a-f]{8}$/);
  const signed = await s.go();
  assert.equal(signed.release.provenance, 'upstream-signed');
  assert.notEqual(signed.id, r.id);
  // A different composition is a different release of the same commit.
  const server = await s.go({ composition: 'server' });
  assert.equal(server.release.composition, 'server');
  assert.notEqual(server.id, signed.id);
  // The same inputs again: reused, not rebuilt.
  const again = await s.go({ composition: 'server' });
  assert.equal(again.reused, true);
  assert.equal(again.id, server.id);
  // Phase 7's series input and the series file are refused (nothing would apply them).
  const e1 = await err(s.go({ series: { base: null, order: [{ file: '0001.patch', sha256: 'x' }] } }));
  assert.equal(e1.code, 'series-unsupported');
  mkdirSync(join(s.data, 'patches/system'), { recursive: true });
  writeFileSync(s.L.series, 'patches: []\n');
  const e2 = await err(s.go());
  assert.equal(e2.code, 'series-unsupported');
  assert.match(e2.message, /Phase 7 \(D68\)/);
});

test('GC keeps current and previous (and the new release); other releases and stale staging go', async () => {
  const s = setup();
  for (const id of ['old-1', 'cur-1', 'prev-1']) {
    mkdirSync(join(s.L.releases, id), { recursive: true });
    writeFileSync(join(s.L.releases, id, '.complete'), 'x\n');
    writeFileSync(join(s.L.releases, id, 'release.json'), JSON.stringify({ images: { shell: `aura-shell:${id}`, base: 'aura-base:shared' } }));
  }
  mkdirSync(join(s.L.releases, '.staging-2026-01-01T00-00-00-000Z'), { recursive: true });
  mkdirSync(join(s.data, 'aura/release'), { recursive: true });
  writeFileSync(s.L.pointer, JSON.stringify({ v: 1, current: 'cur-1', previous: 'prev-1' }));
  const r = await s.go();
  assert.deepEqual(readdirSync(s.L.releases).sort(), [r.id, 'cur-1', 'prev-1'].sort());
  assert.match(s.fake.calls(), /docker image rm aura-shell:old-1/);
  assert.doesNotMatch(s.fake.calls(), /image rm aura-base:shared/, 'an image a kept release uses stays');
  const st = B.status(s.data);
  assert.equal(st.pointer.current, 'cur-1');
  assert.equal(st.lock.held, false);
});

const GC = await import(join(ROOT, 'os/release/gc.mjs'));

/** A fake complete release `id` with its images. */
function fakeRelease(L, id, shell = `aura-shell:${id}`) {
  mkdirSync(join(L.releases, id), { recursive: true });
  writeFileSync(join(L.releases, id, '.complete'), 'x\n');
  writeFileSync(join(L.releases, id, 'release.json'), JSON.stringify({ images: { shell, base: 'aura-base:shared' } }));
}
function fakeSnapshot(L, name, rec) {
  mkdirSync(join(L.snapshots, name, 'kv'), { recursive: true });
  writeFileSync(join(L.snapshots, name, 'kv', 'dump.rdb'), 'x');
  if (rec) writeFileSync(join(L.snapshots, name, 'snapshot.json'), JSON.stringify({ v: 1, id: name, ...rec }));
}

test('GC keeps the snapshot of the switch previous -> current; snapshots of removed releases go; one without a record is left to U', async () => {
  const s = setup();
  for (const id of ['old-1', 'prev-1', 'cur-1']) fakeRelease(s.L, id);
  mkdirSync(dirname(s.L.pointer), { recursive: true });
  writeFileSync(s.L.pointer, JSON.stringify({ v: 1, current: 'cur-1', previous: 'prev-1' }));
  fakeSnapshot(s.L, 'old-1-1', { fromRelease: 'old-1', toRelease: 'prev-1' });
  fakeSnapshot(s.L, 'prev-1-2', { fromRelease: 'prev-1', toRelease: 'cur-1' });
  fakeSnapshot(s.L, 'cur-1-3', { fromRelease: 'cur-1', toRelease: 'gone-1' });
  fakeSnapshot(s.L, 'cur-1-4', null);
  const g = await withEnv(s.fake.env, () => GC.gc({ dataRoot: s.data, pruneStore: 'never' }));
  assert.deepEqual(g.removed, ['old-1']);
  assert.deepEqual(g.snapshots, { removed: ['cur-1-3', 'old-1-1'], kept: ['prev-1-2'], unknown: ['cur-1-4'] });
  assert.deepEqual(readdirSync(s.L.snapshots).sort(), ['cur-1-4', 'prev-1-2']);
  assert.deepEqual(g.store, { pruned: false, detail: 'skipped' });
});

test('GC: the pnpm store is pruned monthly, after the releases go, in a throwaway container of the current shell image (store only, offline)', async () => {
  const s = setup();
  fakeRelease(s.L, 'cur-1', 'aura-shell:cur');
  fakeRelease(s.L, 'old-1');
  mkdirSync(dirname(s.L.pointer), { recursive: true });
  writeFileSync(s.L.pointer, JSON.stringify({ v: 1, current: 'cur-1', previous: null }));
  mkdirSync(s.L.pnpmStore, { recursive: true });
  const stamp = join(s.L.pnpmStore, GC.STORE_PRUNE_STAMP);
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  const go = (o) => withEnv(s.fake.env, () => GC.gc({ dataRoot: s.data, dataVolume: 'test_aura-app-data', dataSubpath: 'sub', activeJob: '2026-11-01T00-00-00-000Z', ...o }));
  // First GC: the clock starts, nothing is pruned.
  let g = await go({ now: t0 });
  assert.match(g.store.detail, /first GC/);
  assert.equal(JSON.parse(readFileSync(stamp, 'utf8')).at, '2026-11-01T00:00:00.000Z');
  assert.doesNotMatch(s.fake.calls(), /store prune/);
  // Not due yet.
  g = await go({ now: t0 + GC.STORE_PRUNE_INTERVAL_MS - 1 });
  assert.match(g.store.detail, /not due/);
  assert.doesNotMatch(s.fake.calls(), /store prune/);
  // Due: pruned with the current release's shell image, after the release removal.
  fakeRelease(s.L, 'old-2');
  g = await go({ now: t0 + GC.STORE_PRUNE_INTERVAL_MS });
  assert.equal(g.store.pruned, true);
  assert.deepEqual(g.removed, ['old-2']);
  const calls = s.fake.calls().split('\n');
  const prune = calls.find((l) => / store prune /.test(l));
  assert.match(prune, /^docker run --rm --name aura-release-prune-2026-11-01t00-00-00-000z --network none /);
  assert.match(prune, /--cap-drop ALL .*--security-opt no-new-privileges/);
  assert.match(prune, /--mount type=volume,source=test_aura-app-data,target=\/pnpm-store,volume-subpath=sub\/aura\/pnpm-store -e HOME=\/tmp /);
  assert.equal((prune.match(/--mount/g) ?? []).length, 1, 'the store only: no staging, no socket, no home');
  assert.match(prune, /--entrypoint pnpm aura-shell:cur store prune --store-dir \/pnpm-store$/);
  assert.ok(calls.indexOf(prune) > calls.findIndex((l) => /image rm aura-shell:old-2/.test(l)), 'after the releases (and their images) are gone');
  assert.equal(JSON.parse(readFileSync(stamp, 'utf8')).at, new Date(t0 + GC.STORE_PRUNE_INTERVAL_MS).toISOString());
  // `now` forces it; `never` skips it; a failed prune keeps the old record and does not fail the GC.
  const before = readFileSync(stamp, 'utf8');
  g = await go({ pruneStore: 'now', now: t0 + GC.STORE_PRUNE_INTERVAL_MS + 5 });
  assert.equal(g.store.pruned, true);
  assert.equal((await go({ pruneStore: 'never' })).store.detail, 'skipped');
  writeFileSync(join(s.fake.bin, 'docker'), '#!/bin/sh\necho "ERR_PNPM_STORE broken" >&2\nexit 1\n');
  const failed = readFileSync(stamp, 'utf8');
  g = await go({ pruneStore: 'now' });
  assert.equal(g.store.pruned, false);
  assert.match(g.store.detail, /pnpm store prune failed \(exit 1\): ERR_PNPM_STORE broken/);
  assert.equal(readFileSync(stamp, 'utf8'), failed);
  assert.notEqual(before, '');
  await assert.rejects(go({ pruneStore: 'weekly' }), /pruneStore must be one of auto\|now\|never/);
});

test('gc CLI --held-by: runs under the caller\'s activation lock (stream U\'s switch job) and leaves it held; refused when that job does not hold it', () => {
  const s = setup();
  fakeRelease(s.L, 'old-1');
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'os/release/builder.mjs'), 'gc', '--data-root', s.data, ...args],
    { env: { ...process.env, ...s.fake.env }, encoding: 'utf8' });
  let r = cli('--held-by', '2026-02-02T00-00-00-000Z', '--prune-store', 'never');
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).code, 'activation-busy');
  assert.match(JSON.parse(r.stdout).error, /the activation lock is not held/);
  assert.ok(existsSync(join(s.L.releases, 'old-1')), 'nothing removed');
  const held = LOCK.acquireLock(s.L.lock, { jobId: '2026-02-02T00-00-00-000Z', by: 'system.release.activate', autoHeartbeat: false });
  r = cli('--held-by', '2026-02-03T00-00-00-000Z');
  assert.equal(r.status, 3);
  assert.match(JSON.parse(r.stdout).error, /held by 2026-02-02T00-00-00-000Z/);
  r = cli('--held-by', '2026-02-02T00-00-00-000Z', '--prune-store', 'never');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).removed, ['old-1']);
  assert.equal(held.owned(), true, 'the lock stays the caller\'s');
  held.release();
  assert.equal(cli('--prune-store', 'weekly').status, 64);
});

test('IC-5 call site: without --infra inputs the build asks the propagation API; a rendered config before IC-5 is refused before any fetch', async () => {
  const s = setup();
  const r = await s.go();
  assert.equal(r.release.infraDigest, null, 'no config = today');
  const s2 = setup();
  const hex = 'c'.repeat(64);
  mkdirSync(join(s2.data, 'aura/infra/generated', hex), { recursive: true });
  symlinkSync(hex, join(s2.data, 'aura/infra/generated/current'));
  const e = await err(s2.go());
  assert.equal(e.code, 'infra-not-propagated');
  assert.equal(e.exit, 3);
  assert.equal(e.step, 'source');
  assert.equal(existsSync(s2.L.mirror), false, 'refused before the mirror fetch');
  assert.equal(s2.fake.calls(), '', 'nothing ran');
  // Explicit inputs (install.sh's --infra) are the caller's: the propagation API is not asked.
  assert.equal((await s2.go({ infra: { digest: 'sha256:given' } })).release.infraDigest, 'sha256:given');
});

test('D94: configured build secrets refuse the legacy (non-BuildKit) builder; secrets are mounts, never args', async () => {
  const s = setup();
  const sec = join(tmp(), 'infra_npmrc');
  writeFileSync(sec, '//r.example/:_auth=CANARYSECRET\n', { mode: 0o600 });
  const infra = { digest: 'sha256:abc', buildArgs: { HTTPS_PROXY: 'http://proxy.example:3128' }, env: { HTTPS_PROXY: 'http://proxy.example:3128' }, secrets: { infra_npmrc: sec } };
  const e = await err(s.go({ infra }, { FAKE_NO_BUILDX: '1' }));
  assert.equal(e.code, 'legacy-builder');
  const r = await s.go({ infra }, { FAKE_OFFLINE_RC: '1' });
  assert.equal(r.release.infraDigest, 'sha256:abc');
  const calls = s.fake.calls();
  assert.match(calls, new RegExp(`--secret id=infra_npmrc,src=${sec}`));
  assert.match(calls, /--build-arg HTTPS_PROXY=http:\/\/proxy\.example:3128/);
  assert.doesNotMatch(calls, /CANARYSECRET/);
  const deps = calls.split('\n').find((l) => / deps$/.test(l));
  assert.match(deps, /target=\/run\/aura-build,volume-subpath=aura\/release\/jobs\/[^,]+\.d\/secrets,readonly/);
  assert.match(deps, /-e NPM_CONFIG_USERCONFIG=\/run\/aura-build\/npmrc/);
  assert.equal(existsSync(s.L.jobFiles(r.job)), false, 'the per-job secret copy is gone after the run');
});

test('image fingerprint: only the inputs of the target and its stages count', () => {
  const key = throwawayKey();
  const src = auraSource(key);
  const fp = (t) => IMG.imageFingerprint(src.dir, t).fingerprint;
  const base1 = fp('aura-base'), dev1 = fp('development');
  assert.deepEqual(IMG.imageFingerprint(src.dir, 'development').inputs, ['os/base', 'os/boot.sh', 'os/toolchain-path.sh']);
  write(src.dir, 'packages/core/package.json', '{"name":"@aura/core","x":1}\n');
  assert.equal(fp('aura-base'), base1, 'a package change does not rebuild the base');
  assert.equal(fp('development'), dev1, 'deps is not reachable from development');
  write(src.dir, 'os/boot.sh', '#!/bin/sh\necho\n');
  assert.equal(fp('aura-base'), base1);
  assert.notEqual(fp('development'), dev1);
  write(src.dir, 'os/base/x', 'changed\n');
  assert.notEqual(fp('aura-base'), base1);
  assert.notEqual(IMG.imageFingerprint(src.dir, 'aura-base', { extra: 'sha256:other' }).fingerprint, fp('aura-base'), 'the D94 digest counts');
  assert.throws(() => IMG.imageFingerprint(src.dir, 'nope'), (e) => e.code === 'no-target');
  // The real Dockerfile parses, and its shell target copies no package sources.
  const real = IMG.parseDockerfile(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'));
  assert.ok(real.some((x) => x.name === 'aura-base') && real.some((x) => x.name === 'development'));
  assert.ok(IMG.contextInputs(real, 'development').every((p) => p.startsWith('os/')), IMG.contextInputs(real, 'development').join(' '));
});

test('engines.node ranges', () => {
  const ok = (v, r) => IMG.satisfiesNode(v, r);
  assert.ok(ok('v22.23.5', '>=22.23.4'));
  assert.ok(!ok('v22.22.3', '>=22.23.4'));
  assert.ok(ok('v22.23.5', '>=22'));
  assert.ok(ok('v22.1.0', '^22.0.0') && !ok('v23.0.0', '^22.0.0'));
  assert.ok(ok('v20.5.0', '>=18 <21 || 22.x') && ok('v22.9.1', '>=18 <21 || 22.x') && !ok('v21.0.0', '>=18 <21 || 22.x'));
  assert.ok(ok('v22.0.0', undefined));
  assert.ok(!ok('garbage', '>=22'));
});

test('one build path: boot.sh builds through os/build-packages.sh, and it lists the packages', () => {
  const boot = readFileSync(join(ROOT, 'os/boot.sh'), 'utf8');
  assert.match(boot, /BUILD_PACKAGES=\/workspace\/os\/build-packages\.sh/);
  assert.doesNotMatch(boot, /astro build --outDir/, 'the shell build lives in build-packages.sh only');
  const r = spawnSync('sh', [join(ROOT, 'os/build-packages.sh'), '--root', ROOT, '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['app-sdk', 'aura-cli', 'core', 'kv-store', 'shell', 'ui']);
  const sh = readFileSync(join(ROOT, 'os/release/build.sh'), 'utf8');
  assert.match(sh, /pnpm install --frozen-lockfile --store-dir \/pnpm-store/);
  assert.match(sh, /sh os\/build-packages\.sh --root \/workspace --shell dist-prod/);
  assert.match(sh, /node server\.mjs --check/);
});

test('layout: ids are never paths', () => {
  const L = LAYOUT.layout('/data');
  assert.equal(L.release('0.1.0-abc'), '/data/releases/0.1.0-abc');
  assert.throws(() => L.release('../x'));
  assert.throws(() => L.release('.staging-x'));
  assert.throws(() => L.staging('2026/../x'));
  assert.equal(LAYOUT.subpathOf('/data', '/data/releases/x'), 'releases/x');
  assert.throws(() => LAYOUT.subpathOf('/data', '/etc/x'));
});

test('dataSubpath: the build mounts stay under the data root\'s place in the volume', async () => {
  const s = setup();
  await s.go({ dataSubpath: 'e2e-scratch' });
  const run = s.fake.calls().split('\n').find((l) => / build$/.test(l));
  assert.match(run, /target=\/workspace,volume-subpath=e2e-scratch\/releases\/\.staging-/);
  assert.match(run, /target=\/pnpm-store,volume-subpath=e2e-scratch\/aura\/pnpm-store/);
  await assert.rejects(s.go({ dataSubpath: '../x' }), (e) => e.code === 'usage');
});

test('build-apps: build.release runs the app\'s declared argv (outputs checked), {} ships as is, raw apps without it are skipped, an invalid manifest fails', () => {
  const root = tmp('aura-buildapps-');
  // The staging tree's own core build: here, this worktree's packages/.
  spawnSync('ln', ['-s', join(ROOT, 'packages'), join(root, 'packages')]);
  const app = (id, manifest, files = {}) => {
    write(root, `apps/${id}/app.manifest.json`, JSON.stringify({ id, name: id, version: '1.0.0', ...manifest }));
    for (const [f, t] of Object.entries(files)) write(root, `apps/${id}/${f}`, t);
  };
  app('com.example.built', { runtime: 'raw', build: { release: { command: ['node', '-e', "require('fs').mkdirSync('out/x',{recursive:true})"], cwd: 'site', outputs: ['site/out/x'] } } }, { 'site/.keep': '', 'entrypoint.sh': '' });
  app('com.example.asis', { runtime: 'raw', build: { release: {} } }, { 'entrypoint.sh': '' });
  app('com.example.raw', { runtime: 'raw' }, { 'entrypoint.sh': '' });
  const run = () => spawnSync(process.execPath, [join(ROOT, 'os/release/build-apps.mjs'), root], { encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const apps = JSON.parse(r.stdout.trim().split('\n').pop()).apps;
  assert.deepEqual(apps.map((a) => [a.id, a.built, a.via ?? a.skipped]), [
    ['com.example.asis', true, 'build.release'], ['com.example.built', true, 'build.release'], ['com.example.raw', false, 'own-entrypoint'],
  ]);
  assert.ok(existsSync(join(root, 'apps/com.example.built/site/out/x')));
  app('com.example.noout', { runtime: 'raw', build: { release: { command: ['node', '-e', '0'], outputs: ['dist'] } } }, { 'entrypoint.sh': '' });
  app('com.example.escape', { runtime: 'raw', build: { release: { cwd: '../..' } } }, { 'entrypoint.sh': '' });
  r = run();
  assert.equal(r.status, 1);
  const bad = JSON.parse(r.stdout.trim().split('\n').pop()).apps.filter((a) => a.failed);
  assert.deepEqual(bad.map((a) => a.id), ['com.example.escape', 'com.example.noout']);
  assert.match(bad[0].error, /invalid manifest: build\.release\.cwd: must be a path inside the app dir/);
  assert.match(bad[1].error, /missing outputs: dist/);
});

test('the system apps declare their release builds (Docs, Registry; Console serves a build)', () => {
  const m = (id) => JSON.parse(readFileSync(join(ROOT, 'apps', id, 'app.manifest.json'), 'utf8'));
  assert.deepEqual(m('com.aura.docs').build.release, { command: ['node', 'serve.mjs', '--build-only'], cwd: 'fumadocs-site', outputs: ['fumadocs-site/.next'] });
  assert.deepEqual(m('com.aura.registry').build.release, {});
  assert.equal(m('com.aura.console').serve, 'auto');
  assert.ok(existsSync(join(ROOT, 'apps/com.aura.console/server.mjs')));
  const builder = readFileSync(join(ROOT, 'os/release/build-apps.mjs'), 'utf8');
  assert.doesNotMatch(builder, /com\.aura\./, 'no app-specific code in the builder');
});
