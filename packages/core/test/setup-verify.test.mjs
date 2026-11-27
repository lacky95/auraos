// D108 P3v (7c integration verification): the real engine over real records, P9 through the
// INT adapter. Owner items: 2 Private Home revocation, 3 the effective sidecar configuration
// (engine side), 4 initialization retry safety, 5 restart reconciliation, 6 decision 13,
// 7 decision 12. World: setup-verify-world.mjs.
//
//   node tools/run-tests.mjs --only=packages/core
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { AppManifestSchema } from '../dist/types/manifest.js';
import { payloadHash } from '../dist/approvals/state.js';
import { MAX_INIT_ATTEMPTS } from '../dist/index.js';
import { kvHarness, world, fakeStarter, until, openWebui, OPERATOR, OWNER, TERMINAL } from './setup-verify-world.mjs';

const h = kvHarness();
before(() => h.start());
after(() => h.stop());
beforeEach(() => h.reset());

const BASE = { name: 'Tools', version: '1.0.0', auraContract: 1 };
const profiled = (profiles, over = {}) => AppManifestSchema.parse({ id: 'com.example.tools', ...BASE, profiles, ...over });
const owui = (over = {}) => AppManifestSchema.parse({ ...openWebui(), ...over });
const okStarter = () => fakeStarter({ onSetup: () => ({ ok: true }) });

/** Open WebUI set up with `personal-private`: approved (operator for the owner), initialized, ready. */
async function privateOwui(o = {}) {
  const w = await world(h, owui(), { starter: okStarter(), ...o });
  const r = await w.svc.apply(w.appId, { profile: 'personal-private' }, OWNER);
  assert.equal(r.status, 'on-hold', JSON.stringify(r.error));
  const rec = await h.approvals.get(r.approvalId);
  assert.deepEqual([rec.class, rec.payload.adds.homePrivate, rec.payload.adds.homePrivateSidecars], ['forced', true, ['terminal']]);
  assert.equal((await h.approvals.approve(r.approvalId, OPERATOR)).ok, true);
  const done = await w.svc.resume(w.appId, OWNER);
  await w.svc.settled();
  assert.ok(['ready', 'initializing'].includes(done.status), JSON.stringify(done.error));
  assert.equal((await w.summary()).state, 'ready');
  w.instances = [{ instanceId: `${w.appId}-1`, owner: 'default', runAs: 'user' }];
  w.sessions = [{ sessionId: 'sess-1', instanceId: `${w.appId}-1` }];
  return w;
}

// ── item 2: Private Home revocation ─────────────────────────────────────────

