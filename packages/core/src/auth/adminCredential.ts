/**
 * The shared admin credential on disk — file operations only (no Valkey), so
 * the CLI can use them in the master container (`aura admin rotate`).
 *
 *   <dataDir>/aura/secrets/admin.key   0600, next to instance-token.key
 *
 * That directory lives in the master container (aura-shell) only: it is not
 * in Valkey, not in `~` and not in any app mount. Format:
 * `aura_admin_<43 base64url chars>` (256 random bits).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ADMIN_CREDENTIAL_PATTERN = /^aura_admin_[A-Za-z0-9_-]{43}$/;

export function defaultAdminKeyFile(dataDir: string = process.env['AURA_DATA_DIR'] ?? '/data'): string {
  return join(dataDir, 'aura', 'secrets', 'admin.key');
}

export function generateAdminCredential(): string {
  return `aura_admin_${randomBytes(32).toString('base64url')}`;
}

/** The stored credential, or null when the file is missing / malformed. */
export function readAdminCredential(keyFile: string): string | null {
  if (!existsSync(keyFile)) return null;
  const raw = readFileSync(keyFile, 'utf-8').trim();
  return ADMIN_CREDENTIAL_PATTERN.test(raw) ? raw : null;
}

/** Atomically write a credential (0600). */
export function writeAdminCredential(keyFile: string, credential: string): void {
  if (!ADMIN_CREDENTIAL_PATTERN.test(credential)) throw new Error('malformed admin credential');
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const tmp = `${keyFile}.tmp-${process.pid}`;
  writeFileSync(tmp, `${credential}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, keyFile);
}

/** Create the credential if missing. Never returns the secret. */
export function ensureAdminCredential(keyFile: string): { created: boolean } {
  if (readAdminCredential(keyFile)) return { created: false };
  writeAdminCredential(keyFile, generateAdminCredential());
  return { created: true };
}

/**
 * Replace the credential. Returns the NEW one (the operator must see it once).
 * The running shell notices the file change on its next check and drops every
 * admin session.
 */
export function rotateAdminCredential(keyFile: string): string {
  const next = generateAdminCredential();
  writeAdminCredential(keyFile, next);
  return next;
}
