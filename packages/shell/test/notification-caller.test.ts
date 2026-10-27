// authenticateCaller: the notification API's identity rules.
//
//   cd packages/shell && npx tsx --test test/notification-caller.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceTokens } from '@aura/core';
import { authenticateCaller, withDeclaredAppHint, senderTokenFrom } from '../src/lib/notificationCaller.ts';

const tokens = new InstanceTokens(join(mkdtempSync(join(tmpdir(), 'aura-nc-')), 'secrets', 'k.key'));
const instances = new Map([
  ['com.example.notes-1', { instanceId: 'com.example.notes-1', appId: 'com.example.notes', inPool: false, port: 4001 }],
]);
const mgr = {
  tokens,
  getInstance: (id: string) => instances.get(id),
  getInstancesByApp: (appId: string) => [...instances.values()].filter((i) => i.appId === appId),
} as never;

const req = (headers: Record<string, string> = {}) => new Request('http://aura-shell:3000/api/notifications', { method: 'POST', headers });

test('valid Bearer → verified instance caller (appId from the instance record)', () => {
  const token = tokens.mint('com.example.notes-1').token;
  const c = authenticateCaller(req({ authorization: `Bearer ${token}`, 'x-aura-instance-id': 'com.other-1' }), mgr);
  assert.deepEqual(c, { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified' });
});

test('sidecar token keeps the sidecar name', () => {
  const token = tokens.mint('com.example.notes-1', 'agent').token;
  const c = authenticateCaller(req({ authorization: `Bearer ${token}` }), mgr) as { sidecar?: string };
  assert.equal(c.sidecar, 'agent');
});

test('invalid / garbage / non-Bearer credentials → 401, never anonymous', async () => {
  for (const authorization of ['Bearer aura-inst1.forged.sig', 'Bearer nonsense', 'Basic dXNlcjpwYXNz', 'Bearer']) {
    const r = authenticateCaller(req({ authorization }), mgr);
    assert.ok(r instanceof Response, `expected 401 for ${authorization}`);
    assert.equal((r as Response).status, 401);
  }
});

test('token of an instance that is gone → 401', () => {
  const token = tokens.mint('com.example.gone-1').token;
  const r = authenticateCaller(req({ authorization: `Bearer ${token}` }), mgr);
  assert.equal((r as Response).status, 401);
});

test('Referer / X-Aura-Instance-Id give unverified hints only', () => {
  const viaHeader = authenticateCaller(req({ 'x-aura-instance-id': 'com.example.notes-1' }), mgr);
  assert.deepEqual(viaHeader, { kind: 'anonymous', verification: 'unverified', hints: { appId: 'com.example.notes', instanceId: 'com.example.notes-1' } });
  const viaReferer = authenticateCaller(req({ referer: 'http://aura-shell:3000/api/proxy/com.example.notes-1/index.html' }), mgr);
  assert.equal((viaReferer as { verification: string }).verification, 'unverified');
  assert.equal((viaReferer as { kind: string }).kind, 'anonymous');
  // unknown claimed instance → no hints at all
  assert.deepEqual(authenticateCaller(req({ 'x-aura-instance-id': 'com.forged-1' }), mgr), { kind: 'anonymous', verification: 'unverified' });
});

test('no credentials → anonymous; there is no way to produce a system caller', () => {
  assert.deepEqual(authenticateCaller(req(), mgr), { kind: 'anonymous', verification: 'unverified' });
  const c = authenticateCaller(req({ 'x-aura-caller': 'system', 'x-aura-system': '1' }), mgr) as { kind: string };
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