for (const [label, lose, restore] of [
  ['home.private revoked', (w) => w.revokeHome('home.private'), (w) => w.regrantHome('home.private')],
  ['home.private.sidecar:terminal revoked', (w) => w.revokeHome('home.private.sidecar:terminal'), (w) => w.regrantHome('home.private.sidecar:terminal')],
  ['D64 app-private-home = off', async (w) => { w.policy['app-private-home'] = 'off'; await w.svc.recheck(w.appId); }, async (w) => { w.policy['app-private-home'] = 'grant'; await w.svc.recheck(w.appId); }],
]) {
  test(`item 2: ${label}: instance, sidecars and sessions stopped, blocked, desired stays private, next start refused; re-authorized → ready without asking again`, async () => {
    const w = await privateOwui();
    const before = await w.summary();
    const record = await w.record();
    const creates = w.creates;
    w.svc.start();   // the BlockingWatcher: a grant change arrives as permissions:changed
    try {
      await lose(w);
      const s = await until(async () => ((await w.summary()).state === 'blocked' ? w.summary() : null));
      assert.ok(s, 'blocked');
      assert.equal(s.configDigest, before.configDigest, 'the digests stay those of the ready configuration');
      assert.deepEqual(w.stopped, [w.appId], 'the engine stops the workloads (instances with their sidecars)');
      await until(() => w.sessionsEnded.length > 0);
      assert.deepEqual(w.sessionsEnded, ['sess-1'], 'P9 teardown ends the sessions open in it');
      assert.deepEqual(w.instanceStops, [`${w.appId}-1`], 'and stops the instance running as the user');
      assert.ok(w.audits.some((a) => a.action === 'home.private.revoked'));
      const rec = await w.record();
      assert.equal(rec.profile, 'personal-private', 'desired stays private: never the App Home');
      assert.deepEqual(rec, record, 'the desired record is untouched');
      const g = await w.gate();
      assert.deepEqual([g.ok, g.block.error, g.block.category], [false, 'setup-blocked', 'needs-setup'], 'the next start is refused');
      assert.equal(w.svc.knownBlock(w.appId).error, 'setup-blocked');
      assert.equal(w.svc.manifestView(w.appId, w.manifest), w.manifest, 'a blocked app reads only its base');
      assert.equal(w.svc.effectiveHome(w.appId), null, 'no effective configuration while blocked');

      await restore(w);
      const back = await until(async () => ((await w.summary()).state === 'ready' ? w.summary() : null));
      assert.ok(back, 'ready again');
      assert.deepEqual([back.configDigest, back.grantDigest], [before.configDigest, before.grantDigest]);
      assert.equal(w.creates, creates, 'no approval asked again');
      assert.deepEqual(await w.record(), record, 'no value asked again');
      assert.equal((await w.gate()).ok, true);
    } finally {
      w.svc.stop();
    }
  });
}

// ── item 3: the effective sidecar configuration (engine and P9 facts) ───────

test('item 3: personal-private sets network instance and owner-environment only in its overlay: authorized; the view and P9\'s spawn facts carry it', async () => {
  const w = await privateOwui();
  const base = w.manifest;
  assert.equal(base.services.find((s) => s.name === 'webui').network, undefined, 'the base webui listens on the shared network');
  const view = w.svc.manifestView(w.appId, base);
  const svc = Object.fromEntries(view.services.map((s) => [s.name, s]));
  assert.equal(svc.webui.network, 'instance');
  assert.deepEqual([svc.terminal.home, svc.terminal.network], ['owner-environment', 'instance']);
  assert.equal(w.svc.effectiveHome(w.appId), 'private');
  // P9's spawn port (compose privateHomeForSpawn): facts from the effective view, re-checked at each start.
  const port = w.spawnPort();
  assert.equal(await port.homeEnvironmentFor(w.appId, 'default'), 'private');
  assert.equal(await port.sidecarAuthorized(w.appId, 'default', 'terminal'), true);
  assert.equal(await port.sidecarAuthorized(w.appId, 'default', 'webui'), false, 'webui is not an owner-environment sidecar');
  await assert.rejects(port.homeEnvironmentFor(w.appId, undefined), (e) => e.name === 'HomePrivateError', 'never for nobody (a pool member)');
  // The home port with the base manifest would refuse it: the overlay is what makes it authorized.
  assert.equal(await w.home.homePrivateAuthorized({ appId: w.appId, installationId: w.installationId, userId: 'default', manifest: base }), false);
  assert.equal(await w.home.homePrivateAuthorized({ appId: w.appId, installationId: w.installationId, userId: 'default', manifest: view }), true);
});

test('item 3: a Private Home profile that leaves the base shared listener is refused before any approval (fail closed)', async () => {
  const w = await world(h, owui(), { starter: okStarter() });
  const r = await w.svc.apply(w.appId, { profile: 'private-shared-listener' }, OWNER);
  assert.equal(r.status, 'refused');
  assert.equal(r.error.error, 'requirement-unsupported');
  assert.match(r.error.message, /webui/);
  assert.equal(w.creates, 0, 'no approval asked');
  assert.equal(await w.record(), null, 'nothing written');
  assert.equal(await w.summary(), null);
});

// ── item 4: initialization retry safety ─────────────────────────────────────

