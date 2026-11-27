// ValkeyApprovalStore (5.10) against a REAL valkey-server: atomic
// transitions, single use under races, expiry, one pending request per
// requester, the rate limit and blocked apps. Plus operator setup tickets.
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kvServer, createRedis } from '@aura/kv-store';
import {
  APPROVAL_CREATES_PER_MINUTE, APPROVAL_PENDING_KEY, APPROVAL_TTL_MS, FileSetupTickets, HOLD_TTL_MS, ValkeyApprovalStore,
  createSetupTicket, defaultSetupTicketDir, payloadHash, requesterAppId,
} from '../dist/index.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-approvals-'));
let redis;
let clock = 1_800_000_000_000;
const now = () => clock;
let store;

const TERMINAL = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', userId: 'default' };
const NEXUS_OWNER = { kind: 'user', userId: 'default', through: { appId: 'com.aura.nexus', instanceId: 'com.aura.nexus-1' } };
const OWNER = { kind: 'user', userId: 'default', sessionId: 's1', fresh: false };
const OWNER_FRESH = { ...OWNER, fresh: true };
const OPERATOR = { kind: 'operator' };
const HASH = payloadHash({ digest: 'sha256:abc', scope: 'user', permissions: [] });
const DISPLAY = { title: 'Install Notes 1.0.0', details: ['Scope: user'], requestedBy: 'Terminal' };

const request = (over = {}) => ({ requester: TERMINAL, action: 'nexus.install', payloadHash: HASH, display: DISPLAY, level: 'session', ...over });
const claim = (over = {}) => ({ requester: TERMINAL, action: 'nexus.install', payloadHash: HASH, ...over });

before(async () => {
  const uri = await kvServer.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
});

beforeEach(async () => {
  await redis.flushall();
  clock += 3_600_000;
  store = new ValkeyApprovalStore({ redis: () => redis, now });
});

