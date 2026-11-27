// Core auth (phase 2) against a REAL valkey-server (KvServer on a tmp dataDir).
//
//   pnpm --filter @aura/core test
//
// Covers: the Authorizer matrix, grants / revokes taking effect live in the
// NotificationService (downgrade ↔ accepted, no restart), `system.notifications`
// enforcement, ownership + read scoping, API keys (create / verify / revoke),
// the owner's attribution (D50: no shared admin credential), the audit stream,
// the rate limit, waitFor, and that a declared actor name never changes a result.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, KvClient, createRedis } from '@aura/kv-store';
import {
  Authorizer, GrantStore, ApiKeyStore, AdminAudit,
  SYSTEM_PRINCIPAL, PRIVILEGED_PERMISSIONS, GrantError, ApiKeyError,
  userAttribution, operatorAttribution, API_KEY_PATTERN, terminalSessionScope,
} from '../dist/auth/index.js';
import { NotificationService, NotificationError } from '../dist/notifications/index.js';
import { ENFORCED_PERMISSIONS } from '../dist/permissions/PermissionManager.js';
import { OsEventBus } from '../dist/ipc/OsEventBus.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-auth-'));
const server = new KvServer();
let redis;
let clock = 1_800_000_000_000;
const now = () => clock;

// A fake registry: app → { permissions, scope }.
const apps = new Map([
  ['com.example.basic', { permissions: ['system.notifications'], scope: 'user' }],
  ['com.example.priv', { permissions: ['system.notifications', 'notifications.locked', 'notifications.popup'], scope: 'user' }],
  ['com.example.mute', { permissions: [], scope: 'user' }],
  ['com.example.other', { permissions: ['system.notifications'], scope: 'user' }],
  // Phase 6 rename: a manifest that still requests the deprecated name.
  ['com.example.legacy', { permissions: ['system.notifications', 'notifications.desktopModal'], scope: 'user' }],
  // D25: an app that requests the owner's Terminal grants.
  ['com.example.embedder', { permissions: ['terminal.embed', 'terminal.sessions.list', 'terminal.screen.read'], scope: 'user' }],
  // Phase 3: an app that declares an OS-wide KV write.
  ['com.example.themer', { permissions: ['system.kv.os.theme.write'], scope: 'user' }],
]);
const inst = (appId, n = 1) => ({ kind: 'instance', appId, instanceId: `${appId}-${n}`, verification: 'verified' });
const ANON = { kind: 'anonymous', verification: 'unverified' };
const OWNER = { kind: 'user', userId: 'default', role: 'owner', sessionId: '0123456789abcdef', verification: 'verified' };

let grants, keys, authz, svc, audit;

before(async () => {
  const uri = await server.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
  const r = () => redis;
  grants = new GrantStore(r, now);
  keys = new ApiKeyStore(r, now);
  audit = new AdminAudit(r, now);
  authz = new Authorizer({
    grants,
    declared: (id) => apps.get(id)?.permissions,
    appScope: (id) => apps.get(id)?.scope,
  });
  svc = new NotificationService({ redis, now, authorizer: authz });
});