const hooked = () => profiled([{ id: 'p', title: 'P', overlay: {} }], { setup: { version: 1, fields: { url: { type: 'string', title: 'URL', default: 'x' } }, init: { hook: true, idempotent: true, timeoutSec: 30 } } });

test('item 4: an interrupted onSetup is called again with the same digest (next attempt); the interrupted run never marks ready', async () => {
  let release;
  const hang = new Promise((r) => { release = r; });
  const first = fakeStarter({ onSetup: () => hang.then(() => ({ ok: true })) });
  const w = await world(h, hooked(), { starter: first });
  const r = await w.svc.apply(w.appId, { profile: 'p' }, OWNER);
  assert.equal(r.status, 'initializing');
  const old = w.svc;
  // The kernel dies while onSetup runs; the new kernel retries.
  const second = fakeStarter({ onSetup: () => ({ ok: true }) });
  w.starter = second;
  const svc = w.restart();
  await svc.recover();
  await svc.settled();
  const s = await w.summary();
  assert.equal(s.state, 'ready');
  const a = first.calls.find((c) => c[0] === 'onSetup')[1];
  const b = second.calls.find((c) => c[0] === 'onSetup')[1];
  assert.equal(b.configDigest, a.configDigest, 'the same configuration');
  assert.equal(b.previousDigest, a.previousDigest);
  assert.deepEqual([a.attempt, b.attempt], [1, 2]);
  assert.equal(s.configDigest, a.configDigest);
  // The interrupted run finishes late: it does not write anything.
  release();
  await old.settled();
  const after = await w.summary();
  assert.deepEqual([after.state, after.updatedAt], ['ready', s.updatedAt], 'the stale run changed nothing');
});

test('item 4: a failed init never becomes ready (no retry of an explicit failure, not on restart); the attempt cap gives setup-failed', async () => {
  let calls = 0;
  const w = await world(h, hooked(), { starter: fakeStarter({ onSetup: () => { calls++; return { ok: false, message: 'db unreachable' }; } }) });
  await w.svc.apply(w.appId, { profile: 'p' }, OWNER);
  await w.svc.settled();
  assert.deepEqual([(await w.summary()).state, calls], ['setup-failed', 1]);
  const svc = w.restart();
  await svc.recover();
  await svc.settled();
  assert.deepEqual([(await w.summary()).state, calls], ['setup-failed', 1], 'a restart does not retry or ready a failed run');
  assert.equal((await w.gate()).ok, false);
  assert.equal((await svc.resume(w.appId, null)).status, 'unchanged', 'resume without an actor changes nothing');

  // Interrupted MAX times: setup-failed, the hook is not called again.
  let s = await w.summary();
  s = await h.machine.transition(w.installationId, s, 'configuring');
  s = await h.machine.transition(w.installationId, s, 'initializing', { attempt: MAX_INIT_ATTEMPTS, step: 'init' });
  const again = w.restart();
  await again.recover();
  await again.settled();
  const f = await w.summary();
  assert.deepEqual([f.state, f.error.error, calls], ['setup-failed', 'setup-failed', 1]);
  assert.match(f.error.message, /interrupted/);
});

const power = () => profiled([{ id: 'power', title: 'Power', overlay: { permissions: ['apps.mount', 'notifications.popup'], tools: ['git'] } }]);

