/**
 * The audit trail — the `audit:admin` Valkey stream (MAXLEN ~ 10000).
 *
 * One entry per admin change (unlock / lock, grant / revoke, API key create /
 * revoke, manifest edits, credential rotation) and per identity event (setup,
 * login, logout, password reset, ticket creation). The actor is the shared
 * admin credential, a signed-in `user:<id>`, the host `operator`, `system` or
 * `anonymous`.
 *
 * Passwords, codes, tokens and hashes never go in here: `detail` fields with
 * such names are dropped on write, at any depth.
 */
import type { Redis } from '@aura/kv-store';
import { ADMIN_AUDIT_LABEL, type AdminAttribution, type UserPrincipal } from './types.js';

export const AUDIT_ADMIN_KEY = 'audit:admin';
export const AUDIT_MAXLEN = 10_000;

export const IDENTITY_AUDIT_ACTIONS = {
  setup: 'auth.setup',
  login: 'auth.login',
  logout: 'auth.logout',
  passwordReset: 'auth.password-reset',
  ticketCreated: 'auth.ticket-created',
  recordTampered: 'auth.record-tampered',
  identityKeyError: 'auth.identity-key-error',
  ownerRecovered: 'auth.owner-recovered',
} as const;

export interface UserAttribution {
  kind: 'user';
  userId: string;
  /** Short prefix of the session id. */
  session?: string;
}
export interface OperatorAttribution { kind: 'operator' }

export function userAttribution(p: Pick<UserPrincipal, 'userId'> & { sessionId?: string }): UserAttribution {
  return { kind: 'user', userId: p.userId, ...(p.sessionId ? { session: p.sessionId.slice(0, 8) } : {}) };
}
export const operatorAttribution = (): OperatorAttribution => ({ kind: 'operator' });

export interface AuditEntry {
  /** Stream id `<ms>-<seq>`. */
  id: string;
  at: number;
  /** `admin (shared credential)`, `user:<id>`, `operator`, `system` or `anonymous`. */
  actor: string;
  session?: string;
  action: string;
  target?: string;
  /** ok | denied | failed */
  outcome: string;
  detail?: Record<string, unknown>;
}

export interface AuditInput {
  by: AdminAttribution | UserAttribution | OperatorAttribution | { kind: 'system' } | { kind: 'anonymous' };
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
  if (by.kind === 'admin') return ADMIN_AUDIT_LABEL;
  if (by.kind === 'user') return `user:${by.userId}`;
  return by.kind;
}

export class AdminAudit {
  constructor(private readonly redis: () => Redis, private readonly now: () => number = Date.now) {}

  async record(e: AuditInput): Promise<string> {
    const fields: string[] = ['at', String(this.now()), 'actor', actorOf(e.by), 'action', e.action, 'outcome', e.outcome ?? 'ok'];
    if ((e.by.kind === 'admin' || e.by.kind === 'user') && e.by.session) fields.push('session', e.by.session);
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
      };
    });
  }
}
