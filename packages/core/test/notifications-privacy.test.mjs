// Notifications phase 5 (privacy + housekeeping) against a REAL valkey-server.
//
//   pnpm --filter @aura/core test
//
// Covers: ClientSessionStore (register / lock / unlock / heartbeat, unknown,
// forged and expired sids → locked, the UnlockVerifier hook), the redaction
// matrix (viewer × lock × visibility × user override), read access with
// `notifications.read` grants and scopes (apps / senders / all, includeSecret,
// manifest request required, revoke), user-op gating, senderToken reads, the
// retention sweep with the one-time backfill, clear history, and list's
// dangling-id pruning.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import {
  NotificationService, NotificationError, SYSTEM_CALLER, KEY_ALL, KEY_ACTIVE, KEY_ENDED, KEY_ENDED_BACKFILL,
  itemKey, senderIndexKey, parseNotificationSettings, effectiveVisibility, normalizeReadScope, readScopeCovers,
  DEFAULT_NOTIFICATION_SETTINGS, GENERIC_TITLE,
} from '../dist/notifications/index.js';
import {
  Authorizer, GrantStore, GrantError, ClientSessionStore, CLIENT_SESSION_PREFIX,
} from '../dist/auth/index.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-notif-p5-'));
const server = new KvServer();
let redis;
let clock = 1_900_000_000_000;
const now = () => clock;
const DAY = 86_400_000;

const apps = new Map([
  ['com.example.a', { permissions: ['system.notifications', 'notifications.read'], scope: 'user' }],
  ['com.example.b', { permissions: ['system.notifications'], scope: 'user' }],
  ['com.example.c', { permissions: ['system.notifications'], scope: 'user' }],
]);
const inst = (appId) => ({ kind: 'instance', appId, instanceId: `${appId}-1`, verification: 'verified' });
const A = inst('com.example.a');
const B = inst('com.example.b');
const C = inst('com.example.c');
const ANON = { kind: 'anonymous', verification: 'unverified' };
const screen = (lock) => ({ principal: ANON, screen: { sid: 'test', lock } });
const LOCKED = screen('locked');
const UNLOCKED = screen('unlocked');

let grants, authz, svc;
let settings = DEFAULT_NOTIFICATION_SETTINGS;

before(async () => {
  const uri = await server.start({ dataDir: DATA_DIR });
  redis = createRedis(uri);
  grants = new GrantStore(() => redis, now);
  authz = new Authorizer({ grants, declared: (id) => apps.get(id)?.permissions, appScope: (id) => apps.get(id)?.scope });
  svc = new NotificationService({ redis, now, authorizer: authz, settings: () => settings });
});

