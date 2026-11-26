// lib/auth.ts: central request authentication.
//
//   cd packages/shell && npx tsx --test test/auth.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceTokens } from '@aura/core';
import { authenticate, type AuthDeps } from '../src/lib/auth.ts';
import { localSystemId } from '@aura/core/system-identity';
/** The test data dir's own system id (D47): every resolved principal carries it. */
const SYS = localSystemId();

const tokens = new InstanceTokens(join(mkdtempSync(join(tmpdir(), 'aura-auth-')), 'secrets', 'k.key'));
const instances = new Map([
  ['com.example.notes-1', { instanceId: 'com.example.notes-1', appId: 'com.example.notes', inPool: false, port: 4001 }],
]);
const GOOD_KEY = `aura_k1_0123456789abcdef_${'a'.repeat(43)}`;
const deps: AuthDeps = {
  mgr: {
    tokens,
    getInstance: (id: string) => instances.get(id),
    getInstancesByApp: (appId: string) => [...instances.values()].filter((i) => i.appId === appId),
  } as never,
  apiKeys: { verify: async (k) => (k === GOOD_KEY ? { id: '0123456789abcdef', name: 'CI', scopes: ['system.notifications'] } : null) },
};
const req = (headers: Record<string, string> = {}) => new Request('http://aura-shell:3000/api/notifications', { method: 'POST', headers });
const bearer = (t: string) => req({ authorization: `Bearer ${t}` });

test('order: instance token → verified instance; API key → apiKey; a retired admin session → 401 (D50)', async () => {
  const inst = await authenticate(bearer(tokens.mint('com.example.notes-1').token), deps);
  assert.deepEqual(inst, { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified', systemId: SYS, lifetime: tokens.lifetimeId('com.example.notes-1') });
  const key = await authenticate(bearer(GOOD_KEY), deps);
  assert.deepEqual(key, { kind: 'apiKey', keyId: '0123456789abcdef', name: 'CI', scopes: ['system.notifications'], verification: 'verified' });
  const admin = await authenticate(bearer('aura-admin1.payload.sig'), deps);
  assert.ok(admin instanceof Response);
  assert.equal(admin.status, 401);
});

test('bad credentials of every kind → 401, never anonymous', async () => {
  for (const t of [`aura_k1_0123456789abcdef_${'b'.repeat(43)}`, 'aura_k1_x', 'aura-admin1.forged.sig', 'aura1.forged.sig', 'nonsense']) {
    const r = await authenticate(bearer(t), deps);
    assert.ok(r instanceof Response, t);
    assert.equal(r.status, 401, t);
  }
  const basic = await authenticate(req({ authorization: 'Basic dXNlcjpwYXNz' }), deps);
  assert.equal((basic as Response).status, 401);
});

test('no credentials → anonymous; a self-set instance id is not even a hint', async () => {
  assert.deepEqual(await authenticate(req(), deps), { kind: 'anonymous', verification: 'unverified' });
  const hinted = await authenticate(req({ 'x-aura-instance-id': 'com.example.notes-1' }), deps);
  assert.deepEqual(hinted, { kind: 'anonymous', verification: 'unverified' });
});

