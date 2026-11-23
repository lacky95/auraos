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
 * Stored credentials only ever go to the trusted shell (see identity.ts).
 *
 * The session is a header (`Authorization: Bearer …`), never a cookie.
 */
import { defaultAdminKeyFile, readAdminCredential } from '@aura/core';
import { shellUrl } from './shell-url.js';
import { isTrustedShellUrl, shellFetch, warnExplicitAdmin, warnOnce } from './identity.js';
import { clearSavedSession, forgetInProcessSession, savedSession, setInProcessSession, type Session } from './admin-session-store.js';

export { ADMIN_SESSION_FILE, clearSavedSession, forgetInProcessSession, saveSession, savedSession } from './admin-session-store.js';

export function isAdminPath(path: string): boolean {
  return path.startsWith('/api/admin/') && !path.startsWith('/api/admin/session');
}

/** The credential file of the master container, when this process can read it. */
function masterKeyFile(): string | null {
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

export class AdminLoginError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** POST /api/admin/session with the credential → a session (kept in this process). */
export async function adminLogin(credential: string): Promise<Session> {
  let res: Response;
  try {
    res = await shellFetch('/api/admin/session', {
      method: 'POST',
      intent: 'credential-exchange',
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
  const session = { token: body.token, expiresAt: body.expiresAt };
  setInProcessSession(session, new URL(shellUrl()).origin);
  return session;
}

/**
 * Find the credential: AURA_ADMIN_CREDENTIAL, then (trusted shell only) the
 * master key file, then a hidden prompt. `recover` runs because a server said
 * 401, so it never prompts for a URL that is not the trusted shell.
 */
export async function obtainCredential(mode: 'login' | 'recover'): Promise<string | null> {
  const url = shellUrl();
  const explicit = process.env['AURA_ADMIN_CREDENTIAL']?.trim();
  if (explicit) {
    warnExplicitAdmin('AURA_ADMIN_CREDENTIAL', url);
    return explicit;
  }
  const trusted = isTrustedShellUrl(url);
  if (trusted) {
    const f = masterKeyFile();
    if (f) return readAdminCredential(f);
  } else if (mode === 'recover') {
    return null;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  if (!trusted) warnOnce('prompt-untrusted', `${url} is not this system's shell. Only type a credential if you trust it.`);
  return (await promptSecret('AuraOS admin credential (hidden): ')) || null;
}

/**
 * Called after a 401 admin-required: drop a stale session, then try to get a
 * fresh one for this command only. True when a new session is in place. A 401
 * from a URL that is not the trusted shell proves nothing, so the saved
 * session is left alone and only an explicit credential is used.
 */
export async function recoverAdminSession(): Promise<boolean> {
  if (process.env['AURA_ADMIN_SESSION']) return false; // the caller pinned one; don't second-guess it
  if (isTrustedShellUrl(shellUrl()) && savedSession()) clearSavedSession();
  forgetInProcessSession();
  const credential = await obtainCredential('recover').catch(() => null);
  if (!credential) return false;
  try {
    await adminLogin(credential);
    return true;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return false;
  }
}