test('item 4: an app.setup.apply that expires across a restart is not reused; a new one is asked once (D102: no duplicate while it is pending)', async () => {
  const w = await world(h, power());
  const r1 = await w.svc.apply(w.appId, { profile: 'power' }, TERMINAL);
  assert.equal(r1.status, 'on-hold');
  const rec1 = await h.approvals.get(r1.approvalId);
  h.clock.t = rec1.expiresAt + 1;   // it expires while the kernel is down
  const svc = w.restart();
  const r2 = await svc.resume(w.appId, TERMINAL);
  assert.equal(r2.status, 'on-hold', JSON.stringify(r2.error));
  assert.notEqual(r2.approvalId, r1.approvalId, 'the expired approval is not reused');
  assert.equal((await h.approvals.get(r1.approvalId)).state, 'expired');
  const r3 = await svc.resume(w.appId, TERMINAL);
  assert.equal(r3.approvalId, r2.approvalId, 'resumed again: the same request');
  assert.equal((await h.approvals.listPending()).length, 1, 'one pending request');
  assert.equal((await w.svc.apply(w.appId, {}, TERMINAL)).approvalId, r2.approvalId, 'an empty apply resumes it too');
  // An approved one that expires before its use is not used either.
  await h.approvals.approve(r2.approvalId, OPERATOR);
  h.clock.t = (await h.approvals.get(r2.approvalId)).expiresAt + 1;
  const r4 = await w.restart().resume(w.appId, TERMINAL);
  assert.equal(r4.status, 'on-hold');
  assert.notEqual(r4.approvalId, r2.approvalId);
  assert.equal((await h.grants.listFor({ kind: 'app', id: w.appId })).length, 0, 'nothing granted from an expired approval');
  await h.approvals.approve(r4.approvalId, OPERATOR);
  assert.equal((await w.svc.resume(w.appId, TERMINAL)).status, 'ready');
});

// ── item 5: restart reconciliation ──────────────────────────────────────────

test('item 5: restart mid-configuring: the recorded step continues; the approval is asked once', async () => {
  const w = await world(h, power());
  let s = await h.machine.begin(w.installationId, w.manifest);
  s = await h.machine.transition(w.installationId, s, 'configuring', { step: 'approval' });
  await h.store.update({ installationId: w.installationId }, () => ({
    v: 1, setupVersion: 0, profile: 'power', values: {}, secrets: {}, overrides: {}, updatedAt: new Date().toISOString(), updatedBy: 'user:default',
  }));
  const svc = w.restart();
  await svc.recover();
  assert.equal((await w.summary()).state, 'configuring', 'recovery never acts for nobody in configuring');
  const r = await svc.resume(w.appId, OWNER);
  assert.equal(r.status, 'on-hold', JSON.stringify(r.error));
  assert.equal((await w.restart().resume(w.appId, OWNER)).approvalId, r.approvalId);
  assert.equal((await h.approvals.listPending()).length, 1);
});

test('item 5: restart mid-awaiting-approval with a held approval: revalidated against the current digests, then used once', async () => {
  const w = await world(h, power());
  const r = await w.svc.apply(w.appId, { profile: 'power' }, OWNER);
  await h.approvals.approve(r.approvalId, OPERATOR);
  const svc = w.restart();
  await svc.recover();
  assert.equal((await w.summary()).state, 'awaiting-approval', 'recovery does not consume it for nobody');
  const done = await svc.resume(w.appId, OWNER);
  assert.equal(done.status, 'ready', JSON.stringify(done.error));
  assert.equal((await h.approvals.get(r.approvalId)).state, 'consumed');
  assert.ok(await h.grants.get({ kind: 'app', id: w.appId }, 'notifications.popup'), 'the grantable part became a grant');
  // A second restart: ready, and the non-grantable approved requests still count (the ready grantDigest).
  const again = w.restart();
  await again.recover();
  assert.equal((await again.check(w.appId, w.manifest, { installationId: w.installationId })).ok, true);
  const view = again.manifestView(w.appId, w.manifest);
  assert.ok(view.permissions.includes('apps.mount') && view.tools.includes('git'), 'recovery restores the effective view of a ready app');
});

