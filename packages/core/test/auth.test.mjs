// Core auth (phase 2) against a REAL valkey-server (KvServer on a tmp dataDir).
//
//   pnpm --filter @aura/core test
//
// Covers: the Authorizer matrix, grants / revokes taking effect live in the
// NotificationService (downgrade ↔ accepted, no restart), `system.notifications`
// enforcement, ownership + read scoping, API keys (create / verify / revoke),
// admin sessions (TTL, lock, rotation, bad credentials), the audit stream,
// the rate limit, waitFor, and that a declared actor name never changes a result.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, KvClient, createRedis } from '@aura/kv-store';
import {
  Authorizer, GrantStore, ApiKeyStore, AdminAuth, AdminAudit,
  SYSTEM_PRINCIPAL, ADMIN_AUDIT_LABEL, PRIVILEGED_PERMISSIONS, GrantError, ApiKeyError,
  adminAttribution, rotateAdminCredential, readAdminCredential, API_KEY_PATTERN,
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
]);
const inst = (appId, n = 1) => ({ kind: 'instance', appId, instanceId: `${appId}-${n}`, verification: 'verified' });
const ANON = { kind: 'anonymous', verification: 'unverified' };
const ADMIN = { kind: 'admin', credential: 'shared', sessionId: '0123456789abcdef', verification: 'verified' };

let grants, keys, authz, svc, admin, audit;

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
  admin = new AdminAuth({ keyFile: join(DATA_DIR, 'secrets', 'admin.key'), redis: r, now });
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

const by = adminAttribution(ADMIN);

// ---------------------------------------------------------------------------
// Authorizer matrix
// ---------------------------------------------------------------------------

