// Phase 6 stream U: the release activation (os/release/activate.mjs) and the
// kernel's reads of it (core release/activate.ts): the pointer switch and its
// crash points, the writes-held marker, the data snapshot and its restore
// (files, and a real Valkey when the image has one), re-verification before a
// release runs, the preflight rules (no silent downgrade, lock, held state),
// the security rule of a rollback, the health verdict and accept-writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { ROOT, V, git, makeRepo, release, throwawayKey, tmp, trustOf, write } from './release-fixtures.mjs';
import { RELEASE_LOCK_STALE_MS, latestSnapshotInto, readWritesHeld, systemLockHolder } from '../dist/release/activate.js';

const A = await import(join(ROOT, 'os/release/activate.mjs'));
const LOCK = await import(join(ROOT, 'os/release/lock.mjs'));
const LAYOUT = await import(join(ROOT, 'os/release/layout.mjs'));

const JOB1 = '2026-11-27T10-00-00-000Z';
const JOB2 = '2026-11-27T11-00-00-000Z';

const err = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected a refusal'); };
const aerr = async (p) => { try { await p; } catch (e) { return e; } assert.fail('expected a refusal'); };

/** A finished release written by hand: files, release.json with its treeDigest, `.complete`. */
function putRelease(data, id, { files = { 'package.json': '{"name":"aura"}\n' }, record = {} } = {}) {
  const dir = LAYOUT.layout(data).release(id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  const rec = {
    v: 1, id, version: record.version ?? null, commit: 'c'.repeat(40), gitTree: 't'.repeat(40), channel: 'main', maturity: null,
    meta: { signed: false, metaDigest: null, securityUpdate: false }, provenance: 'upstream-unsigned',
    series: { digest: 'sha256:0', base: null, order: [] }, composition: 'desktop',
    components: { source: [], built: [], deployed: [], skipped: [] }, images: { shell: `aura-shell:${id}`, base: 'aura-base:x', target: 'release' },
    node: { required: null, base: 'v22', shell: 'v22' }, lockfileHash: null, infraDigest: null, auraContract: 1, ari: 1,
    builtAt: '2026-11-27T00:00:00.000Z', builderJob: JOB1,
    treeDigest: `sha256:${V.gitTreeOfDir(dir, { algo: 'sha256', skip: ['release.json', '.complete'] })}`,
    ...record,
  };
  writeFileSync(join(dir, 'release.json'), JSON.stringify(rec, null, 2));
  writeFileSync(join(dir, '.complete'), `${JOB1}\n`);
  return rec;
}

function install(opts = {}) {
  const data = tmp('aura-act-');
  const a = putRelease(data, 'main-aaaaaaaaaaaa-11111111', opts.a);
  const b = putRelease(data, 'main-bbbbbbbbbbbb-22222222', opts.b);
  const L = LAYOUT.layout(data);
  mkdirSync(join(data, 'aura/release'), { recursive: true });
  writeFileSync(L.pointer, JSON.stringify({ v: 1, current: a.id, previous: null, switchedAt: '2026-11-27T00:00:00.000Z', jobId: JOB1 }));
  write(data, 'kv/dump.rdb', 'REDIS0011 original');
  write(data, 'kv/appendonlydir/appendonly.aof.1.incr.aof', 'SET a 1\n');
  return { data, a, b, L };
}

test('the TS reads match the .mjs side: the lock stale time, the marker and the snapshot of a switch', () => {
  assert.equal(RELEASE_LOCK_STALE_MS, LOCK.STALE_MS);
  const { data, a, b, L } = install();
  assert.equal(readWritesHeld(data), null);
  A.holdWrites(data, { jobId: JOB2, from: a.id, to: b.id, snapshot: null });
  assert.equal(readWritesHeld(data).to, b.id);
  writeFileSync(L.writesHeld, '{not json');
  assert.equal(readWritesHeld(data).unreadable, true, 'an unreadable marker still holds (fails closed)');
  // the lock: a fresh heartbeat holds, a silent one is gone
  writeFileSync(L.lock, JSON.stringify({ jobId: JOB2, pid: 1, host: 'updater', start: null, at: Date.now(), heartbeatAt: Date.now() }));
  assert.equal(systemLockHolder(data)?.jobId, JOB2);
  assert.equal(systemLockHolder(data, Date.now() + LOCK.STALE_MS + 1), null);
  // the snapshot of the switch INTO b, by that job only
  const s = A.snapshot(data, { from: a.id, to: b.id, jobId: JOB2 });
  assert.equal(latestSnapshotInto(data, b.id, JOB2), s.id);
  assert.equal(latestSnapshotInto(data, b.id, JOB1), null, 'a snapshot of another switch is never restored');
  assert.equal(latestSnapshotInto(data, a.id), null);
});

test('switch: the hold first, then the pointer; revert clears previous, so a second rollback has no target', () => {
  const { data, a, b, L } = install();
  const p = A.switchTo(data, { to: b.id, jobId: JOB2, snapshot: 'x' });
  assert.deepEqual([p.current, p.previous, p.jobId], [b.id, a.id, JOB2]);
  assert.equal(A.readWritesHeld(data).jobId, JOB2);
  assert.equal(err(() => A.switchTo(data, { to: b.id, jobId: JOB2 })).code, 'already-current');
  const r = A.revert(data, { jobId: JOB2 });
  assert.deepEqual([r.current, r.previous], [a.id, null]);
  assert.equal(err(() => A.revert(data, { jobId: JOB2 })).code, 'no-previous');
  assert.equal(err(() => A.rollbackTarget(data)).code, 'no-previous');
  // ids are never paths
  assert.throws(() => A.switchTo(data, { to: '../x', jobId: JOB2 }));
  assert.throws(() => A.switchTo(data, { to: b.id, jobId: '../../x' }));
  // an incomplete target is refused
  rmSync(join(L.release(b.id), '.complete'), { force: true });
  writeFileSync(L.pointer, JSON.stringify({ v: 1, current: a.id, previous: null, switchedAt: 'x', jobId: JOB1 }));
  assert.equal(err(() => A.switchTo(data, { to: b.id, jobId: JOB2 })).code, 'incomplete');
});

test('crash points: the pointer is old or new, never half; a hold without a job is visible', () => {
  const { data, a, b, L } = install();
  // Crash after the hold, before the pointer: the old release is current and held.
  A.holdWrites(data, { jobId: JOB2, from: a.id, to: b.id });
  assert.equal(A.readPointer(data).current, a.id);
  assert.equal(A.status(data).writesHeld.jobId, JOB2);
  // The pointer is written by temp + rename: no temp file is left, the file parses.
  A.releaseHold(data);
  A.switchTo(data, { to: b.id, jobId: JOB2 });
  assert.deepEqual(readdirSync(join(data, 'aura/release')).filter((n) => n.includes('.tmp')), []);
  assert.equal(JSON.parse(readFileSync(L.pointer, 'utf8')).current, b.id);
});

test('snapshot and restore: complete or absent, hashed, the replaced data kept aside, a corrupt snapshot refused', () => {
  const { data, a, b } = install({ b: { record: { migrations: [{ id: 'm1', paths: ['apps/x/db'] }] } } });
  write(data, 'apps/x/db/state.json', '{"v":1}');
  const s = A.snapshot(data, { from: a.id, to: b.id, jobId: JOB2 });
  assert.ok(s.files.some((f) => f.path === 'kv/dump.rdb'));
  assert.ok(s.files.some((f) => f.path === 'apps/x/db/state.json'), 'a declared migration path is snapshotted');
  assert.equal(s.fromRelease, a.id);
  assert.equal(existsSync(join(data, 'aura/release/snapshots', `${s.id}.tmp`)), false);
  // The new release writes a marker key and migrates.
  write(data, 'kv/dump.rdb', 'REDIS0011 with marker');
  write(data, 'apps/x/db/state.json', '{"v":2}');
  const r = A.restore(data, { snapshot: s.id });
  assert.equal(readFileSync(join(data, 'kv/dump.rdb'), 'utf8'), 'REDIS0011 original');
  assert.equal(readFileSync(join(data, 'apps/x/db/state.json'), 'utf8'), '{"v":1}');
  assert.equal(readFileSync(join(data, r.replacedKeptAt, 'kv/dump.rdb'), 'utf8'), 'REDIS0011 with marker', 'nothing is deleted');
  // tamper with the snapshot
  write(join(data, 'aura/release/snapshots', s.id), 'data/kv/dump.rdb', 'evil');
  assert.equal(err(() => A.restore(data, { snapshot: s.id })).code, 'snapshot-corrupt');
  assert.equal(err(() => A.restore(data, { snapshot: '../../x' })).code, 'bad-snapshot');
  // the release layout is never a snapshot path
  assert.equal(err(() => A.snapshot(data, { from: a.id, to: b.id, jobId: JOB2, paths: ['aura/release'] })).code, 'bad-path');
  assert.equal(err(() => A.snapshot(data, { from: a.id, to: b.id, jobId: JOB2, paths: ['../etc'] })).code, 'bad-path');
});

test('a path a migration creates is removed again by the restore (kept aside)', () => {
  const { data, a, b } = install({ b: { record: { migrations: [{ id: 'm1', paths: ['apps/new'] }] } } });
  const s = A.snapshot(data, { from: a.id, to: b.id, jobId: JOB2 });
  write(data, 'apps/new/created.json', '{}');
  A.restore(data, { snapshot: s.id });
  assert.equal(existsSync(join(data, 'apps/new')), false);
});

const valkey = spawnSync('sh', ['-c', 'command -v valkey-server && command -v valkey-cli'], { encoding: 'utf8' });
test('snapshot/restore round trip on a real Valkey (the marker key is gone after the restore)', { skip: valkey.status !== 0 && 'no valkey-server in this image' }, async () => {
  const { data, a, b } = install();
  rmSync(join(data, 'kv'), { recursive: true, force: true });
  mkdirSync(join(data, 'kv'), { recursive: true });
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const cli = (...args) => spawnSync('valkey-cli', ['-p', port, ...args], { encoding: 'utf8' }).stdout.trim();
  const start = async () => {
    const p = spawn('valkey-server', ['--port', port, '--dir', join(data, 'kv'), '--appendonly', 'yes', '--save', ''], { stdio: 'ignore' });
    for (let i = 0; i < 100 && cli('PING') !== 'PONG'; i++) await new Promise((r) => setTimeout(r, 50));
    return p;
  };
  const stop = async (p) => { cli('SHUTDOWN', 'SAVE'); await new Promise((r) => p.once('exit', r)); };
  let p = await start();
  cli('SET', 'user:data', 'before');
  await stop(p);
  const s = A.snapshot(data, { from: a.id, to: b.id, jobId: JOB2 });
  p = await start();
  cli('SET', 'release:marker', 'B was here');
  assert.equal(cli('GET', 'release:marker'), 'B was here');
  await stop(p);
  A.restore(data, { snapshot: s.id });
  p = await start();
  try {
    assert.equal(cli('GET', 'release:marker'), '', 'the marker key is absent after the restore');
    assert.equal(cli('GET', 'user:data'), 'before');
  } finally { await stop(p); }
});

test('verify: a release changed after it was built is refused; a signed release verifies with the CURRENT trust only', () => {
  const key = throwawayKey();
  const repo = makeRepo([key]);
  const rel = release(repo, '0.2.0', key);
  const { data, a } = install();
  const L = LAYOUT.layout(data);
  git(repo, 'clone', '-q', '--bare', repo, L.mirror);
  const metaBytes = readFileSync(rel.metaFile);
  const signed = putRelease(data, '0.2.0-cccccccccccc-33333333', {
    record: {
      version: '0.2.0', commit: rel.commit, gitTree: git(repo, 'rev-parse', `${rel.commit}^{tree}`), channel: 'signed', maturity: 'alpha',
      provenance: 'upstream-signed', meta: { signed: true, keyId: key.keyId, metaDigest: V.metaDigest(metaBytes), securityUpdate: false },
    },
  });
  assert.equal(A.verifyRelease(data, signed.id, { trust: trustOf(key) }).meta.version, '0.2.0');
  assert.equal(err(() => A.verifyRelease(data, signed.id, { trust: trustOf(throwawayKey()) })).code, 'verify-untrusted-key');
  // the trusted tree's keys (the running release) plus the operator's
  const trustedTree = tmp('aura-trusted-');
  write(trustedTree, `os/release-keys/${key.keyId}.pub`, key.pem);
  assert.equal(A.verifyRelease(data, signed.id, { trustedTree }).record.id, signed.id);
  // a revoked key in the operator's record wins
  write(data, 'aura/release/trusted-keys/revoked.txt', `${key.keyId}\n`);
  assert.equal(err(() => A.verifyRelease(data, signed.id, { trustedTree })).code, 'verify-revoked-key');
  // a tampered file
  const f = join(L.release(a.id), 'package.json');
  chmodSync(f, 0o644);
  writeFileSync(f, '{"name":"evil"}\n');
  assert.equal(err(() => A.verifyRelease(data, a.id, {})).code, 'tree-digest-mismatch');
});

test('preflight: no silent downgrade, the lock, a held state, already current; the binding is the release', () => {
  const { data, a, b, L } = install();
  let p = A.preflight(data, { id: b.id, channel: 'signed', measureDisk: false });
  assert.deepEqual(p.blockers.map((x) => x.code), ['channel-downgrade'], 'a signed install never activates a main release');
  p = A.preflight(data, { id: b.id, channel: 'main', measureDisk: false });
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.binding, {
    releaseId: b.id, commit: b.commit, treeDigest: b.treeDigest, metaDigest: null, provenance: 'upstream-unsigned',
    composition: 'desktop', series: { digest: 'sha256:0', base: null, order: [] }, infraDigest: null,
  });
  assert.ok(A.sameBinding(p.binding, A.bindingOf(b)));
  assert.equal(A.preflight(data, { id: a.id, channel: 'main', measureDisk: false }).blockers[0].code, 'already-current');
  const lock = LOCK.acquireLock(L.lock, { jobId: JOB2, autoHeartbeat: false });
  assert.ok(A.preflight(data, { id: b.id, channel: 'main', measureDisk: false }).blockers.some((x) => x.code === 'activation-busy'));
  lock.release();
  A.holdWrites(data, { jobId: JOB2, from: a.id, to: b.id });
  assert.ok(A.preflight(data, { id: b.id, channel: 'main', measureDisk: false }).blockers.some((x) => x.code === 'writes-held'));
});

