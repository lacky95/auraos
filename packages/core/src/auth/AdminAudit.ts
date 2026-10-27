/**
 * Admin audit trail — the `audit:admin` Valkey stream (MAXLEN ~ 10000).
 *
 * Every admin change (unlock / lock, grant / revoke, API key create / revoke,
 * manifest edits, credential rotation) is one entry. The actor is always
 * "admin (shared credential)": AuraOS has no user accounts, so no entry ever
 * names an individual person. Secrets never go in here.
 */
import type { Redis } from '@aura/kv-store';
import { ADMIN_AUDIT_LABEL, type AdminAttribution } from './types.js';

export const AUDIT_ADMIN_KEY = 'audit:admin';
export const AUDIT_MAXLEN = 10_000;

export interface AuditEntry {
  /** Stream id `<ms>-<seq>`. */
  id: string;
  at: number;
  /** Always `admin (shared credential)` (or `system` for in-process changes). */
  actor: string;
  session?: string;
  action: string;
  target?: string;
  /** ok | denied | failed */
  outcome: string;
  detail?: Record<string, unknown>;
}

export interface AuditInput {
  by: AdminAttribution | { kind: 'system' } | { kind: 'anonymous' };
  action: string;
  target?: string;
  outcome?: 'ok' | 'denied' | 'failed';
  detail?: Record<string, unknown>;
}

export class AdminAudit {
  constructor(private readonly redis: () => Redis, private readonly now: () => number = Date.now) {}

  async record(e: AuditInput): Promise<string> {
    const actor = e.by.kind === 'admin' ? ADMIN_AUDIT_LABEL : e.by.kind;
    const fields: string[] = ['at', String(this.now()), 'actor', actor, 'action', e.action, 'outcome', e.outcome ?? 'ok'];
    if (e.by.kind === 'admin' && e.by.session) fields.push('session', e.by.session);
    if (e.target) fields.push('target', e.target);
    if (e.detail) fields.push('detail', JSON.stringify(e.detail));
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