test('Authorizer matrix: system / admin / instance / apiKey / anonymous', async () => {
  const a = (p, act) => authz.authorize(p, act).then((d) => d.allow);
  // system: everything; a JSON look-alike: nothing
  assert.equal(await a(SYSTEM_PRINCIPAL, 'notifications.locked'), true);
  assert.equal(await a(SYSTEM_PRINCIPAL, 'admin.grants'), true);
  const fake = JSON.parse(JSON.stringify(SYSTEM_PRINCIPAL));
  assert.equal(await a(fake, 'system.notifications'), false);
  // admin: management only
  assert.equal(await a(ADMIN, 'admin.grants'), true);
  assert.equal(await a(ADMIN, 'admin.apiKeys'), true);
  assert.equal(await a(ADMIN, 'system.notifications'), false);
  assert.equal(await a(ADMIN, 'notifications.locked'), false);
  // nobody else gets admin actions
  for (const p of [inst('com.example.priv'), ANON]) assert.equal(await a(p, 'admin.grants'), false);
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

test('a declared actor name never changes a decision', async () => {
  const names = ['admin', 'root', 'system', 'AuraOS', 'com.example.priv', 'claude'];
  for (const p of [inst('com.example.basic'), inst('com.example.mute'), inst('com.example.priv'), ANON, ADMIN]) {
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
    assert.equal(g1.record.grantedBy.label, ADMIN_AUDIT_LABEL);
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
  // an admin session is not a sender
  await rejectsStatus(svc.create({ title: 'admin' }, ADMIN), 403, /admin/);
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

test('read scoping: verified apps / API keys see only their own; admin + in-process see all; anonymous without a client session sees nothing (phase 5)', async () => {
  const A = inst('com.example.basic');
  const B = inst('com.example.other');
  const a = (await svc.create({ title: 'A-only' }, A)).notification;
  const b = (await svc.create({ title: 'B-only' }, B)).notification;
  assert.equal(await svc.get(b.id, A), null);
  assert.equal((await svc.get(a.id, A)).id, a.id);
  const la = await svc.list({ state: 'all', limit: 200 }, A);
  assert.ok(la.items.length > 0 && la.items.every((n) => n.senderKey === 'app:com.example.basic'));
  assert.deepEqual((await svc.list({ sender: 'app:com.example.other' }, A)).items, []);
  for (const viewer of [ADMIN, undefined]) {
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
// Admin sessions
// ---------------------------------------------------------------------------

test('admin credential: created 0600 outside Valkey; unlock → session; bad credentials refused', async () => {
  const { created, keyFile } = admin.ensure();
  assert.equal(created, true);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(admin.ensure().created, false);
  const cred = readAdminCredential(keyFile);
  assert.match(cred, /^aura_admin_/);

  for (const bad of ['', 'aura_admin_wrong', cred.slice(0, -1), null, 42]) {
    const r = await admin.unlock(bad);
    assert.equal(r.ok, false);
  }
  const s = await admin.unlock(cred);
  assert.equal(s.ok, true);
  assert.match(s.token, /^aura-admin1\./);
  assert.equal(s.expiresAt, clock + 15 * 60_000);
  assert.deepEqual(await admin.verifySession(s.token), { sessionId: s.sessionId, expiresAt: s.expiresAt });
  // tampering → null
  const [p0, p1, p2] = s.token.split('.');
  const forged = Buffer.from(JSON.stringify({ s: s.sessionId, e: s.expiresAt + 3_600_000, f: 'x' })).toString('base64url');
  assert.equal(await admin.verifySession(`${p0}.${forged}.${p2}`), null);
  assert.equal(await admin.verifySession(`${p0}.${p1}.AAAA`), null);
  assert.equal(await admin.verifySession('aura-admin1.garbage'), null);
  assert.equal(await admin.verifySession(null), null);
  // the credential never reaches Valkey
  const keysInKv = await redis.keys('*');
  for (const k of keysInKv) {
    const type = await redis.type(k);
    if (type === 'string') assert.equal(String(await redis.get(k)).includes(cred), false, k);
  }
});

test('admin session: TTL, lock, and rotation revoke sessions', async () => {
  const cred = readAdminCredential(admin.keyFile);
  const s1 = await admin.unlock(cred);
  clock += 15 * 60_000 + 1;
  assert.equal(await admin.verifySession(s1.token), null, 'expired');
  const s2 = await admin.unlock(cred);
  assert.ok(await admin.verifySession(s2.token));
  assert.equal(await admin.lock(s2.sessionId), true);
  assert.equal(await admin.verifySession(s2.token), null, 'locked');

  const s3 = await admin.unlock(cred);
  assert.ok(await admin.verifySession(s3.token));
  const rotatedSeen = new Promise((resolve) => {
    const a2 = new AdminAuth({ keyFile: admin.keyFile, redis: () => redis, now, onRotated: resolve });
    a2.ensure();
    // rotate on disk (what `aura admin rotate` does in the master container)
    const fresh = rotateAdminCredential(admin.keyFile);
    assert.notEqual(fresh, cred);
    assert.equal(a2.verifyCredential(fresh), true);
  });
  const purged = await rotatedSeen;
  assert.ok(purged >= 1);
  assert.equal(await admin.verifySession(s3.token), null, 'old token dead after rotation');
  assert.equal((await admin.unlock(cred)).ok, false, 'old credential refused');
  assert.equal((await admin.unlock(readAdminCredential(admin.keyFile))).ok, true);
});

test('admin unlock: failed attempts are rate limited, the right credential still works', async () => {
  clock += 60_000;
  let last;
  for (let i = 0; i < 31; i++) last = await admin.unlock('aura_admin_nope');
  assert.deepEqual(last, { ok: false, reason: 'rate-limited' });
  assert.equal((await admin.unlock(readAdminCredential(admin.keyFile))).ok, true);
});

test('audit: entries are attributed to "admin (shared credential)", newest first', async () => {
  await audit.record({ by, action: 'grant', target: 'app:com.example.priv', detail: { permission: 'notifications.locked' } });
  await audit.record({ by, action: 'revoke', target: 'app:com.example.priv', detail: { permission: 'notifications.locked' } });
  const list = await audit.list(10);
  assert.equal(list[0].action, 'revoke');
  assert.equal(list[0].actor, ADMIN_AUDIT_LABEL);
  assert.equal(list[0].session, ADMIN.sessionId.slice(0, 8));
  assert.deepEqual(list[1].detail, { permission: 'notifications.locked' });
  const raw = readFileSync(admin.keyFile, 'utf-8').trim();
  assert.equal(JSON.stringify(list).includes(raw), false);
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