test('rollback security: never past a resolved critical fix; a non-critical one only confirmed by its advisories', () => {
  const sec = (severity) => ({ version: '0.3.0', channel: 'signed', provenance: 'upstream-signed', meta: { signed: true, metaDigest: 'sha256:x', securityUpdate: true, severity, advisories: ['AURA-2026-007'] } });
  for (const [severity, expect] of [['critical', 'critical'], ['high', 'confirm']]) {
    const data = tmp('aura-act-sec-');
    const old = putRelease(data, '0.2.0-aaaaaaaaaaaa-11111111', { record: { version: '0.2.0', channel: 'signed', provenance: 'upstream-signed', meta: { signed: true, metaDigest: 'sha256:y', securityUpdate: false } } });
    const fix = putRelease(data, '0.3.0-bbbbbbbbbbbb-22222222', { record: sec(severity) });
    mkdirSync(join(data, 'aura/release'), { recursive: true });
    writeFileSync(LAYOUT.layout(data).pointer, JSON.stringify({ v: 1, current: fix.id, previous: old.id, switchedAt: 'x', jobId: JOB2 }));
    const t = A.rollbackTarget(data);
    const r = A.rollbackSecurity(data, t);
    assert.equal(r.allowed, false);
    if (expect === 'critical') {
      assert.equal(r.critical, true);
      assert.equal(A.rollbackSecurity(data, { ...t, confirmInsecure: 'AURA-2026-007' }).allowed, false, 'no confirmation unlocks a critical rollback');
    } else {
      assert.equal(r.needsConfirmation, true);
      assert.deepEqual(r.advisories, ['AURA-2026-007']);
      assert.equal(A.rollbackSecurity(data, { ...t, confirmInsecure: 'AURA-2026-001' }).allowed, false, 'the advisory must be named');
      assert.equal(A.rollbackSecurity(data, { ...t, confirmInsecure: 'AURA-2026-007' }).allowed, true);
    }
  }
  // an unsigned securityUpdate claim (main) never counts
  const { data, a, b } = install({ b: { record: { meta: { signed: false, metaDigest: null, securityUpdate: true, severity: 'critical' } } } });
  writeFileSync(LAYOUT.layout(data).pointer, JSON.stringify({ v: 1, current: b.id, previous: a.id, switchedAt: 'x', jobId: JOB2 }));
  assert.equal(A.rollbackSecurity(data, A.rollbackTarget(data)).allowed, true);
});

