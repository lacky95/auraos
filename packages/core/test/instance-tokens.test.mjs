// InstanceTokens: the bearer the OS hands each instance at spawn. Pins the
// properties the token-gated sidecar routes rely on — tamper/forgery fails,
// a token is bound to its instance (and sidecar), and a recycled instance id
// or a forgotten consumer revokes every earlier token.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceTokens, consumerKey } from '../dist/app-manager/InstanceTokens.js';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-tokens-'));
  return { dir, file: join(dir, 'secrets', 'instance-token.key') };
};

test('mint → verify round-trips the claims', () => {
  const t = new InstanceTokens(fresh().file);
  const { token } = t.mint('com.example.app-2');
  assert.deepEqual(t.verify(token), { instanceId: 'com.example.app-2' });
  const sc = t.mint('com.example.app-2', 'db');
  assert.deepEqual(t.verify(sc.token), { instanceId: 'com.example.app-2', sidecar: 'db' });
});

test('garbage, tampered payloads and foreign signatures are rejected', () => {
  const t = new InstanceTokens(fresh().file);
  const { token } = t.mint('a.b');
  const [p, payload, sig] = token.split('.');
  assert.equal(t.verify(undefined), null);
  assert.equal(t.verify('nope'), null);
  assert.equal(t.verify(`${p}.${payload}`), null);
  const forged = Buffer.from(JSON.stringify({ i: 'other.app', n: 'x' })).toString('base64url');
  assert.equal(t.verify(`${p}.${forged}.${sig}`), null, 'payload swapped under a valid signature');
  const other = new InstanceTokens(fresh().file);
  other.register('a.b', JSON.parse(Buffer.from(payload, 'base64url').toString()).n);
  assert.equal(other.verify(token), null, 'signed with a different key');
});

test('a re-mint (recycled instance id) revokes the previous life', () => {
  const t = new InstanceTokens(fresh().file);
  const old = t.mint('com.example.app-2').token;
  const now = t.mint('com.example.app-2').token;
  assert.equal(t.verify(old), null);
  assert.ok(t.verify(now));
});

test('forget / forgetInstance revoke; nonces survive a restart via register()', () => {
  const { file } = fresh();
  const t = new InstanceTokens(file);
  const app = t.mint('x.y');
  const db = t.mint('x.y', 'db');
  const other = t.mint('x.yz');
  t.forget('x.y', 'db');
  assert.equal(t.verify(db.token), null);
  assert.ok(t.verify(app.token));
  t.mint('x.y', 'db2');
  t.forgetInstance('x.y');
  assert.equal(t.verify(app.token), null);
  assert.ok(t.verify(other.token), "forgetInstance('x.y') must not touch 'x.yz'");

  // Shell restart: same key file, empty memory, nonce re-learned from the label.
  const t2 = new InstanceTokens(file);
  assert.equal(t2.verify(other.token), null, 'unknown until the nonce is registered');
  t2.register('x.yz', other.nonce);
  assert.ok(t2.verify(other.token));
});

test('the key file is created lazily with mode 0600 and reused', () => {
  const { file } = fresh();
  const t = new InstanceTokens(file);
  const { token, nonce } = t.mint('k.k');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const key = readFileSync(file);
  const t2 = new InstanceTokens(file);
  t2.register('k.k', nonce);
  assert.ok(t2.verify(token));
  assert.deepEqual(readFileSync(file), key);
});

test('consumerKey joins instance and sidecar with --', () => {
  assert.equal(consumerKey('a.b-2'), 'a.b-2');
  assert.equal(consumerKey('a.b-2', 'db'), 'a.b-2--db');
});
