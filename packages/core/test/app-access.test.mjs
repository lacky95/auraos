// D104 app composition: the one grant model (GrantStore, a target-scoped
// `apps.view` pinned to both installations) against a REAL valkey-server, and
// the refusal texts (auth/appAccess.ts) with their hint rules.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import {
  GrantStore, GrantError, isPrivilegedPermission, GRANTABLE_PERMISSIONS,
  appTargetScope, appAccessCounts, appAccessError, appAccessErrorBody, appAccessTargetRefusal, appAccessGrantCommand,
} from '../dist/auth/index.js';
import { OsEventBus } from '../dist/ipc/OsEventBus.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-app-access-'));
const server = new KvServer();
let redis;
let clock = 1_800_000_000_000;
let grants;
const BY = { kind: 'user', userId: 'default' };
const ML = { kind: 'app', id: 'io.lakner.marklayer' };

before(async () => {
  const uri = await server.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
  grants = new GrantStore(() => redis, () => clock);
});
after(async () => {
  redis?.disconnect();
  await server.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test('apps.view is privileged (never auto-granted) and grantable', () => {
  assert.equal(isPrivilegedPermission('apps.view'), true);
  assert.ok(GRANTABLE_PERMISSIONS.includes('apps.view'));
  assert.equal(isPrivilegedPermission('apps.embed'), false);
  assert.equal(isPrivilegedPermission('apps.interact'), false);
});

test('an apps.view grant is scoped to one target and pinned to both installations', async () => {
  const scope = appTargetScope('com.aura.sentinel', 'inst-target-1');
  const { record } = await grants.grant(ML, 'apps.view', { by: BY, scope, installationId: 'inst-ml-1', appScope: 'global' });
  assert.deepEqual(record.scope, { kind: 'app', id: 'com.aura.sentinel', installationId: 'inst-target-1' });
  assert.equal(record.installationId, 'inst-ml-1');
  const got = await grants.get(ML, 'apps.view', appTargetScope('com.aura.sentinel', ''));
  assert.equal(got.grantedAt, clock);
  // Counts only for the same consumer installation, scope and target installation.
  assert.equal(appAccessCounts(got, { scope: 'global', installationId: 'inst-ml-1' }, 'inst-target-1'), true);
  assert.equal(appAccessCounts(got, { scope: 'global', installationId: 'inst-ml-2' }, 'inst-target-1'), false, 'consumer reinstalled');
  assert.equal(appAccessCounts(got, { scope: 'global', installationId: 'inst-ml-1' }, 'inst-target-2'), false, 'target reinstalled');
  assert.equal(appAccessCounts(got, { scope: 'user', installationId: 'inst-ml-1' }, 'inst-target-1'), false, 'shadowed from another scope');
  assert.equal(appAccessCounts(null, { scope: 'global', installationId: 'inst-ml-1' }, 'inst-target-1'), false);
  // Another target is another grant.
  assert.equal(await grants.get(ML, 'apps.view', appTargetScope('io.lakner.trilium', '')), null);
});

test('an apps.view grant needs a target and the consumer installation; nothing else takes an app scope', async () => {
  await assert.rejects(() => grants.grant(ML, 'apps.view', { by: BY, installationId: 'i1' }), (e) => e instanceof GrantError && /--target/.test(e.message));
  await assert.rejects(() => grants.grant(ML, 'apps.view', { by: BY, scope: appTargetScope('com.aura.sentinel', 'x') }), (e) => e instanceof GrantError && e.status === 409);
  await assert.rejects(() => grants.grant(ML, 'apps.view', { by: BY, scope: appTargetScope('com.aura.sentinel', ''), installationId: 'i1' }), (e) => e.status === 409);
  await assert.rejects(() => grants.grant(ML, 'notifications.locked', { by: BY, scope: appTargetScope('com.aura.sentinel', 'x') }), GrantError);
  await assert.rejects(() => grants.grant(ML, 'notifications.locked', { by: BY, installationId: 'i1' }), GrantError);
  await assert.rejects(() => grants.grant({ kind: 'apiKey', id: 'k1' }, 'apps.view', { by: BY, scope: appTargetScope('a.b', 'x'), installationId: 'i' }), GrantError);
  await assert.rejects(() => grants.grant(ML, 'apps.embed', { by: BY, scope: appTargetScope('a.b', 'x'), installationId: 'i' }), GrantError);
});

test('a new approval changes the grant time (old credentials end) and emits permissions:changed', async () => {
  const seen = [];
  const on = (ev) => seen.push(ev);
  OsEventBus.on('permissions:changed', on);
  try {
    const scope = appTargetScope('io.lakner.trilium', 't1');
    const a = (await grants.grant(ML, 'apps.view', { by: BY, scope, installationId: 'inst-ml-1' })).record;
    clock += 1000;
    const b = (await grants.grant(ML, 'apps.view', { by: BY, scope, installationId: 'inst-ml-1' })).record;
    assert.notEqual(a.grantedAt, b.grantedAt);
    assert.equal(seen.filter((e) => e.permission === 'apps.view' && e.change === 'granted').length, 2);
  } finally {
    OsEventBus.off('permissions:changed', on);
  }
});

test('revoke: one target, then every target', async () => {
  const s1 = appTargetScope('com.example.one', 'o1');
  const s2 = appTargetScope('com.example.two', 'o2');
  const sub = { kind: 'app', id: 'com.example.reader' };
  await grants.grant(sub, 'apps.view', { by: BY, scope: s1, installationId: 'r1' });
  await grants.grant(sub, 'apps.view', { by: BY, scope: s2, installationId: 'r1' });
  assert.ok(await grants.revoke(sub, 'apps.view', appTargetScope('com.example.one', '')));
  assert.equal(await grants.get(sub, 'apps.view', s1), null);
  assert.ok(await grants.get(sub, 'apps.view', s2));
  await grants.revoke(sub, 'apps.view');
  assert.equal(await grants.get(sub, 'apps.view', s2), null);
  assert.deepEqual(await grants.listFor(sub), []);
});

const facts = (over = {}) => ({ manifest: { id: 'com.aura.sentinel', permissions: [] }, scope: 'user', protectedBy: null, ...over });

test('targets are normal apps only', () => {
  const r = (target, f) => appAccessTargetRefusal('io.lakner.marklayer', target, f)?.details.refusal ?? null;
  assert.equal(r('com.aura.sentinel', facts()), null);
  assert.equal(r('com.aura.sentinel', facts({ manifest: undefined })), 'target-unknown');
  assert.equal(r('io.lakner.marklayer', facts({ manifest: { id: 'io.lakner.marklayer' } })), 'target-self');
  assert.equal(r('com.aura.settings', facts({ scope: 'system' })), 'target-not-allowed');
  assert.equal(r('com.aura.settings', facts({ protectedBy: 'it is a trusted system UI' })), 'target-not-allowed');
  assert.equal(r('io.lakner.terminalx', facts({ manifest: { id: 'io.lakner.terminalx', permissions: ['terminal.embed'] } })), 'target-not-allowed');
  assert.equal(r('com.example.svc', facts({ manifest: { id: 'com.example.svc', componentType: 'service' } })), 'target-no-app-host');
  assert.equal(r('com.example.shy', facts({ manifest: { id: 'com.example.shy', composition: { view: 'deny' } } })), 'target-opted-out');
});

test('refusals use the one error body and hint at the manifest or the permission', () => {
  const ctx = { consumer: 'io.lakner.marklayer', consumerName: 'MarkLayer', target: 'com.aura.sentinel' };
  const grant = appAccessGrantCommand('io.lakner.marklayer', 'apps.view', 'com.aura.sentinel');
  assert.equal(grant, 'aura grant perms io.lakner.marklayer apps.view --target com.aura.sentinel');

  const nd = appAccessError('not-declared', ctx);
  assert.equal(nd.status, 403);
  assert.equal(nd.error, 'access-denied');
  assert.equal(nd.reason, 'missing-permission');
  assert.equal(nd.permission, 'apps.view');
  assert.equal(nd.holder, 'caller');
  assert.equal(nd.manifestField, 'permissions[]');
  assert.equal(nd.category, 'missing-declaration');
  assert.equal(nd.target, 'com.aura.sentinel');
  assert.match(nd.message, /MarkLayer lacks permission 'apps\.view' for com\.aura\.sentinel/);
  assert.match(nd.hint, /"apps\.view" to permissions\[\].*app\.manifest\.json/);
  assert.ok(nd.hint.includes(grant));
  assert.match(nd.docs, /app-composition#not-declared$/);

  for (const code of ['not-granted', 'denied', 'grant-stale', 'revoked']) {
    const e = appAccessError(code, ctx);
    assert.equal(e.holder, 'owner-grant', code);
    assert.equal(e.category, 'missing-permission', code);
    assert.ok(e.hint.includes(grant), code);
  }
  const opted = appAccessError('target-opted-out', ctx);
  assert.equal(opted.manifestField, 'composition.view');
  assert.equal(opted.holder, 'target');

  // §4.4: no grant command for a target apps can never be granted; no internal paths anywhere.
  const sys = appAccessError('target-not-allowed', { ...ctx, target: 'com.aura.settings', reason: 'it is a system app' });
  assert.doesNotMatch(sys.hint, /aura grant/);
  assert.equal(sys.category, 'not-grantable');
  assert.match(sys.message, /owner's.*can't be granted/);
  for (const code of ['server-only', 'no-user', 'not-declared', 'not-granted', 'denied', 'grant-stale', 'level-not-available',
    'target-unknown', 'target-self', 'target-not-allowed', 'target-opted-out', 'target-no-app-host', 'invalid-request', 'revoked',
    'read-only', 'not-through-target']) {
    const e = appAccessError(code, ctx);
    const text = JSON.stringify(appAccessErrorBody(e));
    assert.doesNotMatch(text, /\/data\/|\/workspace|\/mnt\/aura|aura-shell|cookie|token=/i, code);
    assert.equal(typeof e.message, 'string');
    assert.equal(typeof e.hint, 'string');
    assert.equal('status' in appAccessErrorBody(e), false);
  }
});