test('health: a boot after the switch, kernel ready, every service resumed; a boot error fails at once', () => {
  const { data } = install();
  const since = '2026-11-27T12:00:00.000Z';
  const st = (o) => write(data, 'aura/boot/status.json', JSON.stringify({ startedAt: '2026-11-27T12:00:01.000Z', kernelReadyAt: '2026-11-27T12:00:05.000Z', services: {}, acceptingWrites: false, ...o }));
  assert.deepEqual(A.health(data, { since }).waiting, ['status.json']);
  st({ startedAt: '2026-11-27T11:59:00.000Z' });
  assert.equal(A.health(data, { since }).ok, false, 'the previous boot does not count');
  st({ kernelReadyAt: null });
  assert.deepEqual(A.health(data, { since }).waiting, ['kernel']);
  st({ services: { 'io.e2e.svc': { state: 'started' } } });
  assert.deepEqual(A.health(data, { since }).waiting, ['io.e2e.svc (started)'], 'the reason names the service');
  st({ services: { 'io.e2e.svc': { state: 'resumed', readyAt: 'x' } } });
  assert.equal(A.health(data, { since }).ok, true);
  st({ error: 'migration threw' });
  assert.match(A.health(data, { since }).failed, /migration threw/);
});

test('accept: the operator call; the marker alone only when the API is unreachable; a refusal is never overridden', async () => {
  const { data, a, b } = install();
  A.holdWrites(data, { jobId: JOB2, from: a.id, to: b.id });
  const calls = [];
  const okFetch = async (url, init) => { calls.push({ url, init }); A.releaseHold(data); return new Response('{}', { status: 200 }); };
  assert.equal((await A.accept(data, { jobId: JOB2, ticket: async () => 'CODE', fetchImpl: okFetch })).via, 'api');
  assert.equal(calls[0].init.headers['x-aura-operator'], 'CODE');
  assert.match(calls[0].url, /\/api\/admin\/release\/accept-writes$/);
  A.holdWrites(data, { jobId: JOB2, from: a.id, to: b.id });
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await A.accept(data, { jobId: JOB2, ticket: async () => 'CODE', fetchImpl: down })).via, 'marker');
  assert.equal(A.readWritesHeld(data), null);
  A.holdWrites(data, { jobId: JOB2, from: a.id, to: b.id });
  const refused = async () => new Response('{"error":"not-this-job"}', { status: 409 });
  assert.equal((await aerr(A.accept(data, { jobId: JOB2, ticket: async () => 'CODE', fetchImpl: refused }))).code, 'accept-refused');
  assert.ok(A.readWritesHeld(data), 'still held');
  assert.equal((await aerr(A.accept(data, { jobId: JOB1, ticket: async () => 'CODE', fetchImpl: okFetch }))).code, 'not-this-job');
});