test('item 5: restart while blocked: stays blocked (gate refuses) until re-authorized, then ready with the same digests', async () => {
  const w = await world(h, power());
  const r = await w.svc.apply(w.appId, { profile: 'power' }, OWNER);
  await h.approvals.approve(r.approvalId, OPERATOR);
  await w.svc.resume(w.appId, OWNER);
  const ready = await w.summary();
  await h.grants.revoke({ kind: 'app', id: w.appId }, 'notifications.popup');
  await w.svc.recheck(w.appId);
  assert.equal((await w.summary()).state, 'blocked');
  const svc = w.restart();
  await svc.recover();
  assert.equal((await w.summary()).state, 'blocked', 'still blocked after the restart');
  assert.equal((await svc.check(w.appId, w.manifest, { installationId: w.installationId })).block.error, 'setup-blocked');
  assert.equal(svc.manifestView(w.appId, w.manifest), w.manifest);
  await h.grants.grant({ kind: 'app', id: w.appId }, 'notifications.popup', { by: { kind: 'operator' }, installationId: w.installationId, appScope: 'user' });
  const again = w.restart();
  await again.recover();
  const s = await w.summary();
  assert.deepEqual([s.state, s.configDigest, s.grantDigest], ['ready', ready.configDigest, ready.grantDigest]);
});

// ── item 6: owner decision 13 ───────────────────────────────────────────────

const twoProfiles = (over = {}) => profiled([
  { id: 'plain', title: 'Plain', overlay: { tools: ['git'] } },
  { id: 'more', title: 'More', overlay: { permissions: ['notifications.popup'] } },
], { setup: { version: 1, fields: { greeting: { type: 'string', title: 'Greeting', default: 'hi', pattern: '^[a-z]{1,10}$' } } }, tools: ['git'], ...over });

async function working(o = {}) {
  const w = await world(h, twoProfiles(), o);
  const r = await w.svc.apply(w.appId, { profile: 'plain' }, OWNER);
  await w.svc.settled();
  assert.equal((await w.summary()).state, 'ready', JSON.stringify(r.error));
  w.stopped.length = 0;
  w.old = { summary: await w.summary(), record: await w.record() };
  return w;
}

test('item 6: a reconfiguration\'s approval denial before execution leaves the working app untouched: ready, old digests, running, no stop', async () => {
  const w = await working();
  const r = await w.svc.reconfigure(w.appId, { profile: 'more' }, OWNER);
  assert.equal(r.status, 'on-hold');
  // While it waits, the running app keeps its validated configuration (a refused start does not take it away).
  assert.equal((await w.gate()).ok, false, 'a new start waits for the decision');
  assert.equal(w.svc.effectiveHome(w.appId), 'app', 'the running app keeps its validated configuration');
  await h.approvals.deny(r.approvalId, OPERATOR, 'no');
  const out = await w.svc.resume(w.appId, OWNER);
  assert.deepEqual([out.status, out.error.error, out.state.state], ['refused', 'approval-denied', 'ready']);
  const s = await w.summary();
  assert.deepEqual([s.state, s.configDigest, s.grantDigest, s.profile], ['ready', w.old.summary.configDigest, w.old.summary.grantDigest, 'plain']);
  assert.deepEqual((await w.record()).profile, 'plain', 'the desired configuration is the one it runs with');
  assert.deepEqual(w.stopped, [], 'never stopped');
  assert.equal((await w.gate()).ok, true, 'it starts with its old configuration');
  assert.equal((await h.grants.listFor({ kind: 'app', id: w.appId })).length, 0, 'nothing granted');
});

test('item 6 (INT): a kernel restart while the reconfiguration waits: a denial still keeps the working app ready (durable applied snapshot)', async () => {
  const w = await working();
  const r = await w.svc.reconfigure(w.appId, { profile: 'more' }, OWNER);
  assert.equal(r.status, 'on-hold');
  w.restart(); // the in-memory previous configuration is gone; P8's sealed applied snapshot is not
  await h.approvals.deny(r.approvalId, OPERATOR, 'no');
  const out = await w.svc.resume(w.appId, OWNER);
  assert.deepEqual([out.status, out.error.error, out.state.state], ['refused', 'approval-denied', 'ready']);
  const s = await w.summary();
  assert.deepEqual([s.state, s.configDigest, s.grantDigest, s.profile], ['ready', w.old.summary.configDigest, w.old.summary.grantDigest, 'plain']);
  assert.equal((await w.record()).profile, 'plain', 'the desired record is written back');
  assert.deepEqual(w.stopped, [], 'never stopped');
});

