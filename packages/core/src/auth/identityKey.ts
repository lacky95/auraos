/**
 * The identity key on disk — file operations only (no Valkey).
 *
 *   <dataDir>/aura/secrets/identity.key   0600, next to admin.key
 *
 * It signs login sessions and MACs the user record, so a Valkey writer can
 * neither forge a session nor swap a password hash. It is independent of the
 * shared admin credential: rotating that never logs out a password user.
 *
 * A malformed file is an error and is never overwritten, because replacing the
 * key would invalidate the owner record.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const IDENTITY_KEY_PATTERN = /^aura_identity_[A-Za-z0-9_-]{43}$/;

export function defaultIdentityKeyFile(dataDir: string = process.env['AURA_DATA_DIR'] ?? '/data'): string {
  return join(dataDir, 'aura', 'secrets', 'identity.key');
}

function readIdentityKey(keyFile: string): string | null {
  let raw: string;
  try { raw = readFileSync(keyFile, 'utf-8').trim(); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!IDENTITY_KEY_PATTERN.test(raw)) throw new Error('malformed identity key file');
  return raw;
}

/** The key, created atomically if missing. Concurrent creators agree on one key. */
export function ensureIdentityKey(keyFile: string): string {
  const existing = readIdentityKey(keyFile);
  if (existing) return existing;
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const tmp = `${keyFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, `aura_identity_${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
    // link() fails if the target exists, unlike rename(): the first writer wins.
    try { linkSync(tmp, keyFile); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  } finally {
    rmSync(tmp, { force: true });
  }
  const key = readIdentityKey(keyFile);
  if (!key) throw new Error('identity key could not be created');
  return key;
}

/** A purpose-bound subkey, so a session MAC can never pass as a record MAC. */
export function deriveIdentitySubkey(keyFile: string, purpose: 'login-session' | 'user-record'): Buffer {
  return createHmac('sha256', ensureIdentityKey(keyFile)).update(`aura-identity/v1/${purpose}`).digest();
}
