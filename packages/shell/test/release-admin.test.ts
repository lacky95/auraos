// Phase 6 stream U: the release write gate (lib/release/writeGate.ts) and the
// release routes (lib/release/releaseAdmin.ts) with fake dependencies over the
// real os/release/activate.mjs and a temp data root.
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import { isHeldWrite, resetWriteGate, writeGate, RELEASE_VERIFYING } from '../src/lib/release/writeGate.ts';
import {
  postAcceptWrites, postActivate, postRollback, releaseActivator, getStatus,
  type ActivationModule, type ReleaseAdminDeps,
} from '../src/lib/release/releaseAdmin.ts';
import type { AdminRequest, OwnerActor } from '../src/lib/approvals/admin.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
const A = await import(join(ROOT, 'os/release/activate.mjs')) as ActivationModule & Record<string, (...a: any[]) => any>;
const V = await import(join(ROOT, 'os/release-verify.mjs')) as { gitTreeOfDir(d: string, o: unknown): string };
const JOB = '2026-11-27T12-00-00-000Z';
const AID = 'main-aaaaaaaaaaaa-11111111';
const BID = 'main-bbbbbbbbbbbb-22222222';

// ── the write gate ──────────────────────────────────────────────────────────

test('write gate: mutating calls answer 503 release-verifying while held; reads, login, approvals and the release routes pass', async () => {
  for (const [m, p] of [['GET', '/api/kv/os/x'], ['POST', '/api/auth/login'], ['POST', '/api/approvals/apr_1/decide'], ['POST', '/api/admin/release/accept-writes'], ['POST', '/api/os/clients']] as const) {
    assert.equal(isHeldWrite(m, p), false, `${m} ${p}`);
  }
  for (const [m, p] of [['PUT', '/api/kv/app/x'], ['POST', '/api/apps/x/start'], ['DELETE', '/api/notifications/1'], ['PATCH', '/api/os/theme']] as const) {
    assert.equal(isHeldWrite(m, p), true, `${m} ${p}`);
  }
  let accepting = false;
  let marker = true;
  let t = 0;
  const deps = {
    system: () => ({ status: () => ({ acceptingWrites: accepting }) as never, acceptWrites: () => { accepting = true; } }),
    markerExists: () => marker,
    now: () => t,
  };
  resetWriteGate();
  const r = writeGate('PUT', '/api/kv/app/x', deps);
  assert.equal(r?.status, 503);
  assert.equal((await r!.json() as { error: string }).error, RELEASE_VERIFYING);
  assert.equal(writeGate('GET', '/api/kv/app/x', deps), null);
  // The marker removed (the accept-writes route, or the updater's fallback): the gate opens and tells the kernel.
  marker = false;
  t += 5_000;
  assert.equal(writeGate('PUT', '/api/kv/app/x', deps), null);
  assert.equal(accepting, true);
  assert.equal(writeGate('PUT', '/api/kv/app/x', { ...deps, system: () => null }), null, 'no kernel (tests, early boot): no gate');
});

// ── the routes ──────────────────────────────────────────────────────────────

function putRelease(data: string, id: string, record: Record<string, unknown> = {}): void {
  const dir = join(data, 'releases', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `{"id":"${id}"}\n`);
  const treeDigest = `sha256:${V.gitTreeOfDir(dir, { algo: 'sha256', skip: ['release.json', '.complete'] })}`;
  writeFileSync(join(dir, 'release.json'), JSON.stringify({
    v: 1, id, version: null, commit: 'c'.repeat(40), gitTree: 't'.repeat(40), channel: 'main', maturity: null,
    meta: { signed: false, metaDigest: null, securityUpdate: false }, provenance: 'upstream-unsigned',
    series: { digest: 'sha256:0', base: null, order: [] }, composition: 'desktop', components: { source: [] },
    images: { shell: 'aura-shell:x' }, auraContract: 1, infraDigest: null, treeDigest, ...record,
  }));
  writeFileSync(join(dir, '.complete'), 'x\n');
}

interface Fake { deps: ReleaseAdminDeps; asked: AdminRequest[]; audits: Array<{ action: string; detail?: Record<string, unknown> }>; restarts: unknown[]; accepted: number; data: string }