test('item 6: a validation failure before execution changes nothing (no write, no stop)', async () => {
  const w = await working();
  const r = await w.svc.reconfigure(w.appId, { values: { greeting: 'Not Valid!' } }, OWNER);
  assert.deepEqual([r.status, r.error.error], ['refused', 'config-invalid']);
  assert.deepEqual(await w.summary(), w.old.summary);
  assert.deepEqual(await w.record(), w.old.record);
  assert.deepEqual(w.stopped, []);
});

test('item 6: an approval that can\'t be requested (one already pending from here) leaves the working app ready', async () => {
  const w = await working();
  await h.approvals.create({ requester: { kind: 'user', userId: 'default' }, action: 'credential.store', payloadHash: payloadHash({ other: 1 }), display: { title: 'Store a secret', details: [], requestedBy: 'you' }, level: 'session', class: 'deferrable', payload: {} });
  const r = await w.svc.reconfigure(w.appId, { profile: 'more' }, OWNER);
  assert.equal(r.status, 'refused');
  const s = await w.summary();
  assert.deepEqual([s.state, s.configDigest], ['ready', w.old.summary.configDigest]);
  assert.equal((await w.record()).profile, 'plain');
  assert.deepEqual(w.stopped, []);
});

test('item 6: once an approved reconfiguration executes, an init failure leaves it stopped in setup-failed; no automatic restore', async () => {
  let fail = false;
  const w = await world(h, twoProfiles({ setup: { version: 1, fields: { greeting: { type: 'string', title: 'Greeting', default: 'hi' } }, init: { hook: true, idempotent: true } } }), {
    starter: fakeStarter({ onSetup: () => (fail ? { ok: false, message: 'migration failed' } : { ok: true }) }),
  });
  await w.svc.apply(w.appId, { profile: 'plain' }, OWNER);
  await w.svc.settled();
  const old = await w.summary();
  assert.equal(old.state, 'ready');
  w.stopped.length = 0;
  fail = true;
  const r = await w.svc.reconfigure(w.appId, { profile: 'more' }, OWNER);
  await h.approvals.approve(r.approvalId, OPERATOR);
  await w.svc.resume(w.appId, OWNER);
  await w.svc.settled();
  const s = await w.summary();
  assert.deepEqual([s.state, s.error.error, s.configDigest], ['setup-failed', 'hook-failed', old.configDigest]);
  assert.deepEqual(w.stopped, [w.appId], 'stopped when the execution began');
  assert.equal((await w.record()).profile, 'more', 'no automatic restore of the previous configuration');
  assert.equal((await w.gate()).ok, false);
  assert.equal(w.svc.manifestView(w.appId, w.manifest), w.manifest, 'a failed app reads only its base');
});

// ── item 7: decision 12 ─────────────────────────────────────────────────────

test('item 7: validated before the approval; the approval is bound to the validated plan', async () => {
  const w = await world(h, twoProfiles());
  const bad = await w.svc.apply(w.appId, { profile: 'more', values: { greeting: 'Not Valid!' } }, OWNER);
  assert.deepEqual([bad.status, bad.error.error, w.creates], ['refused', 'config-invalid', 0], 'no approval for an invalid plan');
  const plan = await w.svc.plan(w.appId, { profile: 'more' });
  const r = await w.svc.apply(w.appId, { profile: 'more' }, OWNER);
  const rec = await h.approvals.get(r.approvalId);
  assert.deepEqual([rec.payload.configDigest, rec.payload.grantDigest], [plan.configDigest, plan.grantDigest]);
  assert.equal(rec.payloadHash, payloadHash(rec.payload));
  assert.deepEqual(rec.payload, plan.approval);
});

