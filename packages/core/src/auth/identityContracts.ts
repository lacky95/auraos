/**
 * Contracts for the owner account, login sessions and setup tickets (D5, D16,
 * 5.6). Implemented by `ValkeyUserStore`, `LoginSessionStore` and
 * `FileSetupTickets`.
 *
 * No method returns a password hash, and tickets hold only the code's SHA-256.
 */
import { DEFAULT_USER_ID } from '../scopes/ScopeRegistry.js';
import type { UserRole } from './types.js';

/** The first account keeps this id, so `/data/scopes/users/default` stays put. */
export const DEFAULT_OWNER_ID = DEFAULT_USER_ID;

// ── accounts ────────────────────────────────────────────────────────────────

/** A user record without its password hash. */
export interface UserAccount {
  id: string;
  username: string;
  role: UserRole;
  createdAt: number;
  disabled: boolean;
}

/**
 * `invalid` covers an unknown user, a wrong password and a disabled account
 * alike, so a caller can't tell them apart.
 */
export type PasswordCheck =
  | { ok: true; user: UserAccount }
  | { ok: false; reason: 'invalid' | 'rate-limited' };

export interface UserStore {
  hasOwner(): Promise<boolean>;
  getOwner(): Promise<UserAccount | null>;
  /** Create-once and atomic: null when an owner already exists. */
  createOwner(input: { username: string; password: string }): Promise<UserAccount | null>;
  /**
   * Rate-limited before any hashing. Never throws on a bad password.
   * `rateLimitKey` identifies the client for the per-client limit (default: the username).
   */
  verifyPassword(username: string, password: string, opts?: { rateLimitKey?: string }): Promise<PasswordCheck>;
  /** False for an unknown user. Revoking sessions is the caller's step. */
  setPassword(userId: string, password: string): Promise<boolean>;
}

// ── login sessions ──────────────────────────────────────────────────────────

export const LOGIN_SESSION_PREFIX = 'aura-sess1';

export type LoginMethod = 'password' | 'shared-key';

/**
 * Signed token payload: `<prefix>.<b64url payload>.<b64url MAC>`. The prefix is
 * `aura-sess1` for password sessions and `aura-admin1` for shared-key sessions.
 */
export interface LoginSessionPayload {
  /** Session id. */
  s: string;
  /** Expiry, ms since the epoch. */
  e: number;
  m: LoginMethod;
  /** User id, for `password` sessions. */
  u?: string;
  /** Shared-key fingerprint, for `shared-key` sessions. */
  f?: string;
}

export interface LoginSession {
  sessionId: string;
  expiresAt: number;
  method: LoginMethod;
  userId?: string;
  keyFingerprint?: string;
}

export type LoginSessionInput =
  | { method: 'password'; userId: string; ttlMs?: number }
  | { method: 'shared-key'; keyFingerprint: string; userId?: string; ttlMs?: number };

export interface LoginSessions {
  issue(input: LoginSessionInput): Promise<{ token: string; session: LoginSession }>;
  /** A valid, unexpired, unrevoked session, else null. Never throws on bad input. */
  verify(token: string | null | undefined): Promise<LoginSession | null>;
  /** True when a live session was removed. */
  revoke(sessionId: string): Promise<boolean>;
  /** How many sessions were removed. */
  revokeByUser(userId: string): Promise<number>;
  /** How many sessions were removed. */
  revokeByMethod(method: LoginMethod): Promise<number>;
}

// ── setup tickets ───────────────────────────────────────────────────────────

export type SetupTicketPurpose = 'setup' | 'reset';

/** A one-time ticket as stored. The plaintext code is never written or logged. */
export interface SetupTicket {
  sha256: string;
  purpose: SetupTicketPurpose;
  expiresAt: number;
  /** The account a `reset` applies to. */
  username?: string;
}

export interface SetupTickets {
  write(ticket: SetupTicket): Promise<void>;
  /**
   * Atomic and single-use: of any number of concurrent calls with the right
   * code, one gets the ticket. Null for a wrong, expired, used or
   * other-purpose code.
   */
  claim(code: string, purpose: SetupTicketPurpose): Promise<SetupTicket | null>;
}