function fake(principal: CallerPrincipal, o: { developer?: boolean; running?: boolean; approve?: boolean; pointer?: Record<string, unknown> } = {}): Fake {
  const data = mkdtempSync(join(tmpdir(), 'aura-reladmin-'));
  putRelease(data, AID);
  putRelease(data, BID);
  mkdirSync(join(data, 'aura/release'), { recursive: true });
  writeFileSync(join(data, 'aura/release/pointer.json'), JSON.stringify({ v: 1, current: AID, previous: null, switchedAt: 'x', jobId: JOB, ...o.pointer }));
  const f: Fake = { asked: [], audits: [], restarts: [], accepted: 0, data, deps: null as unknown as ReleaseAdminDeps };
  const actor: OwnerActor = { by: { kind: 'user', userId: 'default' } as never, detail: {} };
  f.deps = {
    dataDir: data,
    developerMode: () => o.developer === true,
    activation: async () => A,
    trustedTree: () => join(data, 'releases', AID),
    updater: () => ({ isRunning: () => o.running === true, readJob: () => null, startBuild: () => ({ ok: true, jobId: JOB }) }) as never,
    channel: async () => 'main',
    securityPolicy: async () => 'follow-signed',
    authenticate: async () => principal,
    ownerAction: async (_ctx, req) => { f.asked.push(req); return o.approve === false ? new Response('{"error":"needs-approval"}', { status: 202 }) : actor; },
    audit: async (_a, action, opts) => { f.audits.push({ action, ...(opts.detail ? { detail: opts.detail } : {}) }); },
    plannedRestart: async (opts) => { f.restarts.push(opts); return { ok: true, job: { id: JOB } }; },
    incompatibleApps: (c) => (c === 1 ? ['io.e2e.contract2'] : []),
    acceptWrites: () => { f.accepted++; },
    switchSystemApps: async () => undefined,
    notify: async () => undefined,
  };
  return f;
}

const ctx = { request: new Request('http://shell/api/admin/release/x', { method: 'POST' }), cookies: {} as never };
const owner: CallerPrincipal = { kind: 'user', userId: 'default', role: 'owner', verification: 'verified' } as never;
const operator: CallerPrincipal = { kind: 'operator', verification: 'verified' } as never;

test('Developer Mode: every release change answers 409 with the Developer workflow', async () => {
  const f = fake(owner, { developer: true });
  for (const r of [await postActivate(ctx, f.deps, { releaseId: BID }), await postRollback(ctx, f.deps, {})]) {
    assert.equal(r.status, 409);
    assert.equal((await r.json() as { error: string }).error, 'developer-mode');
  }
  assert.equal(f.asked.length, 0);
});

test('activate: the approval binds the exact release (system.release.activate), then the drain + updater; incompatible apps listed', async () => {
  const f = fake(owner);
  const r = await postActivate(ctx, f.deps, { releaseId: BID, when: 'now' });
  assert.equal(r.status, 202);
  assert.equal(f.asked[0]!.action, 'system.release.activate');
  assert.equal(f.asked[0]!.level, 'session', 'an upstream release is one click');
  const payload = f.asked[0]!.payload as Record<string, unknown>;
  assert.equal(payload['releaseId'], BID);
  assert.equal(payload['when'], 'now');
  assert.match(String(payload['treeDigest']), /^sha256:/);
  assert.ok(f.asked[0]!.highRisk?.some((h) => /Terminal sessions end/.test(h.item)));
  assert.ok(f.asked[0]!.highRisk?.some((h) => /io\.e2e\.contract2/.test(h.item)), 'the update proceeds; the app is listed');
  assert.deepEqual(f.restarts, [{ mode: 'release', releaseId: BID, when: 'now' }]);
  assert.equal(f.audits[0]!.action, 'release.activate');
  // a refused preflight asks nobody
  const g = fake(owner);
  const bad = await postActivate(ctx, g.deps, { releaseId: AID });
  assert.equal(bad.status, 409);
  assert.equal(g.asked.length, 0);
  assert.equal((await postActivate(ctx, g.deps, { releaseId: '../x' })).status, 400);
});

