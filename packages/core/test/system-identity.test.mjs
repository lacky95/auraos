// D47: the system identity — created once, stable, renewed only on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  ensureSystemIdentity, localSystemId, qualifiedRef, reidentifySystem, resetSystemIdCache, systemIdentityFile, systemKeyFile,
} from '../dist/system/systemIdentity.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fresh = () => mkdtempSync(join(tmpdir(), 'aura-sys-'));

test('first boot creates a random systemId and an Ed25519 key pair; the private key stays in secrets, 0600', () => {
  const dir = fresh();
  const id = ensureSystemIdentity(dir);
  assert.match(id.systemId, UUID);
  const onDisk = JSON.parse(readFileSync(systemIdentityFile(dir), 'utf-8'));
  assert.equal(onDisk.systemId, id.systemId);
  assert.equal(JSON.stringify(onDisk).includes('PRIVATE'), false, 'system.json holds no private key');
  assert.equal(statSync(systemKeyFile(dir)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'aura', 'secrets')).mode & 0o077, 0);
  const priv = createPrivateKey(readFileSync(systemKeyFile(dir), 'utf-8'));
  assert.equal(priv.asymmetricKeyType, 'ed25519');
  assert.equal(createPublicKey(priv).export({ type: 'spki', format: 'pem' }), id.publicKey, 'the pair matches');
});

test('the id never changes on later boots', () => {
  const dir = fresh();
  const a = ensureSystemIdentity(dir);
  const b = ensureSystemIdentity(dir);
  assert.deepEqual(b, a);
});

test('a lost private key gets a new pair under the same id', () => {
  const dir = fresh();
  const a = ensureSystemIdentity(dir);
  rmSync(systemKeyFile(dir));
  const b = ensureSystemIdentity(dir);
  assert.equal(b.systemId, a.systemId);
  assert.notEqual(b.publicKey, a.publicKey);
});

test('an invalid system.json is never replaced silently', () => {
  const dir = fresh();
  ensureSystemIdentity(dir);
  writeFileSync(systemIdentityFile(dir), '{"v":1,"systemId":"not-a-uuid"}');
  assert.throws(() => ensureSystemIdentity(dir), /not a valid system identity/);
});

test('reidentify gives a copy a new id and key, and reports the old id', () => {
  const dir = fresh();
  const a = ensureSystemIdentity(dir);
  const key = readFileSync(systemKeyFile(dir), 'utf-8');
  const { previous, current } = reidentifySystem(dir);
  assert.equal(previous, a.systemId);
  assert.notEqual(current.systemId, a.systemId);
  assert.notEqual(readFileSync(systemKeyFile(dir), 'utf-8'), key);
  assert.equal(ensureSystemIdentity(dir).systemId, current.systemId);
  // Also from an unreadable identity (a copy with a broken file).
  writeFileSync(systemIdentityFile(dir), 'junk');
  assert.equal(reidentifySystem(dir).previous, null);
});

test('localSystemId is cached per data dir; qualifiedRef is userId@systemId', () => {
  const dir = fresh();
  resetSystemIdCache();
  const id = localSystemId(dir);
  assert.equal(localSystemId(dir), id);
  assert.equal(qualifiedRef('default', id), `default@${id}`);
  resetSystemIdCache();
});