after(async () => {
  redis?.disconnect();
  await server.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

async function rejectsStatus(p, status, re) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof NotificationError, `expected NotificationError, got ${err}`);
    assert.equal(err.status, status, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

const by = userAttribution(OWNER);

// ---------------------------------------------------------------------------
// Authorizer matrix
// ---------------------------------------------------------------------------

test('Authorizer matrix: system / owner / instance / apiKey / anonymous', async () => {
  const a = (p, act) => authz.authorize(p, act).then((d) => d.allow);
  // system: everything; a JSON look-alike: nothing
  assert.equal(await a(SYSTEM_PRINCIPAL, 'notifications.locked'), true);
  assert.equal(await a(SYSTEM_PRINCIPAL, 'admin.grants'), true);
  const fake = JSON.parse(JSON.stringify(SYSTEM_PRINCIPAL));
  assert.equal(await a(fake, 'system.notifications'), false);
  // the owner is not a sender, and `admin.*` is nobody's permission (D50: the routes decide)
  assert.equal(await a(OWNER, 'system.notifications'), false);
  assert.equal(await a(OWNER, 'notifications.locked'), false);
  for (const p of [OWNER, inst('com.example.priv'), ANON]) assert.equal(await a(p, 'admin.grants'), false);
  // instance: declared system.notifications is enough; not declared → deny (enforced)
  assert.equal(await a(inst('com.example.basic'), 'system.notifications'), true);
  assert.equal(await a(inst('com.example.mute'), 'system.notifications'), false);
  assert.equal(await a(inst('com.example.unknown'), 'system.notifications'), false);
  // privileged: declared but not granted → deny; not declared → deny even if granted
  assert.equal(await a(inst('com.example.priv'), 'notifications.locked'), false);
  await grants.grant({ kind: 'app', id: 'com.example.basic' }, 'notifications.locked', { by, appScope: 'user' });
  assert.equal(await a(inst('com.example.basic'), 'notifications.locked'), false, 'granted but not requested');
  await grants.revoke({ kind: 'app', id: 'com.example.basic' }, 'notifications.locked');
  // anonymous: basic only
  assert.equal(await a(ANON, 'system.notifications'), true);
  assert.equal(await a(ANON, 'notifications.locked'), false);
  assert.equal(await a(ANON, 'notifications.popup'), false);
  // non-enforced permissions keep the MVP auto-grant for apps
  assert.equal(await a(inst('com.example.mute'), 'storage.read'), true);
  // the notification permissions are enforced
  for (const p of ['system.notifications', ...PRIVILEGED_PERMISSIONS]) assert.ok(ENFORCED_PERMISSIONS.includes(p), p);
});

test('a refusal says what is missing (missing), for the structured answer; an allow carries none', async () => {
  const m = (p, act) => authz.authorize(p, act).then((d) => (d.allow ? 'allow' : d.missing));
  assert.equal(await m(inst('com.example.mute'), 'system.notifications'), 'declaration', 'enforced, not declared');
  assert.equal(await m(inst('com.example.basic'), 'notifications.locked'), 'declaration', 'privileged, not requested');
  assert.equal(await m(inst('com.example.priv'), 'notifications.locked'), 'grant', 'requested, not granted');
  assert.equal(await m(inst('com.example.unknown'), 'system.notifications'), 'unknown-app');
  assert.equal(await m(ANON, 'notifications.locked'), 'verified-caller');
  for (const p of [OWNER, inst('com.example.priv'), ANON]) assert.equal(await m(p, 'admin.grants'), 'not-grantable');
  assert.equal(await m(JSON.parse(JSON.stringify(SYSTEM_PRINCIPAL)), 'system.notifications'), 'not-grantable');
  assert.equal(await m(inst('com.example.basic'), 'system.notifications'), 'allow');
  assert.equal((await authz.authorize(inst('com.example.basic'), 'system.notifications')).missing, undefined);
});

test('a declared actor name never changes a decision', async () => {
  const names = ['admin', 'root', 'system', 'AuraOS', 'com.example.priv', 'claude'];
  for (const p of [inst('com.example.basic'), inst('com.example.mute'), inst('com.example.priv'), ANON, OWNER]) {
    for (const action of ['system.notifications', 'notifications.locked', 'notifications.popup', 'admin.grants']) {
      const base = await authz.authorize(p, action);
      for (const name of names) {
        const withActor = await authz.authorize({ ...p, actor: { name, verification: 'unverified' } }, action);
        assert.equal(withActor.allow, base.allow, `${p.kind}/${p.appId ?? ''} ${action} as '${name}'`);
      }
    }
  }
});

test('GrantStore: validation, idempotence, listing, permissions:changed events', async () => {
  const seen = [];
  const fn = (ev) => seen.push(ev);
  OsEventBus.on('permissions:changed', fn);
  try {
    const s = { kind: 'app', id: 'com.example.priv' };
    await assert.rejects(grants.grant(s, 'apps.mount', { by }), (e) => e instanceof GrantError && e.status === 400);
    await assert.rejects(grants.grant({ kind: 'user', id: 'x' }, 'notifications.locked', { by }), GrantError);
    await assert.rejects(grants.grant({ kind: 'app', id: '../evil' }, 'notifications.locked', { by }), GrantError);
    const g1 = await grants.grant(s, 'notifications.popup', { by, appScope: 'user' });
    assert.equal(g1.changed, true);
    assert.deepEqual(g1.record.scope, { kind: 'os' });
    assert.deepEqual(g1.record.grantedBy, by);
    const g2 = await grants.grant(s, 'notifications.popup', { by, appScope: 'user' });
    assert.equal(g2.changed, false);
    assert.equal((await grants.listFor(s)).length, 1);
    assert.ok((await grants.listAll()).some((g) => g.subject.id === 'com.example.priv'));
    assert.ok(await grants.revoke(s, 'notifications.popup'));
    assert.equal(await grants.revoke(s, 'notifications.popup'), null);
    assert.deepEqual(seen, [
      { subjectKind: 'app', subjectId: 'com.example.priv', permission: 'notifications.popup', change: 'granted' },
      { subjectKind: 'app', subjectId: 'com.example.priv', permission: 'notifications.popup', change: 'revoked' },
    ]);
    // grant:* is unreachable through the public KV namespaces
    const c = new KvClient(server.getUri());
    try { await assert.rejects(() => c.get('grant', 'app'), /invalid namespace/); } finally { await c.close(); }
  } finally {
    OsEventBus.off('permissions:changed', fn);
  }
});

// ---------------------------------------------------------------------------
// Notification enforcement (live grants)
// ---------------------------------------------------------------------------

test('system.notifications is enforced: 403 without it, ok when declared', async () => {
  await rejectsStatus(svc.create({ title: 'nope' }, inst('com.example.mute')), 403, /system\.notifications/);
  const { notification: n } = await svc.create({ title: 'yes' }, inst('com.example.basic'));
  assert.equal(n.sender.attribution, 'verified');
  // anonymous keeps phase-1 behaviour (unverified Simple)
  const a = await svc.create({ title: 'anon', type: 'locked' }, ANON);
  assert.equal(a.notification.type, 'simple');
  assert.equal(a.notification.sender.attribution, 'unverified');
  // the owner reads, it does not send
  await rejectsStatus(svc.create({ title: 'owner' }, OWNER), 403, /owner/);
});

test('privileged features: downgraded until granted, accepted at once, downgraded again after revoke', async () => {
  const P = inst('com.example.priv');
  const s = { kind: 'app', id: 'com.example.priv' };
  const lockedReq = { title: 'L', type: 'locked' };
  const popReq = { title: 'P', type: 'dialogue', popup: true };

  let r = await svc.create(lockedReq, P);
  assert.equal(r.notification.type, 'simple');
  assert.match(r.warnings.find((w) => w.field === 'type').message, /not granted/);
  r = await svc.create(popReq, P);
  assert.equal(r.notification.popup, false);

  await grants.grant(s, 'notifications.locked', { by, appScope: 'user' });
  await grants.grant(s, 'notifications.popup', { by, appScope: 'user' });
  r = await svc.create(lockedReq, P);
  assert.equal(r.notification.type, 'locked');
  assert.deepEqual(r.warnings, []);
  r = await svc.create(popReq, P);
  assert.equal(r.notification.popup, true);

  // the grant is pinned to the install scope: a shadow from another scope doesn't inherit it
  apps.get('com.example.priv').scope = 'global';
  r = await svc.create(lockedReq, P);
  assert.equal(r.notification.type, 'simple');
  assert.match(r.warnings[0].message, /grant it again/);
  apps.get('com.example.priv').scope = 'user';

  await grants.revoke(s, 'notifications.locked');
  r = await svc.create(lockedReq, P);
  assert.equal(r.notification.type, 'simple');
  r = await svc.create(popReq, P);
  assert.equal(r.notification.popup, true, 'popup still granted');
  await grants.revoke(s, 'notifications.popup');
  // update: popup gated by the authorizer too
  const d = await svc.create({ title: 'D', type: 'dialogue' }, P);
  const u = await svc.update(d.notification.id, { popup: true }, P);
  assert.equal(u.notification.popup, false);
  assert.ok(u.warnings.some((w) => w.code === 'downgraded' && w.field === 'popup'));
});

test('ownership: a verified sender changes only its own notifications', async () => {
  const A = inst('com.example.basic');
  const B = inst('com.example.other');
  const { notification: n, senderToken } = await svc.create({ title: 'mine' }, A);
  await rejectsStatus(svc.update(n.id, { title: 'evil' }, B), 403);
  await rejectsStatus(svc.removeBySender(n.id, B), 403);
  // a different verified sender is refused even with the senderToken
  await rejectsStatus(svc.update(n.id, { title: 'evil' }, B, senderToken), 403, /own/);
  // same app (another instance) ok; anonymous with the token ok (phase 1)
  assert.equal((await svc.update(n.id, { title: 'v2' }, inst('com.example.basic', 2))).notification.title, 'v2');
  assert.equal((await svc.update(n.id, { text: 't' }, ANON, senderToken)).notification.text, 't');
  // a sender whose permission was revoked can't change anything any more
  apps.get('com.example.basic').permissions = [];
  await rejectsStatus(svc.update(n.id, { title: 'v3' }, A), 403);
  apps.get('com.example.basic').permissions = ['system.notifications'];
  const removed = await svc.removeBySender(n.id, A);
  assert.equal(removed.removedReason, 'completed');
});

test('read scoping: verified apps / API keys see only their own; the owner + in-process see all; anonymous without a client session sees nothing (phase 5)', async () => {
  const A = inst('com.example.basic');
  const B = inst('com.example.other');
  const a = (await svc.create({ title: 'A-only' }, A)).notification;
  const b = (await svc.create({ title: 'B-only' }, B)).notification;
  assert.equal(await svc.get(b.id, A), null);
  assert.equal((await svc.get(a.id, A)).id, a.id);
  const la = await svc.list({ state: 'all', limit: 200 }, A);
  assert.ok(la.items.length > 0 && la.items.every((n) => n.senderKey === 'app:com.example.basic'));
  assert.deepEqual((await svc.list({ sender: 'app:com.example.other' }, A)).items, []);
  for (const viewer of [OWNER, undefined]) {
    assert.ok(await svc.get(b.id, viewer));
    const ids = (await svc.list({ state: 'all', limit: 200 }, viewer)).items.map((n) => n.id);
    assert.ok(ids.includes(a.id) && ids.includes(b.id));
  }
  assert.equal(await svc.get(b.id, ANON), null);
  assert.deepEqual((await svc.list({ state: 'all', limit: 200 }, ANON)).items, []);
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

test('API keys: create (shown once, hash stored) → verify → verified sender → revoke → invalid', async () => {
  await assert.rejects(keys.create({ name: 'x', scopes: ['apps.mount'], by }), ApiKeyError);
  await assert.rejects(keys.create({ name: '', scopes: ['system.notifications'], by }), ApiKeyError);
  const { key, apiKey } = await keys.create({ name: 'CI bot', scopes: ['system.notifications'], by });
  assert.match(key, API_KEY_PATTERN);
  const raw = await redis.get(`apikey:${apiKey.id}`);
  assert.equal(raw.includes(key.split('_').slice(3).join('_')), false, 'secret not stored');
  assert.equal('hash' in apiKey, false);

  const rec = await keys.verify(key);
  assert.equal(rec.id, apiKey.id);
  assert.equal(await keys.verify(key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(await keys.verify('aura_k1_nope'), null);
  assert.equal(await keys.verify(''), null);

  const P = { kind: 'apiKey', keyId: rec.id, name: rec.name, scopes: rec.scopes, verification: 'verified' };
  const { notification: n, warnings } = await svc.create({ title: 'from CI', type: 'locked' }, P);
  assert.equal(n.sender.kind, 'rest');
  assert.equal(n.sender.attribution, 'verified');
  assert.equal(n.senderKey, `key:${rec.id}`);
  assert.deepEqual(n.caller, { kind: 'apiKey', keyId: rec.id, name: 'CI bot', verification: 'verified' }, 'no scopes stored');
  assert.equal(n.type, 'simple');
  assert.ok(warnings.some((w) => w.field === 'type'));
  // a grant to the key unlocks locked
  await grants.grant({ kind: 'apiKey', id: rec.id }, 'notifications.locked', { by });
  assert.equal((await svc.create({ title: 'L', type: 'locked' }, P)).notification.type, 'locked');
  // its own only
  assert.equal((await svc.list({ state: 'all' }, P)).items.every((x) => x.senderKey === `key:${rec.id}`), true);
  await rejectsStatus(svc.update(n.id, { title: 'x' }, inst('com.example.basic')), 403);
  assert.equal((await svc.update(n.id, { title: 'ci2' }, P)).notification.title, 'ci2');

  const revoked = await keys.revoke(rec.id);
  assert.equal(typeof revoked.revokedAt, 'number');
  assert.equal(await keys.verify(key), null);
  const listed = await keys.list();
  assert.ok(listed.some((k) => k.id === rec.id && k.revokedAt));
  assert.ok(listed.every((k) => !('hash' in k)));
});

// ---------------------------------------------------------------------------
// Audit (D50: the owner or the operator, never a shared credential)
// ---------------------------------------------------------------------------

test('audit: entries name the owner or the host operator, newest first', async () => {
  await audit.record({ by, action: 'grant', target: 'app:com.example.priv', detail: { permission: 'notifications.locked' } });
  await audit.record({ by: operatorAttribution(), action: 'revoke', target: 'app:com.example.priv', detail: { permission: 'notifications.locked' } });
  const list = await audit.list(10);
  assert.equal(list[0].action, 'revoke');
  assert.equal(list[0].actor, 'operator');
  assert.equal(list[0].session, undefined);
  assert.equal(list[1].actor, 'user:default');
  assert.equal(list[1].session, OWNER.sessionId.slice(0, 8));
  assert.deepEqual(list[1].detail, { permission: 'notifications.locked' });
});

// ---------------------------------------------------------------------------
// Rate limit + waitFor
// ---------------------------------------------------------------------------

test('rate limit: 429 after N creates per minute per sender; system exempt', async () => {
  const limited = new NotificationService({ redis, now, authorizer: authz, createsPerMinute: 3 });
  clock += 120_000;
  const O = inst('com.example.other');
  for (let i = 0; i < 3; i++) await limited.create({ title: `r${i}` }, O);
  await rejectsStatus(limited.create({ title: 'r4' }, O), 429);
  // another sender has its own bucket
  await limited.create({ title: 'ok' }, inst('com.example.basic'));
  await limited.create({ title: 's' }, SYSTEM_PRINCIPAL);
  clock += 60_000;
  await limited.create({ title: 'next minute' }, O);
});

test('waitFor: returns on resolve, times out while pending, is read-scoped', async () => {
  const A = inst('com.example.basic');
  const { notification: n } = await svc.create({ title: 'Q?', type: 'dialogue' }, A);
  const pending = await svc.waitFor(n.id, A, { timeoutMs: 50 });
  assert.equal(pending.timedOut, true);
  assert.equal(pending.notification.state, 'active');
  assert.equal(await svc.waitFor(n.id, inst('com.example.other'), { timeoutMs: 10 }), null, 'not yours');
  const t0 = Date.now();
  const waiting = svc.waitFor(n.id, A, { timeoutMs: 5_000 });
  setTimeout(() => { void svc.resolve(n.id, { choice: 'yes' }); }, 30);
  const done = await waiting;
  assert.equal(done.timedOut, false);
  assert.equal(done.notification.state, 'resolved');
  assert.deepEqual(done.notification.answer, { choice: 'yes' });
  assert.ok(Date.now() - t0 < 2_000, 'woken by the commit, not the poll');
});

test('waitFor until interaction: wakes on the next interact, honours after, still returns on resolve', async () => {
  const A = inst('com.example.basic');
  const comps = [{ kind: 'button', id: 'ping', label: 'Ping' }, { kind: 'input', id: 'note', label: 'Note' }];
  const { notification: n } = await svc.create({ title: 'I?', type: 'dialogue', components: comps }, A);
  const idle = await svc.waitFor(n.id, A, { timeoutMs: 30, until: 'interaction' });
  assert.equal(idle.timedOut, true);
  assert.equal(idle.reason, 'timeout');
  const t0 = Date.now();
  const waiting = svc.waitFor(n.id, A, { timeoutMs: 5_000, until: 'interaction' });
  setTimeout(() => { void svc.interact(n.id, { componentId: 'note', value: 'hi' }); }, 30);
  const got = await waiting;
  assert.equal(got.reason, 'interaction');
  assert.equal(got.timedOut, false);
  assert.equal(got.notification.lastInteraction.componentId, 'note');
  assert.ok(Date.now() - t0 < 2_000, 'woken by the commit');
  const seenAt = got.notification.lastInteraction.at;
  // Without `after` the current interaction is the baseline: no immediate return.
  assert.equal((await svc.waitFor(n.id, A, { timeoutMs: 20, until: 'interaction' })).reason, 'timeout');
  // An older `after` returns the interaction that already happened.
  const caught = await svc.waitFor(n.id, A, { timeoutMs: 0, until: 'interaction', after: seenAt - 1 });
  assert.equal(caught.reason, 'interaction');
  // The default mode ignores interactions.
  assert.equal((await svc.waitFor(n.id, A, { timeoutMs: 0, after: 0 })).reason, 'timeout');
  // Resolving also ends an interaction wait.
  const w2 = svc.waitFor(n.id, A, { timeoutMs: 5_000, until: 'interaction', after: seenAt });
  setTimeout(() => { void svc.resolve(n.id, { outcome: 'submitted' }); }, 20);
  const r = await w2;
  assert.equal(r.reason, 'resolved');
  assert.equal(r.notification.state, 'resolved');
});


// ---------------------------------------------------------------------------
// Phase 6 rename: notifications.desktopModal → notifications.systemModal
// ---------------------------------------------------------------------------

test('rename: stored desktopModal grants migrate to systemModal (subject, scope, pinning kept); old names are aliases', async () => {
  const subject = { kind: 'app', id: 'com.example.legacy' };
  const old = { subject, permission: 'notifications.desktopModal', scope: { kind: 'os' }, appScope: 'user', grantedAt: 1234, grantedBy: { kind: 'system' } };
  await redis.multi().hset('grant:app:com.example.legacy', 'os|notifications.desktopModal', JSON.stringify(old)).sadd('grant:idx', 'grant:app:com.example.legacy').exec();
  // Even before the migration the alias resolves on read.
  assert.equal((await grants.get(subject, 'notifications.systemModal')), null, 'stored under the old field until migrated');
  const moved = await grants.migrateLegacy();
  assert.deepEqual(moved, [{ subject, from: 'notifications.desktopModal', to: 'notifications.systemModal' }]);
  assert.deepEqual(await grants.migrateLegacy(), [], 'idempotent');
  const rec = await grants.get(subject, 'notifications.systemModal');
  assert.equal(rec.permission, 'notifications.systemModal');
  assert.equal(rec.appScope, 'user');
  assert.equal(rec.grantedAt, 1234);
  assert.equal(await redis.hget('grant:app:com.example.legacy', 'os|notifications.desktopModal'), null, 'old field gone');
  assert.equal((await grants.get(subject, 'notifications.desktopModal')).permission, 'notifications.systemModal', 'get() takes the old name too');
  // The manifest still says desktopModal: it counts as systemModal.
  assert.equal((await authz.authorize(inst('com.example.legacy'), 'notifications.systemModal')).allow, true);
  // grant / revoke with the old name act on the new one.
  await grants.revoke(subject, 'notifications.desktopModal');
  assert.equal(await grants.get(subject, 'notifications.systemModal'), null);
  const g = await grants.grant(subject, 'notifications.desktopModal', { by, appScope: 'user' });
  assert.equal(g.record.permission, 'notifications.systemModal');
  assert.ok(PRIVILEGED_PERMISSIONS.includes('notifications.systemModal') && !PRIVILEGED_PERMISSIONS.includes('notifications.desktopModal'));
  assert.ok(ENFORCED_PERMISSIONS.includes('notifications.systemModal') && ENFORCED_PERMISSIONS.includes('notifications.desktopModal'));
  await grants.revoke(subject, 'notifications.systemModal');
});

test('terminal.embed, terminal.sessions.list and terminal.screen.read: requested AND owner-granted, per app, revocable', async () => {
  const BY = userAttribution(OWNER);
  const app = { kind: 'app', id: 'com.example.embedder' };
  for (const perm of ['terminal.embed', 'terminal.sessions.list', 'terminal.screen.read']) {
    assert.ok(PRIVILEGED_PERMISSIONS.includes(perm) && ENFORCED_PERMISSIONS.includes(perm), perm);
    assert.equal((await authz.authorize(inst('com.example.embedder'), perm)).allow, false, `${perm} before the grant`);
    assert.equal((await authz.authorize(inst('com.example.basic'), perm)).allow, false, `${perm} not requested`);
  }
  await grants.grant(app, 'terminal.embed', { by: BY, appScope: 'user' });
  assert.equal((await authz.authorize(inst('com.example.embedder'), 'terminal.embed')).allow, true);
  assert.equal((await authz.authorize(inst('com.example.embedder'), 'terminal.sessions.list')).allow, false, 'listing is separate');
  assert.equal((await authz.authorize(inst('com.example.embedder'), 'terminal.screen.read')).allow, false, 'screen reads are separate');
  await grants.grant(app, 'terminal.screen.read', { by: BY, appScope: 'user' });
  assert.equal((await authz.authorize(inst('com.example.embedder'), 'terminal.screen.read')).allow, true);
  await grants.revoke(app, 'terminal.screen.read');
  assert.equal((await authz.authorize(inst('com.example.embedder'), 'terminal.screen.read')).allow, false);
  // A grant to an app that does not request it does nothing.
  await grants.grant({ kind: 'app', id: 'com.example.basic' }, 'terminal.embed', { by: BY, appScope: 'user' });
  assert.equal((await authz.authorize(inst('com.example.basic'), 'terminal.embed')).allow, false);
  await grants.revoke({ kind: 'app', id: 'com.example.basic' }, 'terminal.embed');
  await grants.revoke(app, 'terminal.embed');
  assert.equal((await authz.authorize(inst('com.example.embedder'), 'terminal.embed')).allow, false);
});

test('a Terminal session grant is its own record, and revoking the app grant drops it', async () => {
  const BY = userAttribution(OWNER);
  const app = { kind: 'app', id: 'com.example.embedder' };
  const s1 = terminalSessionScope('com.aura.terminal-2#a3');
  const s2 = terminalSessionScope('com.aura.terminal-2#a4');
  await grants.grant(app, 'terminal.embed', { by: BY, appScope: 'user' });
  await grants.grant(app, 'terminal.embed', { by: { kind: 'system' }, appScope: 'user', scope: s1 });
  assert.ok(await grants.get(app, 'terminal.embed', s1));
  assert.equal(await grants.get(app, 'terminal.embed', s2), null, 'another session');
  // The OS-wide grant and a session grant are separate fields.
  assert.ok(await grants.get(app, 'terminal.embed'));
  // Only terminal.embed can be scoped to a session, only for an app, only to a session id.
  const refused400 = (p) => assert.rejects(p, (err) => err instanceof GrantError && err.status === 400);
  await refused400(grants.grant(app, 'notifications.locked', { by: BY, scope: s1 }));
  await refused400(grants.grant({ kind: 'apiKey', id: 'k1' }, 'terminal.embed', { by: BY, scope: s1 }));
  await refused400(grants.grant(app, 'terminal.embed', { by: BY, scope: terminalSessionScope('no-session') }));
  await refused400(grants.grant(app, 'terminal.embed', { by: BY, scope: { kind: 'user', id: 'x' } }));
  // Revoking one session leaves the app grant; revoking the app grant leaves nothing.
  await grants.grant(app, 'terminal.embed', { by: { kind: 'system' }, appScope: 'user', scope: s2 });
  await grants.revoke(app, 'terminal.embed', s2);
  assert.equal(await grants.get(app, 'terminal.embed', s2), null);
  assert.ok(await grants.get(app, 'terminal.embed'));
  await grants.revoke(app, 'terminal.embed');
  assert.equal(await grants.get(app, 'terminal.embed', s1), null, 'the session grant went with the app grant');
  assert.deepEqual(await grants.listFor(app), []);
});

test('a Terminal session grant records the instance life it was made in, and nothing else may carry one', async () => {
  const app = { kind: 'app', id: 'com.example.embedder' };
  const s1 = terminalSessionScope('com.aura.terminal-2#a3');
  await grants.grant(app, 'terminal.embed', { by: { kind: 'system' }, appScope: 'user', scope: s1, binding: 'life-1' });
  assert.equal((await grants.get(app, 'terminal.embed', s1)).binding, 'life-1');
  const refused400 = (p) => assert.rejects(p, (err) => err instanceof GrantError && err.status === 400);
  await refused400(grants.grant(app, 'terminal.embed', { by: { kind: 'system' }, binding: 'life-1' }));
  await refused400(grants.grant(app, 'terminal.embed', { by: { kind: 'system' }, scope: s1, binding: 'bad life' }));
  await grants.revokeAll(app);
});

test('an ended Terminal session takes every grant of it along, and nothing else', async () => {
  const BY = userAttribution(OWNER);
  const a = { kind: 'app', id: 'com.example.embedder' };
  const b = { kind: 'app', id: 'com.example.basic' };
  const s1 = terminalSessionScope('com.aura.terminal-2#a3');
  const s2 = terminalSessionScope('com.aura.terminal-3#a1');
  await grants.grant(a, 'terminal.embed', { by: BY, appScope: 'user' });
  await grants.grant(a, 'terminal.embed', { by: { kind: 'system' }, appScope: 'user', scope: s1 });
  await grants.grant(b, 'terminal.embed', { by: { kind: 'system' }, appScope: 'user', scope: s1 });
  await grants.grant(a, 'terminal.embed', { by: { kind: 'system' }, appScope: 'user', scope: s2 });
  const sameId = (id) => (sc) => sc.kind === 'terminal-session' && sc.id === id;
  assert.equal(await grants.revokeScopes('terminal.embed', sameId('com.aura.terminal-2#a3')), 2);
  assert.equal(await grants.get(a, 'terminal.embed', s1), null);
  assert.equal(await grants.get(b, 'terminal.embed', s1), null);
  // A new session under the reused name starts with no grant; the rest stands.
  assert.ok(await grants.get(a, 'terminal.embed', s2));
  assert.ok(await grants.get(a, 'terminal.embed'), 'the app-wide grant is not a session grant');
  // A whole instance.
  assert.equal(await grants.revokeScopes('terminal.embed', (sc) => sc.kind === 'terminal-session' && sc.id.startsWith('com.aura.terminal-3#')), 1);
  await grants.revoke(a, 'terminal.embed');
  assert.deepEqual(await grants.listFor(a), []);
  assert.deepEqual(await grants.listFor(b), []);
});

// ── Phase 3: system.kv.os.<topic>.write needs a grant, not just a declaration ──

test('declaring system.kv.os.<topic>.write grants nothing; the owner\'s grant does', async () => {
  const themer = inst('com.example.themer');
  const subject = { kind: 'app', id: 'com.example.themer' };
  const before = await authz.authorize(themer, 'system.kv.os.theme.write');
  assert.equal(before.allow, false, before.reason);
  assert.match(before.reason, /not granted/);
  // Not requested: a grant alone is nothing.
  assert.equal((await authz.authorize(themer, 'system.kv.os.keymap.write')).allow, false);
  await grants.grant(subject, 'system.kv.os.theme.write', { by, appScope: 'user' });
  assert.equal((await authz.authorize(themer, 'system.kv.os.theme.write')).allow, true);
  await grants.grant(subject, 'system.kv.os.keymap.write', { by, appScope: 'user' });
  assert.equal((await authz.authorize(themer, 'system.kv.os.keymap.write')).allow, false, 'still not requested');
  await grants.revoke(subject, 'system.kv.os.theme.write');
  await grants.revoke(subject, 'system.kv.os.keymap.write');
  assert.equal((await authz.authorize(themer, 'system.kv.os.theme.write')).allow, false);
  // Only the topic family is grantable, never a lookalike.
  for (const bad of ['system.kv.os..write', 'system.kv.os.theme.read', 'system.kv.app.theme.write', 'system.kv.os.a.b.write']) {
    await assert.rejects(grants.grant(subject, bad, { by }), (e) => e instanceof GrantError && e.status === 400, bad);
  }
});
