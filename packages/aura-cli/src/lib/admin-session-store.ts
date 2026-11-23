/**
 * Where the CLI keeps an admin session: this process, or the 0600 file written
 * by `aura admin login --save`. No network and no trust decisions: those are
 * in identity.ts.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ADMIN_SESSION_FILE = join(homedir(), '.aura', 'admin-session');

export interface Session { token: string; expiresAt: number }

let inProcess: (Session & { origin: string }) | null = null;

/** The session obtained by this command, only for the origin that issued it. */
export function inProcessSession(origin: string | null): Session | null {
  if (!inProcess || inProcess.origin !== origin || inProcess.expiresAt <= Date.now()) return null;
  return inProcess;
}

export function setInProcessSession(session: Session, origin: string): void {
  inProcess = { ...session, origin };
}

export function forgetInProcessSession(): void {
  inProcess = null;
}

export function savedSession(): Session | null {
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
