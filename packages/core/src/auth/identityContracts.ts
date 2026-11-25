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
   * `rateLimitKey` identifies the client. Without one there is no per-client
   * limit, because a shared bucket would let one caller lock out everyone.
   */
  verifyPassword(username: string, password: string, opts?: { rateLimitKey?: string }): Promise<PasswordCheck>;
}

// ── login sessions ──────────────────────────────────────────────────────────

export const LOGIN_SESSION_PREFIX = 'aura-sess1';

/** The shared admin credential's `shared-key` method is retired (D50). */
export type LoginMethod = 'password';

/** Signed token payload: `aura-sess1.<b64url payload>.<b64url MAC>`. */
export interface LoginSessionPayload {
  /** Session id. */
  s: string;
  /** Expiry, ms since the epoch. */
  e: number;
  m: LoginMethod;
  /** User id. */
  u: string;
}

export interface LoginSession {
  sessionId: string;
  expiresAt: number;
  method: LoginMethod;
  userId: string;
}

export type LoginSessionInput = { method: 'password'; userId: string; ttlMs?: number };

/** A live session as listed for its owner. Carries no token. */
export interface LoginSessionInfo {
  sessionId: string;
  method: LoginMethod;
  createdAt: number;
  expiresAt: number;
}

export interface LoginSessions {
  issue(input: LoginSessionInput): Promise<{ token: string; session: LoginSession }>;
  /** A valid, unexpired, unrevoked session, else null. Rejects only when the store fails. */
  verify(token: string | null | undefined): Promise<LoginSession | null>;
  /** True when a live session was removed. */
  revoke(sessionId: string): Promise<boolean>;
  /** How many sessions were removed. `except` keeps that one session. */
  revokeByUser(userId: string, opts?: { except?: string }): Promise<number>;
  /** The user's live sessions, oldest first. */
  listByUser(userId: string): Promise<LoginSessionInfo[]>;
  /** How many sessions were removed. */
  revokeByMethod(method: LoginMethod): Promise<number>;
}

// ── setup tickets ───────────────────────────────────────────────────────────

/**
 * `operator`: the host operator's word on one exact thing (D18), named by
 * `subject`: `approve:<approvalId>`, `deny:<approvalId>`, or
 * `<action>:<payloadHash>` for an action the operator confirmed at the host.
 */
export type SetupTicketPurpose = 'setup' | 'reset' | 'operator';

/** A one-time ticket as stored. The plaintext code is never written or logged. */
export interface SetupTicket {
  sha256: string;
  purpose: SetupTicketPurpose;
  expiresAt: number;
  /** The account a `reset` applies to. */
  username?: string;
  /** What an `operator` ticket vouches for. */
  subject?: string;
}

export interface SetupTickets {
  /**
   * Atomic and single-use: of any number of concurrent calls with the right
   * code, one gets the ticket. Null for a wrong, expired, used or
   * other-purpose code.
   */
  claim(code: string, purpose: SetupTicketPurpose): Promise<SetupTicket | null>;
}