for (const [label, change] of [
  ['the manifest (an update adds a tool to the profile)', (w) => { w.manifest = twoProfiles({ profiles: [{ id: 'plain', title: 'Plain', overlay: {} }, { id: 'more', title: 'More', overlay: { permissions: ['notifications.popup'], tools: ['jq'] } }] }); }],
  ['a value (another client)', (w) => h.store.update({ installationId: w.installationId }, (c) => ({ ...c, values: { greeting: 'yo' }, updatedAt: new Date().toISOString() }))],
]) {
  test(`item 7: revalidated before execution: ${label} changed after the approval → refused, asked anew, nothing granted or run`, async () => {
    const starter = okStarter();
    const w = await world(h, twoProfiles(), { starter });
    const r1 = await w.svc.apply(w.appId, { profile: 'more' }, OWNER);
    await h.approvals.approve(r1.approvalId, OPERATOR);
    await change(w);
    const r2 = await w.svc.resume(w.appId, OWNER);
    assert.equal(r2.status, 'on-hold', JSON.stringify(r2.error));
    assert.notEqual(r2.approvalId, r1.approvalId);
    assert.equal((await h.approvals.get(r1.approvalId)).state, 'cancelled', 'the approved plan is not executed');
    assert.equal((await h.grants.listFor({ kind: 'app', id: w.appId })).length, 0);
    assert.equal(starter.calls.length, 0, 'no init ran');
    assert.notEqual((await h.approvals.get(r2.approvalId)).payloadHash, (await h.approvals.get(r1.approvalId)).payloadHash);
  });
}

// ── item 9: the hook's own maintenance instance reads its pending configuration ──

test('item 9: while initializing, only the app\'s own setup maintenance instance reads the configuration it initializes (handles only)', async () => {
  const m = profiled([{ id: 'p', title: 'P', overlay: {} }], { setup: { version: 1,
    fields: { url: { type: 'string', title: 'URL', default: 'https://x.example' }, key: { type: 'secret', title: 'Key', secret: { source: 'generate', length: 32 } } },
    init: { hook: true, idempotent: true } } });
  let w;
  const seen = {};
  const read = (instanceId, appId = w.appId) => w.svc.selfConfig({ appId, instanceId }).then((v) => v, (e) => e);
  const starter = fakeStarter({
    onSetup: async () => {
      seen.hook = await read(`${w.appId}-m`);
      seen.normal = await read(`${w.appId}-1`);
      seen.state = (await w.summary()).state;
      return { ok: true };
    },
  });
  w = await world(h, m, { starter });
  const other = await world(h, AppManifestSchema.parse({ ...m, id: 'com.example.other' }));
  await w.svc.apply(w.appId, { profile: 'p' }, OWNER);
  await w.svc.settled();
  assert.equal(seen.state, 'initializing');
  assert.equal(seen.hook.values?.url, 'https://x.example', `the hook's instance gets the view (${seen.hook.message ?? ''})`);
  assert.match(seen.hook.secrets.key, /^cred_/, 'a secret as its handle');
  assert.equal(seen.normal.name, 'SetupEngineError', 'a normal instance of the app is refused while initializing');
  assert.equal(seen.normal.code, 'setup-required');
  // Another app (its own setup not ready) never reads it; the hook instance id means nothing for it.
  const o = await other.svc.selfConfig({ appId: other.appId, instanceId: `${w.appId}-m` }).then((v) => v, (e) => e);
  assert.equal(o.name, 'SetupEngineError');
  // No secret value in the answer.
  const rec = await w.record();
  const value = await w.vault.reveal('default', (await w.vault.resolve('default', rec.secrets.key)).name, w.appId);
  assert.ok(value && value.length === 32);
  assert.equal(JSON.stringify(seen.hook).includes(value), false);
  // After the run: the hook instance is no longer special; ready serves every instance of the app.
  assert.equal((await w.summary()).state, 'ready');
  assert.equal((await read(`${w.appId}-1`)).values.url, 'https://x.example');
});