after(async () => {
  redis?.disconnect();
  await kvServer.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test('create → approve → consume, once', async () => {
  const c = await store.create(request());
  assert.equal(c.ok, true);
  const id = c.record.id;
  assert.equal(c.record.state, 'pending');
  assert.equal(c.record.expiresAt, clock + APPROVAL_TTL_MS);
  assert.deepEqual((await store.listPending()).map((r) => r.id), [id]);

  const a = await store.approve(id, OWNER);
  assert.equal(a.ok, true);
  assert.deepEqual(a.record.decidedBy, OWNER);
  assert.deepEqual(await store.listPending(), [], 'an approved request leaves the dialog queue');

  assert.equal((await store.consume(id, claim())).ok, true);
  assert.equal((await store.get(id)).state, 'consumed');
  assert.deepEqual(await store.consume(id, claim()), { ok: false, reason: 'wrong-state' }, 'single use');
});

test('a consume must match requester, action and payload exactly', async () => {
  const { record } = await store.create(request());
  await store.approve(record.id, OWNER);
  assert.equal((await store.consume(record.id, claim({ payloadHash: payloadHash({ moved: 'tag' }) }))).reason, 'mismatch');
  assert.equal((await store.consume(record.id, claim({ action: 'nexus.update' }))).reason, 'mismatch');
  assert.equal((await store.consume(record.id, claim({ requester: { ...TERMINAL, instanceId: 'com.aura.terminal-4' } }))).reason, 'mismatch');
  assert.equal((await store.consume(record.id, claim())).ok, true, 'a refused claim does not use it up');
});

test('fresh needs a fresh decider; the operator always is', async () => {
  const { record } = await store.create(request({ level: 'fresh' }));
  assert.deepEqual(await store.approve(record.id, OWNER), { ok: false, reason: 'needs-fresh-auth' });
  assert.equal((await store.approve(record.id, OWNER_FRESH)).ok, true);

  await redis.flushall();
  const second = await store.create(request({ level: 'fresh' }));
  assert.equal((await store.approve(second.record.id, OPERATOR)).ok, true);
});

test('denied is final', async () => {
  const { record } = await store.create(request());
  assert.equal((await store.deny(record.id, OWNER)).ok, true);
  assert.equal((await store.approve(record.id, OWNER)).reason, 'wrong-state');
  assert.equal((await store.consume(record.id, claim())).reason, 'wrong-state');
  assert.equal((await store.get(record.id)).state, 'denied');
});

test('ten minutes: pending and approved both expire, and the slot frees', async () => {
  const { record } = await store.create(request());
  clock += APPROVAL_TTL_MS;
  assert.equal((await store.get(record.id)).state, 'expired', 'polling reads expired');
  assert.deepEqual(await store.approve(record.id, OWNER), { ok: false, reason: 'expired' });
  assert.deepEqual(await store.listPending(), []);
  assert.equal((await store.create(request({ payloadHash: payloadHash({ next: 1 }) }))).ok, true, 'a new request after expiry');

  await redis.flushall();
  const b = await store.create(request());
  await store.approve(b.record.id, OWNER);
  clock += APPROVAL_TTL_MS - 1;
  clock += 1;
  assert.deepEqual(await store.consume(b.record.id, claim()), { ok: false, reason: 'expired' });
});

test('one pending request per requester; the same request again is the same record', async () => {
  const first = await store.create(request());
  const again = await store.create(request());
  assert.equal(again.ok, true);
  assert.equal(again.record.id, first.record.id);
  assert.deepEqual(await store.create(request({ payloadHash: payloadHash({ other: 1 }) })), { ok: false, reason: 'too-many-pending' });
  assert.equal((await store.create(request({ requester: NEXUS_OWNER }))).ok, true, 'another requester has its own slot');
  await store.deny(first.record.id, OWNER);
  assert.equal((await store.create(request({ payloadHash: payloadHash({ other: 1 }) }))).ok, true, 'deciding frees the slot');
});

test('concurrent creates by one requester: exactly one record', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.create(request({ payloadHash: payloadHash({ i }) }))));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'too-many-pending' || r.reason === 'rate-limited'));
  assert.equal(await redis.zcard(APPROVAL_PENDING_KEY), 1);
});

test('races: two consumers, approve vs deny, consume vs expire', async () => {
  const { record } = await store.create(request());
  await store.approve(record.id, OWNER);
  const twin = new ValkeyApprovalStore({ redis: () => redis, now });
  const consumes = await Promise.all([store.consume(record.id, claim()), twin.consume(record.id, claim()), store.consume(record.id, claim())]);
  assert.equal(consumes.filter((r) => r.ok).length, 1, 'only one consumer wins');

  await redis.flushall();
  const b = await store.create(request());
  const decisions = await Promise.all([store.approve(b.record.id, OWNER), twin.deny(b.record.id, OWNER)]);
  assert.equal(decisions.filter((r) => r.ok).length, 1, 'approve and deny cannot both win');
  assert.equal((await store.get(b.record.id)).state, decisions[0].ok ? 'approved' : 'denied');
});

test('rate limit per requester and minute', async () => {
  for (let i = 0; i < APPROVAL_CREATES_PER_MINUTE; i++) {
    const r = await store.create(request({ payloadHash: payloadHash({ i }) }));
    assert.equal(r.ok, true, `create ${i}`);
    await store.deny(r.record.id, OWNER);
  }
  assert.deepEqual(await store.create(request({ payloadHash: payloadHash({ i: 'over' }) })), { ok: false, reason: 'rate-limited' });
  assert.equal((await store.create(request({ requester: NEXUS_OWNER }))).ok, true, 'other requesters are not limited');
  clock += 60_000;
  assert.equal((await store.create(request({ payloadHash: payloadHash({ i: 'later' }) }))).ok, true);
});

