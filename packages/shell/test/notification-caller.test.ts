// The notification API's caller rules: identity from authenticate() (lib/auth.ts,
// the one principal resolver); Referer and X-Aura-Instance-Id are no hint.
//
//   cd packages/shell && npx tsx --test test/notification-caller.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceTokens } from '@aura/core';
import { authenticate, type AuthDeps } from '../src/lib/auth.ts';
import { withDeclaredAppHint, senderTokenFrom } from '../src/lib/notificationCaller.ts';

const tokens = new InstanceTokens(join(mkdtempSync(join(tmpdir(), 'aura-nc-')), 'secrets', 'k.key'));
const instances = new Map([
  ['com.example.notes-1', { instanceId: 'com.example.notes-1', appId: 'com.example.notes', inPool: false, port: 4001 }],
]);
const mgr = {
  tokens,
  getInstance: (id: string) => instances.get(id),
  getInstancesByApp: (appId: string) => [...instances.values()].filter((i) => i.appId === appId),
} as never;
const deps: AuthDeps = { mgr, apiKeys: { verify: async () => null }, admin: { verifySession: async () => null } };

const req = (headers: Record<string, string> = {}) => new Request('http://aura-shell:3000/api/notifications', { method: 'POST', headers });

test('valid Bearer → verified instance caller (appId from the instance record)', async () => {
  const token = tokens.mint('com.example.notes-1').token;
  const c = await authenticate(req({ authorization: `Bearer ${token}`, 'x-aura-instance-id': 'com.other-1' }), deps);
  assert.deepEqual(c, { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified' });
});

test('sidecar token keeps the sidecar name', async () => {
  const token = tokens.mint('com.example.notes-1', 'agent').token;
  const c = await authenticate(req({ authorization: `Bearer ${token}` }), deps) as { sidecar?: string };
  assert.equal(c.sidecar, 'agent');
});

test('invalid / garbage / non-Bearer credentials → 401, never anonymous', async () => {
  for (const authorization of ['Bearer aura-inst1.forged.sig', 'Bearer nonsense', 'Basic dXNlcjpwYXNz', 'Bearer']) {
    const r = await authenticate(req({ authorization }), deps);
    assert.ok(r instanceof Response, `expected 401 for ${authorization}`);
    assert.equal((r as Response).status, 401);
  }
});

test('token of an instance that is gone → 401', async () => {
  const token = tokens.mint('com.example.gone-1').token;
  const r = await authenticate(req({ authorization: `Bearer ${token}` }), deps);
  assert.equal((r as Response).status, 401);
  assert.match(await (r as Response).text(), /com\.example\.gone-1, which is not running/);
});

test('Referer / X-Aura-Instance-Id are no identity and no hint', async () => {
  const hints: Array<Record<string, string>> = [{ 'x-aura-instance-id': 'com.example.notes-1' }, { referer: 'http://aura-shell:3000/api/proxy/com.example.notes-1/index.html' }];
  for (const h of hints) {
    assert.deepEqual(await authenticate(req(h), deps), { kind: 'anonymous', verification: 'unverified' });
  }
});

test('no credentials → anonymous; there is no way to produce a system caller', async () => {
  assert.deepEqual(await authenticate(req(), deps), { kind: 'anonymous', verification: 'unverified' });
  const c = await authenticate(req({ 'x-aura-caller': 'system', 'x-aura-system': '1' }), deps) as { kind: string };
  assert.equal(c.kind, 'anonymous');
});

test('legacy body appId becomes a hint only for anonymous callers without hints', () => {
  const anon = { kind: 'anonymous', verification: 'unverified' } as const;
  assert.deepEqual(withDeclaredAppHint(anon, 'com.example.x'), { ...anon, hints: { appId: 'com.example.x' } });
  assert.deepEqual(withDeclaredAppHint(anon, 'Not An Id'), anon);
  const inst = { kind: 'instance', appId: 'com.a.b', instanceId: 'com.a.b-1', verification: 'verified' } as const;
  assert.equal(withDeclaredAppHint(inst, 'com.example.x'), inst);
});

test('senderToken from header wins over body', () => {
  assert.equal(senderTokenFrom(req({ 'x-aura-sender-token': 'nst_h' }), { senderToken: 'nst_b' }), 'nst_h');
  assert.equal(senderTokenFrom(req(), { senderToken: 'nst_b' }), 'nst_b');
  assert.equal(senderTokenFrom(req(), {}), undefined);
});
