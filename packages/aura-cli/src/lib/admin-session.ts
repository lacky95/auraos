/**
 * Admin session for the CLI (minimal admin auth: ONE shared operator
 * credential, no user accounts).
 *
 * Where a session comes from, first hit wins:
 *   1. AURA_ADMIN_SESSION        an `aura-admin1.…` token (e.g. from `aura admin login --print`)
 *   2. this process              a session obtained earlier in the same command
 *   3. ~/.aura/admin-session     written by `aura admin login --save` (0600, 15 min)
 *
 * When an /api/admin/* call is refused, `recoverAdminSession()` gets one for
 * THIS command only (nothing is written) from:
 *   AURA_ADMIN_CREDENTIAL, or the key file when running in the master
 *   container (<dataDir>/aura/secrets/admin.key), or a hidden prompt on a TTY.
 *
 * The session is a header (`Authorization: Bearer …`), never a cookie.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultAdminKeyFile, readAdminCredential } from '@aura/core';
import { shellUrl } from './shell-url.js';

export const ADMIN_SESSION_FILE = join(homedir(), '.aura', 'admin-session');

interface Session { token: string; expiresAt: number }

let inProcess: Session | null = null;

export function isAdminPath(path: string): boolean {
  return path.startsWith('/api/admin/') && !path.startsWith('/api/admin/session');
}

function readSaved(): Session | null {
  try {
    if (!existsSync(ADMIN_SESSION_FILE)) return null;
    const s = JSON.parse(readFileSync(ADMIN_SESSION_FILE, 'utf-8')) as Session;
    if (typeof s.token !== 'string' || typeof s.expiresAt !== 'number') return null;
    if (s.expiresAt <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

/** The session token to send, or null. */
export function currentAdminSession(): string | null {
  const env = process.env['AURA_ADMIN_SESSION']?.trim();
  if (env) return env;
  if (inProcess && inProcess.expiresAt > Date.now()) return inProcess.token;
  return readSaved()?.token ?? null;
}

export function adminHeaders(): Record<string, string> {
  const t = currentAdminSession();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** The credential file of the master container, when this process can read it. */
export function masterKeyFile(): string | null {
  const f = defaultAdminKeyFile();
  try { return readAdminCredential(f) ? f : null; } catch { return null; }
}

/** Read a line without echo (TTY only). */
export async function promptSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('no TTY for a prompt');
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err); else resolve(buf.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Where to get the credential without asking, if anywhere. */
export function credentialFromEnvironment(): string | null {
  const env = process.env['AURA_ADMIN_CREDENTIAL']?.trim();
  if (env) return env;
  const f = masterKeyFile();
  return f ? readAdminCredential(f) : null;
}

export class AdminLoginError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** POST /api/admin/session with the credential → a session (kept in this process). */
export async function adminLogin(credential: string): Promise<Session> {
  let res: Response;
  try {
    res = await fetch(`${shellUrl()}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
  } catch (err) {
    throw new AdminLoginError(`Cannot reach AuraOS shell at ${shellUrl()}: ${String(err)}`, 0);
  }
  const body = await res.json().catch(() => ({})) as { token?: string; expiresAt?: number; message?: string; error?: string };
  if (!res.ok || !body.token || !body.expiresAt) {
    throw new AdminLoginError(`admin login failed (${res.status}): ${body.message ?? body.error ?? 'unknown error'}`, res.status);
  }
  inProcess = { token: body.token, expiresAt: body.expiresAt };
  return inProcess;
}

/** Ask (or look) for the credential: env, master key file, then a hidden TTY prompt. */
export async function obtainCredential(interactive: boolean): Promise<string | null> {
  const known = credentialFromEnvironment();
  if (known) return known;
  if (!interactive || !process.stdin.isTTY || !process.stderr.isTTY) return null;
  return (await promptSecret('AuraOS admin credential (hidden): ')) || null;
}

/**
 * Called after a 401 admin-required: drop a stale session, then try to get a
 * fresh one for this command only. True when a new session is in place.
 */
export async function recoverAdminSession(): Promise<boolean> {
  if (process.env['AURA_ADMIN_SESSION']) return false; // the caller pinned one; don't second-guess it
  if (readSaved()) clearSavedSession();
  inProcess = null;
  const credential = await obtainCredential(true).catch(() => null);
  if (!credential) return false;
  try {
    await adminLogin(credential);
    return true;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return false;
  }
}

/** Persist a session to ~/.aura/admin-session (0600). */
export function saveSession(s: Session): void {
  mkdirSync(dirname(ADMIN_SESSION_FILE), { recursive: true });
  writeFileSync(ADMIN_SESSION_FILE, JSON.stringify(s) + '\n', { mode: 0o600 });
  try { chmodSync(ADMIN_SESSION_FILE, 0o600); } catch { /* best effort */ }
}

export function clearSavedSession(): boolean {
  if (!existsSync(ADMIN_SESSION_FILE)) return false;
  rmSync(ADMIN_SESSION_FILE, { force: true });
  return true;
}

export function savedSession(): Session | null {
  return readSaved();
}

export function forgetInProcessSession(): void {
  inProcess = null;
}