test('blocked apps are refused until unblocked', async () => {
  assert.equal(requesterAppId(TERMINAL), 'com.aura.terminal');
  assert.equal(requesterAppId(NEXUS_OWNER), 'com.aura.nexus');
  assert.equal(requesterAppId({ kind: 'user', userId: 'default' }), null);
  await store.block('com.aura.terminal', 'user:default');
  assert.deepEqual(await store.create(request()), { ok: false, reason: 'blocked' });
  assert.equal((await store.create(request({ requester: NEXUS_OWNER }))).ok, true);
  assert.deepEqual((await store.listBlocked()).map((b) => b.appId), ['com.aura.terminal']);
  assert.equal(await store.unblock('com.aura.terminal'), true);
  assert.equal(await store.unblock('com.aura.terminal'), false);
  assert.equal((await store.create(request())).ok, true);
});

test('unknown and malformed ids', async () => {
  assert.equal(await store.get('apr_AAAAAAAAAAAAAAAAAAAAAA'), null);
  assert.equal(await store.get('approval:pending'), null);
  assert.deepEqual(await store.approve('nope', OWNER), { ok: false, reason: 'not-found' });
  assert.deepEqual(await store.consume('apr_AAAAAAAAAAAAAAAAAAAAAA', claim()), { ok: false, reason: 'not-found' });
});

test('a stored record holds no credential', async () => {
  const { record } = await store.create(request());
  await store.approve(record.id, OWNER);
  const raw = await redis.get(`approval:${record.id}`);
  assert.doesNotMatch(raw, /password|token|cookie/i);
});