test('changed apps: a system app whose source tree differs (or is new) between two releases', () => {
  const rec = (apps) => ({ components: { source: Object.entries(apps).map(([name, tree]) => ({ name, kind: 'app', path: `apps/${name}`, tree })) } });
  assert.deepEqual(A.changedApps(rec({ 'com.aura.settings': 't1', 'com.aura.docs': 'd1' }), rec({ 'com.aura.settings': 't2', 'com.aura.docs': 'd1', 'com.aura.new': 'n' })),
    ['com.aura.settings', 'com.aura.new']);
});

test('hold-lock: one job holds the system lock; a second is refused with the holder named', async () => {
  const { data, L } = install();
  const p = spawn(process.execPath, [join(ROOT, 'os/release/activate.mjs'), 'hold-lock', '--data', data, '--job', JOB1], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('"ok": true'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /"ok": true/);
  assert.equal(JSON.parse(readFileSync(L.lock, 'utf8')).host, hostname());
  const second = spawnSync(process.execPath, [join(ROOT, 'os/release/activate.mjs'), 'hold-lock', '--data', data, '--job', JOB2], { encoding: 'utf8' });
  assert.equal(second.status, 3);
  assert.match(second.stdout, /activation-busy/);
  p.kill('SIGTERM');
  await new Promise((r) => p.once('exit', r));
  assert.equal(existsSync(L.lock), false, 'released on SIGTERM');
});