after(async () => {
  redis?.disconnect();
  await server.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

async function rejectsStatus(p, status, re) {
  await assert.rejects(p, (err) => err instanceof NotificationError && err.status === status && (!re || re.test(err.message)));
}

const BY = { kind: 'system' };

// ---------------------------------------------------------------------------
// Client sessions
// ---------------------------------------------------------------------------

test('client sessions: register / lock / unlock / heartbeat; unknown, forged, missing and expired → locked', async () => {
  let t = 1_000_000;
  const cs = new ClientSessionStore({ redis: () => redis, now: () => t, ttlMs: 90_000 });
  const s = await cs.register({ lock: 'unlocked' });
  assert.match(s.sid, /^cs1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(s.lock, 'unlocked');
  assert.equal(s.ttlMs, 90_000);
  assert.equal(await cs.effectiveLock(s.sid), 'unlocked');

  assert.equal((await cs.lock(s.sid)).lock, 'locked');
  assert.equal(await cs.effectiveLock(s.sid), 'locked');
  assert.equal((await cs.unlock(s.sid)).lock, 'unlocked');
  assert.equal((await cs.heartbeat(s.sid, { lock: 'locked' })).lock, 'locked', 'a heartbeat re-syncs the state');
  assert.equal((await cs.heartbeat(s.sid, { lock: 'unlocked' })).lock, 'unlocked');

  for (const bad of [undefined, null, '', 'garbage', `cs1.${'A'.repeat(22)}.${'B'.repeat(22)}`]) {
    assert.equal(await cs.effectiveLock(bad), 'locked', `sid ${String(bad)}`);
  }
  // A forged signature on a real client id is refused without a lookup.
  const [, cid] = s.sid.split('.');
  const forged = `cs1.${cid}.${'x'.repeat(22)}`;
  assert.equal(await cs.effectiveLock(forged), 'locked');
  assert.equal(await cs.unlock(forged), null);
  assert.equal(await cs.heartbeat('nope'), null);

  // Expiry: past the TTL by our clock → locked, even if Valkey still has the key.
  t += 89_000;
  assert.equal(await cs.effectiveLock(s.sid), 'unlocked');
  await cs.heartbeat(s.sid);
  t += 89_000;
  assert.equal(await cs.effectiveLock(s.sid), 'unlocked', 'the heartbeat extended it');
  t += 2_000;
  assert.equal(await cs.effectiveLock(s.sid), 'locked', 'expired → locked');
  // Valkey's own PX expiry also applies.
  assert.ok((await redis.pttl(CLIENT_SESSION_PREFIX + cid)) <= 90_000);

  assert.equal(await cs.end(s.sid), true);
  assert.equal(await cs.heartbeat(s.sid), null, 'ended → unknown');
});

test('client sessions: the UnlockVerifier hook decides every unlock (default: allow)', async () => {
  const cs = new ClientSessionStore({ redis: () => redis });
  const calls = [];
  cs.setUnlockVerifier({ verify: (req) => { calls.push(req); return { allow: req.proof === '1234', reason: 'PIN required' }; } });
  const s = await cs.register({ lock: 'unlocked' });
  assert.equal(s.lock, 'locked', 'register as unlocked without proof → locked');
  assert.equal(s.unlockRefused, 'PIN required');
  const refused = await cs.unlock(s.sid);
  assert.equal(refused.lock, 'locked');
  assert.equal(refused.unlockRefused, 'PIN required');
  assert.equal((await cs.unlock(s.sid, '1234')).lock, 'unlocked');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => typeof c.clientId === 'string'));
  // Locking never asks.
  assert.equal((await cs.lock(s.sid)).lock, 'locked');
  assert.equal(calls.length, 3);
  // A throwing verifier refuses.
  cs.setUnlockVerifier({ verify: () => { throw new Error('boom'); } });
  assert.equal((await cs.unlock(s.sid)).lock, 'locked');
  cs.setUnlockVerifier(undefined);
  assert.equal((await cs.unlock(s.sid)).lock, 'unlocked');
});

// ---------------------------------------------------------------------------
// Redaction matrix
// ---------------------------------------------------------------------------

async function seedVisibility() {
  const comps = [{ kind: 'button', id: 'ok', label: 'OK', variant: 'primary' }];
  const pub = (await svc.create({ title: 'PUB title', text: 'pub text', visibility: 'public', components: comps, image: 'https://x/i.png' }, B)).notification;
  const priv = (await svc.create({ title: 'PRIV title', text: 'priv text', components: comps, context: { kind: 'task', id: 't1', label: 'secret label' } }, B)).notification;
  const privPub = (await svc.create({ title: 'PRIV2', text: 'x', visibility: 'private', publicTitle: 'Build done', publicText: 'see details' }, B)).notification;
  const sec = (await svc.create({ title: 'SEC title', text: 'sec text', visibility: 'secret' }, B)).notification;
  await svc.interact(pub.id, { componentId: 'ok' });
  return { pub, priv, privPub, sec };
}

test('redaction: locked screen → public without components, private redacted, secret absent; unlocked → full', async () => {
  settings = DEFAULT_NOTIFICATION_SETTINGS;
  const { pub, priv, privPub, sec } = await seedVisibility();

  const p = await svc.get(pub.id, LOCKED);
  assert.equal(p.title, 'PUB title');
  assert.equal(p.text, 'pub text');
  assert.equal(p.lockscreen, true);
  assert.equal(p.redacted, undefined);
  assert.equal(p.components, undefined);
  assert.equal(p.lastInteraction, undefined);
  assert.deepEqual(p.history, []);
  assert.deepEqual(p.caller, { kind: 'anonymous', verification: 'unverified' });

  const r = await svc.get(priv.id, LOCKED);
  assert.equal(r.redacted, true);
  assert.equal(r.lockscreen, true);
  assert.equal(r.title, GENERIC_TITLE);
  assert.equal(r.text, '');
  assert.equal(r.components, undefined);
  assert.equal(r.context, undefined);
  assert.equal(r.image, undefined);
  assert.deepEqual(r.history, []);
  assert.deepEqual(r.sender, { kind: 'app', id: 'com.example.b', attribution: 'verified' });
  assert.equal(JSON.stringify(r).includes('priv text'), false);
  assert.equal(JSON.stringify(r).includes('secret label'), false);

  const r2 = await svc.get(privPub.id, LOCKED);
  assert.equal(r2.title, 'Build done');
  assert.equal(r2.text, 'see details');

  assert.equal(await svc.get(sec.id, LOCKED), null, 'secret → 404');
  const lockedIds = (await svc.list({ state: 'active', limit: 200 }, LOCKED)).items.map((n) => n.id);
  assert.ok(lockedIds.includes(pub.id) && lockedIds.includes(priv.id));
  assert.equal(lockedIds.includes(sec.id), false, 'secret not listed (and so not counted)');

  // Unlocked: everything in full.
  const u = await svc.get(priv.id, UNLOCKED);
  assert.equal(u.text, 'priv text');
  assert.equal(u.redacted, undefined);
  assert.equal(u.components.length, 1);
  assert.equal((await svc.get(sec.id, UNLOCKED)).text, 'sec text');
  assert.ok((await svc.get(pub.id, UNLOCKED)).lastInteraction);

  // No client session at all → nothing.
  assert.equal(await svc.get(pub.id, ANON), null);
  assert.equal(await svc.get(pub.id, { principal: ANON }), null);
  assert.deepEqual((await svc.list({}, ANON)).items, []);
  // waitFor follows the same view.
  assert.equal(await svc.waitFor(sec.id, LOCKED, { timeoutMs: 0 }), null);
  assert.equal((await svc.waitFor(priv.id, LOCKED, { timeoutMs: 0 })).notification.redacted, true);
  // The sender itself always gets the full item.
  assert.equal((await svc.get(priv.id, B)).text, 'priv text');
});

test('redaction: the user override is the STRICTER level; hideAll hides everything', async () => {
  const { pub, priv } = await seedVisibility();
  settings = parseNotificationSettings({ lockscreen: { apps: { 'com.example.b': 'private' } } });
  assert.equal((await svc.get(pub.id, LOCKED)).redacted, true, 'public → private by override');
  settings = parseNotificationSettings({ lockscreen: { apps: { 'app:com.example.b': 'secret' } } });
  assert.equal(await svc.get(pub.id, LOCKED), null, 'public → secret by override');
  assert.equal(await svc.get(priv.id, LOCKED), null);
  settings = parseNotificationSettings({ lockscreen: { apps: { 'com.example.b': 'public' } } });
  assert.equal((await svc.get(priv.id, LOCKED)).redacted, true, 'an override never makes a sender label LESS strict');
  settings = parseNotificationSettings({ lockscreen: { hideAll: true } });
  assert.equal(await svc.get(pub.id, LOCKED), null);
  assert.deepEqual((await svc.list({ state: 'active', limit: 200 }, LOCKED)).items, []);
  assert.equal((await svc.get(priv.id, UNLOCKED)).text, 'priv text', 'overrides are lock-screen only');
  assert.equal((await svc.get(pub.id, B)).text, 'pub text');
  settings = DEFAULT_NOTIFICATION_SETTINGS;

  const ls = { hideAll: false, apps: { 'app:x': 'secret' } };
  assert.equal(effectiveVisibility({ visibility: 'public', senderKey: 'app:x' }, ls), 'secret');
  assert.equal(effectiveVisibility({ visibility: 'secret', senderKey: 'app:y' }, ls), 'secret');
  assert.equal(effectiveVisibility({ visibility: 'bogus', senderKey: 'app:y' }, ls), 'private');
});

// ---------------------------------------------------------------------------
// Read access (notifications.read)
// ---------------------------------------------------------------------------

test('read access: own items always; others only with a scoped notifications.read grant (requested + granted)', async () => {
  settings = DEFAULT_NOTIFICATION_SETTINGS;
  const own = (await svc.create({ title: 'A own', visibility: 'secret' }, A)).notification;
  const b = (await svc.create({ title: 'B pub', visibility: 'public' }, B)).notification;
  const bSecret = (await svc.create({ title: 'B secret', visibility: 'secret' }, B)).notification;
  const c = (await svc.create({ title: 'C priv' }, C)).notification;
  const listIds = async (v) => (await svc.list({ state: 'active', limit: 200 }, v)).items.map((n) => n.id);

  assert.equal((await svc.get(own.id, A)).title, 'A own', 'own secret items are always readable');
  assert.equal(await svc.get(b.id, A), null, 'public never grants read access');
  assert.ok((await listIds(A)).every((id) => id !== b.id && id !== c.id));

  await assert.rejects(grants.grant({ kind: 'app', id: 'com.example.a' }, 'notifications.read', { by: BY }), GrantError, 'a read grant needs a scope');
  await grants.grant({ kind: 'app', id: 'com.example.a' }, 'notifications.read', { by: BY, appScope: 'user', read: { scope: 'app:com.example.b' } });
  assert.equal((await svc.get(b.id, A)).title, 'B pub');
  assert.equal(await svc.get(bSecret.id, A), null, 'secret needs includeSecret');
  assert.equal(await svc.get(c.id, A), null, 'outside the scope');
  let ids = await listIds(A);
  assert.ok(ids.includes(own.id) && ids.includes(b.id) && !ids.includes(bSecret.id) && !ids.includes(c.id));
  assert.equal((await svc.list({ sender: 'app:com.example.b', state: 'active', limit: 200 }, A)).items.some((n) => n.id === b.id), true);

  await grants.grant({ kind: 'app', id: 'com.example.a' }, 'notifications.read', { by: BY, appScope: 'user', read: { scope: { senders: ['app:com.example.b'] }, includeSecret: true } });
  assert.equal((await svc.get(bSecret.id, A)).title, 'B secret');
  await grants.grant({ kind: 'app', id: 'com.example.a' }, 'notifications.read', { by: BY, appScope: 'user', read: { scope: 'all' } });
  assert.equal((await svc.get(c.id, A)).title, 'C priv');
  assert.equal(await svc.get(bSecret.id, A), null);

  // Readers get interaction results too (explicit reader), but may not act as the user on others' items.
  await rejectsStatus(svc.dismiss(c.id, undefined, A), 403, /does not allow changing/);
  await rejectsStatus(svc.markSeen(bSecret.id, undefined, A), 404);

  // The manifest must REQUEST it: C has a grant but no request → nothing.
  await grants.grant({ kind: 'app', id: 'com.example.c' }, 'notifications.read', { by: BY, appScope: 'user', read: { scope: '*' } });
  assert.equal(await svc.get(b.id, C), null);
  await grants.revoke({ kind: 'app', id: 'com.example.c' }, 'notifications.read');

  // Revoke → back to own only, at once.
  await grants.revoke({ kind: 'app', id: 'com.example.a' }, 'notifications.read');
  assert.equal(await svc.get(c.id, A), null);
  ids = await listIds(A);
  assert.ok(ids.includes(own.id) && !ids.includes(b.id));

  // API keys: a grant to the key.
  const KEY = { kind: 'apiKey', keyId: 'k1', name: 'ci', scopes: ['system.notifications'], verification: 'verified' };
  assert.equal(await svc.get(b.id, KEY), null);
  await grants.grant({ kind: 'apiKey', id: 'k1' }, 'notifications.read', { by: BY, read: { scope: { apps: ['com.example.b'] } } });
  assert.equal((await svc.get(b.id, KEY)).title, 'B pub');
  await grants.revoke({ kind: 'apiKey', id: 'k1' }, 'notifications.read');
});

test('read scopes: parse CLI / object forms; coverage', () => {
  assert.equal(normalizeReadScope('all'), '*');
  assert.equal(normalizeReadScope({ all: true }), '*');
  assert.deepEqual(normalizeReadScope('app:com.x,sender:auraos,app:com.x'), { apps: ['com.x'], senders: ['auraos'] });
  assert.throws(() => normalizeReadScope('nope'));
  assert.throws(() => normalizeReadScope({}));
  assert.throws(() => normalizeReadScope({ apps: ['bad id!'] }));
  assert.equal(readScopeCovers({ apps: ['com.x'] }, 'app:com.x'), true);
  assert.equal(readScopeCovers({ apps: ['com.x'] }, 'anon:com.x'), false, 'unverified hints are not the app');
  assert.equal(readScopeCovers({ senders: ['anon:rest'] }, 'anon:rest'), true);
  assert.equal(readScopeCovers('*', 'key:abc'), true);
});

// ---------------------------------------------------------------------------
// User ops
// ---------------------------------------------------------------------------

test('user ops: no session → 404; locked screen → only displayed/seen (redacted reply); unlocked → full', async () => {
  settings = DEFAULT_NOTIFICATION_SETTINGS;
  const n = (await svc.create({ title: 'op', text: 'body', type: 'dialogue', components: [{ kind: 'input', id: 'q' }] }, B)).notification;
  const sec = (await svc.create({ title: 's', visibility: 'secret' }, B)).notification;

  await rejectsStatus(svc.markSeen(n.id, undefined, ANON), 404);
  await rejectsStatus(svc.dismiss(n.id, undefined, ANON), 404);
  await rejectsStatus(svc.clear({}, undefined, ANON), 403);
  await rejectsStatus(svc.clearHistory({}, ANON), 403);

  const seen = await svc.markSeen(n.id, undefined, LOCKED);
  assert.equal(seen.redacted, true);
  assert.equal(seen.text, '');
  await rejectsStatus(svc.markSeen(sec.id, undefined, LOCKED), 404, /not found/);
  await rejectsStatus(svc.resolve(n.id, { ok: 1 }, undefined, LOCKED), 403, /unlock first/);
  await rejectsStatus(svc.interact(n.id, { componentId: 'q', value: 'x' }, undefined, LOCKED), 403);
  await rejectsStatus(svc.dismiss(n.id, undefined, LOCKED), 403);
  await rejectsStatus(svc.forceRemove(n.id, undefined, LOCKED), 403);
  await rejectsStatus(svc.clear({}, undefined, LOCKED), 403, /unlock first/);

  const it = await svc.interact(n.id, { componentId: 'q', value: 'hi' }, undefined, UNLOCKED);
  assert.equal(it.lastInteraction.value, 'hi');
  const res = await svc.resolve(n.id, { ok: 1 }, undefined, UNLOCKED);
  assert.deepEqual(res.answer, { ok: 1 });
  assert.equal(res.text, 'body');

  // An app acts as "user" only on its own items; clear is scoped to them.
  const own = (await svc.create({ title: 'mine' }, C)).notification;
  const other = (await svc.create({ title: 'theirs' }, B)).notification;
  const r = await svc.clear({}, undefined, C);
  assert.ok(r.cleared >= 1);
  assert.equal((await svc.get(own.id)).state, 'removed');
  assert.equal((await svc.get(other.id)).state, 'active');
  await svc.forceRemove(other.id);
  await svc.forceRemove(sec.id);
});

test('senderToken proves ownership of ONE item for get / waitFor (browser senders)', async () => {
  const { notification: n, senderToken } = await svc.create({ title: 'tok', text: 'body' }, ANON);
  assert.equal(await svc.get(n.id, { principal: ANON }), null);
  const got = await svc.get(n.id, { principal: ANON, senderToken });
  assert.equal(got.text, 'body');
  assert.equal(await svc.get(n.id, { principal: ANON, senderToken: 'nst_wrong' }), null);
  const w = await svc.waitFor(n.id, { principal: ANON, senderToken }, { timeoutMs: 0 });
  assert.equal(w.notification.text, 'body');
  await svc.forceRemove(n.id);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test('retention: ended items older than the period are deleted with their history and every index entry; active stays; per-app forever', async () => {
  settings = parseNotificationSettings({ retention: { days: 1, apps: { 'com.example.c': 'forever' } } });
  const s2 = new NotificationService({ redis, now, settings: () => settings });
  const old = (await s2.create({ title: 'old' }, B)).notification;
  await s2.dismiss(old.id);
  const answered = (await s2.create({ title: 'answered', type: 'dialogue' }, B)).notification;
  await s2.resolve(answered.id, { yes: true });
  const keepC = (await s2.create({ title: 'keep C' }, C)).notification;
  await s2.dismiss(keepC.id);
  const active = (await s2.create({ title: 'still active' }, B)).notification;
  assert.ok(await redis.zscore(KEY_ENDED, old.id), 'ended items are indexed on removal');
  assert.ok(await redis.zscore(KEY_ENDED, answered.id), '… and on resolve');
  assert.equal(await redis.zscore(KEY_ENDED, active.id), null);

  clock += DAY / 2;
  assert.equal((await s2.sweepRetention()).deleted, 0, 'not old enough yet');
  clock += DAY;
  const r = await s2.sweepRetention();
  assert.ok(r.deleted >= 2);
  for (const id of [old.id, answered.id]) {
    assert.equal(await redis.get(itemKey(id)), null);
    assert.equal(await redis.zscore(KEY_ALL, id), null);
    assert.equal(await redis.zscore(KEY_ENDED, id), null);
    assert.equal(await redis.zscore(senderIndexKey('app:com.example.b'), id), null);
    assert.equal(await s2.get(id), null);
  }
  assert.equal((await s2.get(keepC.id)).state, 'removed', 'C keeps its history forever');
  assert.equal((await s2.get(active.id)).state, 'active', 'active items are never auto-deleted');
  assert.ok(await redis.zscore(KEY_ACTIVE, active.id));

  settings = parseNotificationSettings({ retention: { days: 'forever' } });
  await s2.dismiss(active.id);
  clock += 100 * DAY;
  assert.equal((await s2.sweepRetention()).deleted, 0, 'forever keeps everything');
  assert.ok(await s2.get(active.id));
});

test('retention: the first pass backfills the ended index from pre-phase-5 items (removedAt / resolvedAt)', async () => {
  settings = parseNotificationSettings({ retention: { days: 2 } });
  const s3 = new NotificationService({ redis, now, settings: () => settings });
  const a = (await s3.create({ title: 'legacy removed' }, B)).notification;
  await s3.dismiss(a.id);
  const b = (await s3.create({ title: 'legacy resolved', type: 'dialogue' }, B)).notification;
  await s3.resolve(b.id, 'ok');
  // Simulate records written before phase 5: not in the ended index, no backfill marker.
  await redis.zrem(KEY_ENDED, a.id, b.id);
  await redis.del(KEY_ENDED_BACKFILL);
  clock += 3 * DAY;
  const r = await s3.sweepRetention();
  assert.ok(r.backfilled >= 2, `backfilled ${r.backfilled}`);
  assert.ok(r.deleted >= 2);
  assert.equal(await redis.get(itemKey(a.id)), null);
  assert.equal(await redis.get(itemKey(b.id)), null);
  assert.equal(await redis.get(KEY_ENDED_BACKFILL), '1');
  assert.equal((await s3.sweepRetention()).backfilled, null, 'only once');
});

test('clear history: deletes ended items now (optionally per sender), never active ones', async () => {
  settings = DEFAULT_NOTIFICATION_SETTINGS;
  const e1 = (await svc.create({ title: 'h1' }, B)).notification;
  await svc.dismiss(e1.id);
  const e2 = (await svc.create({ title: 'h2' }, C)).notification;
  await svc.dismiss(e2.id);
  const act = (await svc.create({ title: 'h3' }, B)).notification;
  const r = await svc.clearHistory({ sender: 'app:com.example.b' }, UNLOCKED);
  assert.ok(r.deleted >= 1);
  assert.equal(await svc.get(e1.id), null);
  assert.equal((await svc.get(e2.id)).state, 'removed', 'other senders untouched');
  assert.equal((await svc.get(act.id)).state, 'active');
  await rejectsStatus(svc.clearHistory({}, LOCKED), 403);
  await rejectsStatus(svc.clearHistory({ sender: 'bad sender!' }, UNLOCKED), 400);
  const all = await svc.clearHistory({}, UNLOCKED);
  assert.ok(all.deleted >= 1);
  assert.equal(await svc.get(e2.id), null);
  await svc.forceRemove(act.id);
});

test('list prunes index entries whose item is gone', async () => {
  const n = (await svc.create({ title: 'dangling' }, B)).notification;
  await redis.del(itemKey(n.id));
  const ids = (await svc.list({ state: 'all', limit: 200 })).items.map((x) => x.id);
  assert.equal(ids.includes(n.id), false);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await redis.zscore(KEY_ALL, n.id), null);
  assert.equal(await redis.zscore(KEY_ACTIVE, n.id), null);
});

test('settings: lenient parse, clamps 1–90 days, forever, bare app ids', () => {
  assert.deepEqual(parseNotificationSettings(undefined), DEFAULT_NOTIFICATION_SETTINGS);
  assert.deepEqual(parseNotificationSettings('junk'), DEFAULT_NOTIFICATION_SETTINGS);
  const s = parseNotificationSettings({
    lockscreen: { hideAll: 'yes', apps: { 'com.x': 'secret', 'auraos': 'public', 'key:abc': 'nope' } },
    retention: { days: 500, apps: { 'com.y': 0, 'com.z': '30', 'com.w': 'x' } },
  });
  assert.equal(s.lockscreen.hideAll, false, 'only a real true');
  assert.deepEqual(s.lockscreen.apps, { 'app:com.x': 'secret', auraos: 'public' });
  assert.equal(s.retention.days, 90);
  assert.deepEqual(s.retention.apps, { 'app:com.y': 'forever', 'app:com.z': 30 });
  assert.equal(parseNotificationSettings({ retention: { days: 0.2 } }).retention.days, 1);
  assert.equal(parseNotificationSettings({ retention: { days: 'forever' } }).retention.days, 'forever');
});

test('system and in-process reads stay full', async () => {
  const n = (await svc.create({ title: 'sys', visibility: 'secret' }, SYSTEM_CALLER)).notification;
  assert.equal((await svc.get(n.id)).title, 'sys');
  assert.equal((await svc.get(n.id, SYSTEM_CALLER)).title, 'sys');
  assert.equal(await svc.get(n.id, { kind: 'system', verification: 'internal' }), null, 'a look-alike reads nothing');
  await svc.forceRemove(n.id);
});