test('operator tickets: one subject each, peek does not use them up', async () => {
  const dir = defaultSetupTicketDir(DATA_DIR);
  const tickets = new FileSetupTickets({ dir, now });
  const a = createSetupTicket(DATA_DIR, { purpose: 'operator', subject: 'approve:apr_AAAAAAAAAAAAAAAAAAAAAA' }, now);
  const b = createSetupTicket(DATA_DIR, { purpose: 'operator', subject: 'nexus.install:' + HASH }, now);
  assert.equal((await tickets.peek(a.code, 'operator')).subject, 'approve:apr_AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(await tickets.peek(a.code, 'reset'), null);
  assert.equal((await tickets.claim(a.code, 'operator')).subject, 'approve:apr_AAAAAAAAAAAAAAAAAAAAAA', 'peek left it');
  assert.equal(await tickets.claim(a.code, 'operator'), null, 'single use');
  assert.equal((await tickets.claim(b.code, 'operator')).subject, `nexus.install:${HASH}`, 'operator codes stand side by side');
  assert.throws(() => createSetupTicket(DATA_DIR, { purpose: 'operator' }, now));
  assert.throws(() => createSetupTicket(DATA_DIR, { purpose: 'reset', subject: 'x' }, now));
  assert.throws(() => createSetupTicket(DATA_DIR, { purpose: 'operator', subject: 'has space' }, now));
});

// ── D102: hold, resume, cancel ──────────────────────────────────────────────

const OPEN = { title: 'Open the source of Notes', details: [], requestedBy: 'Terminal' };
const openReq = (over = {}) => request({ action: 'app.source.open', class: 'deferrable', display: OPEN, payloadHash: payloadHash({ appId: 'notes' }), ...over });
const openClaim = (over = {}) => claim({ action: 'app.source.open', payloadHash: payloadHash({ appId: 'notes' }), ...over });

test('D102: a held request stays pending and queued, record and slot live 24 h', async () => {
  const { record } = await store.create(openReq());
  assert.equal(record.class, 'deferrable');
  const h = await store.hold(record.id, OWNER);
  assert.equal(h.ok, true);
  assert.equal(h.record.state, 'pending');
  assert.equal(h.record.expiresAt, record.createdAt + HOLD_TTL_MS);
  const [listed] = await store.listPending();
  assert.equal(listed.id, record.id);
  assert.equal(typeof listed.heldAt, 'number');
  const slotTtl = Math.max(...await Promise.all((await redis.keys('approval:slot:*')).map((k) => redis.pttl(k))));
  assert.ok(slotTtl > APPROVAL_TTL_MS, `slot kept past 10 min (${slotTtl})`);
  assert.ok(await redis.pttl(`approval:${record.id}`) > HOLD_TTL_MS - 1000);
  clock += 2 * APPROVAL_TTL_MS;
  assert.equal((await store.get(record.id)).state, 'pending', 'still open after 20 min');
  assert.deepEqual(await store.create(openReq({ payloadHash: payloadHash({ other: 1 }) })), { ok: false, reason: 'too-many-pending' }, 'a held request still takes the one slot');
  const again = await store.create(openReq());
  assert.equal(again.record.id, record.id, 'asking again resumes it');
  assert.equal(again.resumed, true);
  assert.deepEqual(await store.consume(record.id, openClaim()), { ok: false, reason: 'wrong-state' }, 'held authorizes nothing');
  clock += HOLD_TTL_MS;
  assert.deepEqual(await store.approve(record.id, OWNER), { ok: false, reason: 'expired' }, 'past 24 h nothing is approved');
  assert.deepEqual(await store.listPending(), []);
});

test('D102: forced requests cannot be held', async () => {
  const { record } = await store.create(request());
  assert.deepEqual(await store.hold(record.id, OWNER), { ok: false, reason: 'not-deferrable' });
  assert.equal((await store.get(record.id)).heldAt, undefined);
});

test('D102: approved from hold: 10 minutes to use it, once; a re-run picks up the approved request', async () => {
  const { record } = await store.create(openReq());
  await store.hold(record.id, OWNER);
  clock += 5 * 3600 * 1000;
  const a = await store.approve(record.id, OWNER);
  assert.equal(a.record.expiresAt, clock + APPROVAL_TTL_MS);
  const again = await store.create(openReq());
  assert.equal(again.record.id, record.id, 'resume returns the approved request, no duplicate');
  assert.equal(again.record.state, 'approved');
  assert.equal((await store.consume(record.id, openClaim())).ok, true);
  assert.deepEqual(await store.consume(record.id, openClaim()), { ok: false, reason: 'wrong-state' }, 'single use');
  const fresh = await store.create(openReq());
  assert.notEqual(fresh.record.id, record.id, 'after the use, asking again is a new request');
  assert.equal(fresh.resumed, undefined);
});

test('D102: an approved request waiting for its use does not block a different one', async () => {
  const { record } = await store.create(openReq());
  await store.approve(record.id, OWNER);
  const other = await store.create(openReq({ payloadHash: payloadHash({ other: 2 }) }));
  assert.equal(other.ok, true);
  assert.equal((await store.consume(record.id, openClaim())).ok, true, 'the approved one is still usable');
});

test('D102: the requester withdraws; the slot frees; another requester cannot', async () => {
  const { record } = await store.create(openReq());
  await store.hold(record.id, OWNER);
  assert.deepEqual(await store.cancel(record.id, { kind: 'requester', requester: NEXUS_OWNER }), { ok: false, reason: 'mismatch' });
  const c = await store.cancel(record.id, { kind: 'requester', requester: TERMINAL });
  assert.equal(c.record.state, 'cancelled');
  assert.deepEqual(await store.listPending(), []);
  assert.deepEqual(await store.approve(record.id, OWNER_FRESH), { ok: false, reason: 'wrong-state' });
  assert.equal((await store.create(openReq({ payloadHash: payloadHash({ other: 3 }) }))).ok, true, 'slot freed');
});

test('D102: notice id on the record; deny keeps the owner feedback', async () => {
  const { record } = await store.create(openReq());
  await store.hold(record.id, OWNER);
  assert.equal((await store.setNotice(record.id, 'ntf_abcdefghij')).record.notice, 'ntf_abcdefghij');
  const d = await store.deny(record.id, OWNER, 'not today');
  assert.equal(d.record.feedback, 'not today');
  assert.equal(d.record.notice, 'ntf_abcdefghij', 'the shell removes the notice from it');
  assert.deepEqual(await store.setNotice(record.id, null), { ok: false, reason: 'wrong-state' });
});