test('rollback: refused without a previous release; fresh; the data restore needs the snapshot of that switch', async () => {
  const none = fake(owner);
  assert.equal((await postRollback(ctx, none.deps, {})).status, 409);
  const f = fake(owner, { pointer: { current: BID, previous: AID } });
  const noSnap = await postRollback(ctx, f.deps, { restoreData: true });
  assert.equal(noSnap.status, 409);
  assert.equal((await noSnap.json() as { error: string }).error, 'no-snapshot');
  A.snapshot(f.data, { from: AID, to: BID, jobId: JOB });
  const r = await postRollback(ctx, f.deps, { restoreData: true });
  assert.equal(r.status, 202);
  assert.equal(f.asked[0]!.level, 'fresh');
  assert.ok(f.asked[0]!.highRisk?.some((h) => /is lost/.test(h.item)), 'the dialog says what is lost');
  assert.deepEqual(f.restarts, [{ mode: 'rollback', restoreData: true }]);
});

test('rollback-insecure: a signed security update is not rolled back without naming its advisories; a critical one never', async () => {
  for (const severity of ['high', 'critical']) {
    const f = fake(owner, { pointer: { current: BID, previous: AID } });
    putRelease(f.data, BID, { version: '0.3.0', channel: 'signed', provenance: 'upstream-signed', meta: { signed: true, metaDigest: 'sha256:x', securityUpdate: true, severity, advisories: ['AURA-2026-007'] } });
    putRelease(f.data, AID, { version: '0.2.0', channel: 'signed', provenance: 'upstream-signed', meta: { signed: true, metaDigest: 'sha256:y', securityUpdate: false } });
    const r = await postRollback(ctx, f.deps, {});
    assert.equal(r.status, 409);
    const body = await r.json() as { error: string; advisories: string[] };
    assert.equal(body.error, severity === 'critical' ? 'rollback-past-critical-fix' : 'rollback-insecure');
    assert.deepEqual(body.advisories, ['AURA-2026-007']);
    const confirmed = await postRollback(ctx, f.deps, { confirmInsecure: 'AURA-2026-007' });
    assert.equal(confirmed.status, severity === 'critical' ? 409 : 202);
    if (severity !== 'critical') assert.equal(f.audits.at(-1)!.action, 'release.rollback-insecure');
  }
});

test('accept-writes: the operator accepts and the marker goes; the owner only an abandoned hold, at fresh', async () => {
  const op = fake(operator);
  A.holdWrites(op.data, { jobId: JOB, from: AID, to: BID });
  const wrong = await postAcceptWrites(ctx, op.deps, { jobId: '2026-11-27T13-00-00-000Z' });
  assert.equal(wrong.status, 409);
  const r = await postAcceptWrites(ctx, op.deps, { jobId: JOB });
  assert.equal(r.status, 200);
  assert.equal(op.accepted, 1);
  assert.equal(A.readWritesHeld(op.data), null);
  assert.equal(op.audits[0]!.action, 'release.activated');

  const running = fake(owner, { running: true });
  A.holdWrites(running.data, { jobId: JOB, from: AID, to: BID });
  assert.equal((await postAcceptWrites(ctx, running.deps, {})).status, 403, 'a verifying release is the updater\'s');
  const abandoned = fake(owner, { running: false });
  A.holdWrites(abandoned.data, { jobId: JOB, from: AID, to: BID });
  assert.equal((await postAcceptWrites(ctx, abandoned.deps, {})).status, 200);
  assert.equal(abandoned.asked[0]!.level, 'fresh');
  assert.equal(abandoned.audits[0]!.action, 'release.accepted-by-owner');
});

test('status shows an abandoned hold; the 7b ReleaseActivator starts the same job and reports it pending', async () => {
  const f = fake(owner);
  A.holdWrites(f.data, { jobId: JOB, from: AID, to: BID });
  const s = await (await getStatus(f.deps)).json() as { held: { abandoned: boolean } };
  assert.equal(s.held.abandoned, true);
  const g = fake(owner);
  const r = await releaseActivator(g.deps).activate({ releaseId: BID, endsSessions: [], when: 'next-start' });
  assert.deepEqual(r, { ok: true, pending: true, jobId: JOB });
  assert.equal(g.asked.length, 0, 'the approval is the caller\'s (system.patch.activate)');
});
