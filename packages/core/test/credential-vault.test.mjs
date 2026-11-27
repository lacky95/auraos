// D56: the per-user vault on the Context store, and the credential.read
// grant scoped to one user's vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  CREDENTIAL_HANDLE_RE, CredentialVault, GrantError, GrantStore, credentialNamespace, credentialReadPermission,
  isPrivilegedPermission, userScope,
} from '../dist/index.js';
import { isValidNamespace } from '@aura/kv-store';

function memoryKv() {
  const m = new Map();
  return {
    m,
    kv: () => ({
      async get(ns, key) { return m.get(`${ns}|${key}`) ?? null; },
      async set(ns, key, value) { assert.ok(isValidNamespace(ns), ns); const e = { value: JSON.parse(JSON.stringify(value)), updatedAt: 1 }; m.set(`${ns}|${key}`, e); return e; },
      async del(ns, key) { return m.delete(`${ns}|${key}`); },
      async list(ns) { return [...m.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.slice(ns.length + 1)); },
    }),
  };
}

const SECRET = 'ghp_' + randomBytes(16).toString('hex');
let clock = 1000;
const vaultOf = (store) => new CredentialVault({ kv: store.kv, key: randomBytes(32), now: () => ++clock });

test('the vault namespace is a Context namespace per user, never reachable through /api/kv', () => {
  assert.equal(credentialNamespace('default'), 'context:user:default');
  assert.ok(isValidNamespace('context:user:default'));
  assert.throws(() => credentialNamespace('../x'));
  assert.throws(() => credentialNamespace(''));
});

test('store keeps the value sealed and injected nowhere; one handle per consuming app, kept on replace', async () => {
  const store = memoryKv();
  const v = vaultOf(store);
  const a = await v.store('default', 'GITHUB_TOKEN', SECRET, { consumer: 'com.example.notes', label: 'GitHub' });
  assert.equal(a.created, true);
  assert.match(a.handle, CREDENTIAL_HANDLE_RE);
  const raw = store.m.get('context:user:default|GITHUB_TOKEN').value;
  assert.deepEqual(raw.inject, []);
  assert.equal(raw.kind, 'secret');
  assert.ok(!JSON.stringify(raw).includes(SECRET), 'sealed at rest');
  const b = await v.store('default', 'GITHUB_TOKEN', 'new-value', { consumer: 'com.example.notes' });
  assert.equal(b.handle, a.handle);
  assert.equal(b.created, false);
  const c = await v.store('default', 'GITHUB_TOKEN', 'new-value', { consumer: 'com.example.other' });
  assert.notEqual(c.handle, a.handle);
  await assert.rejects(v.store('default', 'bad name', 'x', { consumer: 'com.example.notes' }));
  await assert.rejects(v.store('default', 'EMPTY', '', { consumer: 'com.example.notes' }));
  await assert.rejects(v.store('default', 'HUGE', 'x'.repeat(4097), { consumer: 'com.example.notes' }));
});

test('list and describe carry no value and no handle; reveal records the last use', async () => {
  const store = memoryKv();
  const v = vaultOf(store);
  const { handle } = await v.store('default', 'NPM_TOKEN', SECRET, { consumer: 'com.example.notes', label: 'npm' });
  const rows = await v.list('default');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['consumers', 'createdAt', 'label', 'name', 'updatedAt']);
  assert.ok(!JSON.stringify(rows).includes(SECRET));
  assert.ok(!JSON.stringify(rows).includes(handle));
  assert.equal(await v.reveal('default', 'NPM_TOKEN', 'com.example.notes'), SECRET);
  const after = await v.describe('default', 'NPM_TOKEN');
  assert.equal(after.lastUsedBy, 'com.example.notes');
  assert.equal(typeof after.lastUsedAt, 'number');
});

test('a handle resolves only in its own user\'s vault; removing the consumer or the entry ends it', async () => {
  const store = memoryKv();
  const v = vaultOf(store);
  const { handle } = await v.store('default', 'TOKEN', SECRET, { consumer: 'com.example.notes' });
  assert.deepEqual(await v.resolve('default', handle), { name: 'TOKEN', consumer: 'com.example.notes' });
  assert.equal(await v.resolve('bob', handle), null, 'another user');
  assert.equal(await v.resolve('default', 'cred_notahandle'), null);
  assert.equal(await v.handleOf('default', 'TOKEN', 'com.example.notes'), handle);
  assert.equal(await v.removeConsumer('default', 'TOKEN', 'com.example.notes'), true);
  assert.equal(await v.resolve('default', handle), null);
  assert.equal(await v.remove('default', 'TOKEN'), true);
  assert.deepEqual(await v.list('default'), []);
});

test('credential.read:<NAME> is grantable only to an app, for one user\'s vault', async () => {
  const used = [];
  const redis = () => new Proxy({}, { get: (_t, k) => (...a) => { used.push(k); if (k === 'multi') return { hset() { return this; }, sadd() { return this; }, exec: async () => [] }; return Promise.resolve(null); } });
  const g = new GrantStore(redis);
  const perm = credentialReadPermission('GITHUB_TOKEN');
  assert.equal(perm, 'credential.read:GITHUB_TOKEN');
  assert.ok(isPrivilegedPermission(perm));
  await assert.rejects(g.grant({ kind: 'app', id: 'com.example.notes' }, perm, { by: { kind: 'system' } }), GrantError, 'never OS-wide');
  await assert.rejects(g.grant({ kind: 'apiKey', id: 'k1' }, perm, { by: { kind: 'system' }, scope: userScope('default') }), GrantError);
  await assert.rejects(g.grant({ kind: 'app', id: 'com.example.notes' }, 'notifications.popup', { by: { kind: 'system' }, scope: userScope('default') }), GrantError);
  await assert.rejects(g.grant({ kind: 'app', id: 'com.example.notes' }, 'credential.read:lower', { by: { kind: 'system' }, scope: userScope('default') }), GrantError);
  assert.equal(used.length, 0, 'refused before touching Valkey');
  const { record } = await g.grant({ kind: 'app', id: 'com.example.notes' }, perm, { by: { kind: 'system' }, installationId: 'inst-1', scope: userScope('default') });
  assert.deepEqual(record.scope, { kind: 'user', id: 'default' });
  assert.equal(record.installationId, 'inst-1', 'given to one installation (S1)');
});
