/**
 * Envelope encryption for Aura Context values.
 *
 * Context values (tokens / secrets) are sealed with AES-256-GCM before they
 * are written to Valkey, so the append-only file / RDB snapshot on disk never
 * holds plaintext credentials. The materialised `/run/context/<KEY>` files
 * that mount into app containers ARE plaintext by necessity (the app has to
 * read them) — encryption only protects the at-rest Valkey store.
 *
 * Key resolution (see `resolveMasterKey`):
 *   1. `AURA_CONTEXT_KEY` env — base64 of exactly 32 bytes. Use this in prod.
 *   2. Dev fallback — a random 32-byte key generated once and persisted at
 *      `<dataDir>/context/.masterkey` (mode 0600). Logged loudly as dev-only.
 *
 * Sealed format: base64( iv[12] | tag[16] | ciphertext ).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** Cached per-process so we don't hit the filesystem on every seal/open. */
let cachedKey: Buffer | null = null;

/**
 * Resolve the 32-byte master key. Prefers `AURA_CONTEXT_KEY`; otherwise
 * generates and persists a dev key under the data volume.
 */
export function resolveMasterKey(dataDir: string): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env['AURA_CONTEXT_KEY'];
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) {
      throw new Error('[context] AURA_CONTEXT_KEY must be base64-encoded 32 bytes (256 bits)');
    }
    cachedKey = buf;
    return buf;
  }

  const keyPath = join(dataDir, 'context', '.masterkey');
  if (existsSync(keyPath)) {
    const buf = Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'base64');
    if (buf.length === 32) {
      cachedKey = buf;
      return buf;
    }
    // Corrupt / wrong-length key file — fall through and regenerate.
  }

  const key = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  console.warn(
    `[context] AURA_CONTEXT_KEY not set — generated a DEV master key at ${keyPath}. ` +
    `Set AURA_CONTEXT_KEY (base64 of 32 bytes) for production so keys aren't stored beside the ciphertext.`,
  );
  cachedKey = key;
  return key;
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function open(sealed: string, key: Buffer): string {
  const raw = Buffer.from(sealed, 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}
