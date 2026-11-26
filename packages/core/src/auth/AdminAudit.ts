/**
 * The audit trail — the `audit:admin` Valkey stream (MAXLEN ~ 10000).
 *
 * One entry per owner change (grant / revoke, API key create / revoke,
 * manifest edits, approvals) and per identity event (setup, login, logout,
 * password reset or change, policy change, ticket creation). The actor is the
 * owner `user:<id>` (also when the owner approved an app's request; the
 * detail names the requester), the host `operator`, `system` or `anonymous`.
 * Entries from before D50 may name `admin (shared credential)`.
 *
 * Users are named by id, never by username (C6, D83): `user:<userId>` as
 * actor or target, the username at most in `detail`. Build the actor with
 * `actorOf` from an attribution; never parse `user:` back.
 *
 * D85 A3b: `actor` and `target` are local to the entry's `sys`. A foreign
 * principal would be written qualified (`user:<id>@<systemId>`), never bare;
 * no alpha path writes one.
 *
 * Passwords, codes, tokens and hashes never go in here: `detail` fields with
 * such names are dropped on write, at any depth.
 */
import type { Redis } from '@aura/kv-store';
import type { OperatorAttribution, UserAttribution, UserPrincipal } from './types.js';
import { localSystemId } from '../system/systemIdentity.js';

export type { OperatorAttribution, UserAttribution } from './types.js';

export const AUDIT_ADMIN_KEY = 'audit:admin';
export const AUDIT_MAXLEN = 10_000;

export const IDENTITY_AUDIT_ACTIONS = {
  setup: 'auth.setup',
  login: 'auth.login',
  logout: 'auth.logout',
  ticketCreated: 'auth.ticket-created',
  recordTampered: 'auth.record-tampered',
  identityKeyError: 'auth.identity-key-error',
  ownerRecovered: 'auth.owner-recovered',
  passwordChanged: 'auth.password-changed',
  passwordPolicyChanged: 'auth.password-policy-changed',
  passwordPolicyTampered: 'auth.password-policy-tampered',
  sessionsRevoked: 'auth.sessions-revoked',
  // I.2 (D82): member accounts. Created and disabled only by the host operator (5-main).
  userCreated: 'auth.user-created',
  userDisabled: 'auth.user-disabled',
  userEnabled: 'auth.user-enabled',
  /** D82 disable: the user's Terminal instances and jump sessions ended (kernel `endUserSessions`). */
  userSessionsEnded: 'auth.user-sessions-ended',
  /** A member's `app.use` / `app.jump` grant given or revoked by the host operator. */
  userGrant: 'auth.user-grant',
  /** A member's enrolment or reset with a one-time code (the owner's is `ownerRecovered`). */
  passwordReset: 'auth.password-reset',
} as const;

export function userAttribution(p: Pick<UserPrincipal, 'userId'> & { sessionId?: string }): UserAttribution {
  return { kind: 'user', userId: p.userId, ...(p.sessionId ? { session: p.sessionId.slice(0, 8) } : {}) };
}
export const operatorAttribution = (): OperatorAttribution => ({ kind: 'operator' });

export interface AuditEntry {
  /** Stream id `<ms>-<seq>`. */
  id: string;
  at: number;
  /** `user:<id>`, `operator`, `system` or `anonymous` (`admin (shared credential)` before D50). */
  actor: string;
  session?: string;
  action: string;
  target?: string;
  /** ok | denied | failed */
  outcome: string;
  detail?: Record<string, unknown>;
  /** The Aura the entry was written on (D47); absent on entries from before 3b. */
  systemId?: string;
}

export interface AuditInput {
  by: UserAttribution | OperatorAttribution | { kind: 'system' } | { kind: 'anonymous' };
  action: string;
  target?: string;
  outcome?: 'ok' | 'denied' | 'failed';
  detail?: Record<string, unknown>;
}

const SECRET_FIELD = /pass(word|wd|phrase)|secret|token|hash|credential|^(setup|reset|ticket)?_?code$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => !SECRET_FIELD.test(k))
      .map(([k, v]) => [k, scrub(v, depth + 1)]));
  }
  return value;
}

function actorOf(by: AuditInput['by']): string {
  if (by.kind === 'user') return `user:${by.userId}`;
  return by.kind;
}

export class AdminAudit {
  constructor(
    private readonly redis: () => Redis,
    private readonly now: () => number = Date.now,
    private readonly systemId: () => string = () => localSystemId(),
  ) {}

  async record(e: AuditInput): Promise<string> {
    const fields: string[] = ['at', String(this.now()), 'actor', actorOf(e.by), 'action', e.action, 'outcome', e.outcome ?? 'ok'];
    if (e.by.kind === 'user' && e.by.session) fields.push('session', e.by.session);
    try { fields.push('sys', this.systemId()); } catch { /* an unreadable identity must not lose the entry */ }
    if (e.target) fields.push('target', e.target);
    if (e.detail) fields.push('detail', JSON.stringify(scrub(e.detail)));
    const id = await this.redis().xadd(AUDIT_ADMIN_KEY, 'MAXLEN', '~', String(AUDIT_MAXLEN), '*', ...fields);
    return id ?? '';
  }

  /** Newest first. */
  async list(limit = 100): Promise<AuditEntry[]> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit) || 100));
    const rows = await this.redis().xrevrange(AUDIT_ADMIN_KEY, '+', '-', 'COUNT', n);
    return rows.map(([id, f]) => {
      const m: Record<string, string> = {};
      for (let i = 0; i + 1 < f.length; i += 2) m[f[i]!] = f[i + 1]!;
      let detail: Record<string, unknown> | undefined;
      try { detail = m['detail'] ? JSON.parse(m['detail']) as Record<string, unknown> : undefined; } catch { detail = undefined; }
      return {
        id, at: Number(m['at'] ?? 0), actor: m['actor'] ?? '', action: m['action'] ?? '',
        outcome: m['outcome'] ?? 'ok',
        ...(m['session'] ? { session: m['session'] } : {}),
        ...(m['target'] ? { target: m['target'] } : {}),
        ...(detail ? { detail } : {}),
        ...(m['sys'] ? { systemId: m['sys'] } : {}),
      };
    });
  }
}
