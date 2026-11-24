/**
 * GrantStore — permissions an admin GRANTED to a subject (central Valkey).
 *
 *   grant:<subjectKind>:<subjectId>   HASH  "<scopeKey>|<permission>" → JSON GrantRecord
 *   grant:idx                         SET   of the subject hash keys above
 *
 * The manifest REQUESTS a privileged permission; a grant here is the admin's
 * answer. `Authorizer` needs both. Grants are explicitly scoped
 * (`GrantScope`), so per-user grants can be added later without re-keying.
 * Today a grant is OS-wide (`{kind:'os'}`), except a Terminal embed grant for
 * ONE session (`{kind:'terminal-session', id}`, D25): the shell records it
 * when an app holding the OS-wide `terminal.embed` grant creates that session,
 * and it counts only while that OS-wide grant does.
 *
 * App grants are pinned to the app's install scope (`appScope`): a clone,
 * scaffold or store install that SHADOWS the app from another scope under the
 * same id does not inherit the grant (it has to be granted again).
 *
 * `grant:` is not a KvClient namespace, so `/api/kv` can't read or write it.
 * Every change emits `OsEventBus 'permissions:changed'` (content: subject,
 * permission, change — no secrets).
 */
import type { Redis } from '@aura/kv-store';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { describeReadScope, normalizeReadScope, type ReadGrant } from '../notifications/access.js';
import { OS_SCOPE, type AdminAttribution, type GrantScope, type GrantSubject, type GrantSubjectKind } from './types.js';

export const GRANT_PREFIX = 'grant:';
export const GRANT_INDEX_KEY = 'grant:idx';
export const grantKey = (s: GrantSubject) => `grant:${s.kind}:${s.id}`;

/**
 * Permissions that only take effect when an admin grants them.
 * `notifications.read` (phase 5) additionally carries a read scope
 * (`GrantRecord.read`): which senders, and whether secret items count.
 */
export const PRIVILEGED_PERMISSIONS = [
  'notifications.locked', 'notifications.popup', 'notifications.read', 'notifications.systemModal',
  // The owner's System Terminal (D25, D29, 5.16). `terminal.embed`: create
  // Terminal sessions and show and close the ones it created (each is also
  // granted per session). `terminal.sessions.list`: read every session's metadata.
  'terminal.embed', 'terminal.sessions.list',
] as const;
/**
 * Deprecated permission names → their current name. Accepted by grant /
 * revoke / get (and the Authorizer for manifest permissions[]) so nothing
 * breaks mid-migration; `migrateLegacy()` rewrites stored grants once.
 */
export const LEGACY_PERMISSION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'notifications.desktopModal': 'notifications.systemModal',
});
/** The current name of a (possibly deprecated) permission. */
export function canonicalPermission(p: string): string {
  return LEGACY_PERMISSION_ALIASES[p] ?? p;
}
export const NOTIFICATIONS_READ_PERMISSION = 'notifications.read';
export const TERMINAL_EMBED_PERMISSION = 'terminal.embed';
export const TERMINAL_SESSIONS_LIST_PERMISSION = 'terminal.sessions.list';
export type PrivilegedPermission = typeof PRIVILEGED_PERMISSIONS[number];
/** What GrantStore accepts. Deliberately not "any permission": no generic bypass. */
export const GRANTABLE_PERMISSIONS: readonly string[] = [...PRIVILEGED_PERMISSIONS];

export function isPrivilegedPermission(p: string): p is PrivilegedPermission {
  return (PRIVILEGED_PERMISSIONS as readonly string[]).includes(p);
}

const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** A Terminal session id, `<instanceId>#<label>` (com.aura.terminal pty-server). */
const TERMINAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}#[A-Za-z0-9._-]{1,64}$/;
const SUBJECT_KINDS: readonly GrantSubjectKind[] = ['app', 'apiKey'];

export type GrantedBy = AdminAttribution | { kind: 'system' };

export interface GrantRecord {
  subject: GrantSubject;
  permission: string;
  scope: GrantScope;
  /** App subjects: the install scope the grant was given for (system|global|user). */
  appScope?: string;
  grantedAt: number;
  grantedBy: GrantedBy;
  /** `notifications.read` only: what the grant lets the subject read. */
  read?: ReadGrant;
  /**
   * A Terminal session grant only: the life of the Terminal instance the
   * session was created in (`InstanceTokens.lifetimeId`). Session names are
   * reused, so the grant counts only while that same life runs.
   */
  binding?: string;
}

export interface PermissionsChangedEvent {
  subjectKind: GrantSubjectKind;
  subjectId: string;
  permission: string;
  change: 'granted' | 'revoked';
}

export class GrantError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GrantError';
  }
}

function scopeKey(scope: GrantScope): string {
  return scope.kind === 'os' ? scope.kind : `${scope.kind}:${scope.id}`;
}

/** The grant of `permission` for one Terminal session. */
export const terminalSessionScope = (sessionId: string): GrantScope => ({ kind: 'terminal-session', id: sessionId });

function field(permission: string, scope: GrantScope): string {
  return `${scopeKey(scope)}|${permission}`;
}

export class GrantStore {
  constructor(private readonly redis: () => Redis, private readonly now: () => number = Date.now) {}

  private validate(subject: GrantSubject, permission: string, scope: GrantScope = OS_SCOPE): void {
    permission = canonicalPermission(permission);
    if (!SUBJECT_KINDS.includes(subject.kind)) throw new GrantError(400, `subject kind must be one of ${SUBJECT_KINDS.join(', ')}`);
    if (typeof subject.id !== 'string' || !SUBJECT_ID.test(subject.id)) throw new GrantError(400, 'invalid subject id');
    if (!GRANTABLE_PERMISSIONS.includes(permission)) {
      throw new GrantError(400, `'${permission}' cannot be granted here — grantable: ${GRANTABLE_PERMISSIONS.join(', ')}`);
    }
    if (scope.kind === 'os') return;
    if (scope.kind !== 'terminal-session' || permission !== TERMINAL_EMBED_PERMISSION || subject.kind !== 'app'
      || typeof scope.id !== 'string' || !TERMINAL_SESSION_ID.test(scope.id)) {
      throw new GrantError(400, 'only an app\'s terminal.embed grant can be scoped to one Terminal session');
    }
  }

  /**
   * Grant (idempotent; re-granting refreshes appScope + attribution, and for
   * `notifications.read` replaces the read scope). `notifications.read`
   * needs `opts.read` with an explicit scope.
   */
  async grant(
    subject: GrantSubject, permission: string,
    opts: { by: GrantedBy; appScope?: string; scope?: GrantScope; read?: { scope: unknown; includeSecret?: boolean }; binding?: string },
  ): Promise<{ record: GrantRecord; changed: boolean }> {
    permission = canonicalPermission(permission);
    const scope = opts.scope ?? OS_SCOPE;
    this.validate(subject, permission, scope);
    if (opts.binding !== undefined
      && (scope.kind !== 'terminal-session' || typeof opts.binding !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(opts.binding))) {
      throw new GrantError(400, 'only a Terminal session grant can be bound to an instance life');
    }
    let read: ReadGrant | undefined;
    if (permission === NOTIFICATIONS_READ_PERMISSION) {
      if (!opts.read) throw new GrantError(400, `'${permission}' needs a read scope: apps, senders or all (e.g. --scope app:com.example.x)`);
      try { read = { scope: normalizeReadScope(opts.read.scope), includeSecret: opts.read.includeSecret === true }; }
      catch (err) { throw new GrantError(400, (err as Error).message); }
    }
    const record: GrantRecord = {
      subject: { kind: subject.kind, id: subject.id },
      permission,
      scope: { ...scope },
      ...(opts.appScope ? { appScope: opts.appScope } : {}),
      grantedAt: this.now(),
      grantedBy: opts.by,
      ...(read ? { read } : {}),
      ...(opts.binding ? { binding: opts.binding } : {}),
    };
    const r = this.redis();
    const key = grantKey(subject);
    const prev = await r.hget(key, field(permission, scope));
    await r.multi().hset(key, field(permission, scope), JSON.stringify(record)).sadd(GRANT_INDEX_KEY, key).exec();
    const prevRec = prev ? (JSON.parse(prev) as GrantRecord) : null;
    const changed = !prevRec || prevRec.appScope !== record.appScope || prevRec.binding !== record.binding
      || JSON.stringify(prevRec.read ?? null) !== JSON.stringify(record.read ?? null);
    if (changed) this.emit({ subjectKind: subject.kind, subjectId: subject.id, permission, change: 'granted' });
    return { record, changed };
  }

  /**
   * Revoke. Returns the removed record, or null when there was none. Revoking
   * an OS-wide grant also drops the subject's narrower grants of it (the
   * per-session Terminal embed grants), so nothing outlives the owner's answer.
   */
  async revoke(subject: GrantSubject, permission: string, scope: GrantScope = OS_SCOPE): Promise<GrantRecord | null> {
    permission = canonicalPermission(permission);
    this.validate(subject, permission, scope);
    const r = this.redis();
    const key = grantKey(subject);
    const prev = await r.hget(key, field(permission, scope));
    const narrower = scope.kind === 'os'
      ? Object.keys(await r.hgetall(key)).filter((f) => f.endsWith(`|${permission}`) && f !== field(permission, scope))
      : [];
    if (narrower.length) await r.hdel(key, ...narrower);
    if (!prev) {
      if (narrower.length && (await r.hlen(key)) === 0) await r.multi().del(key).srem(GRANT_INDEX_KEY, key).exec();
      return null;
    }
    await r.hdel(key, field(permission, scope));
    if ((await r.hlen(key)) === 0) await r.multi().del(key).srem(GRANT_INDEX_KEY, key).exec();
    this.emit({ subjectKind: subject.kind, subjectId: subject.id, permission, change: 'revoked' });
    return JSON.parse(prev) as GrantRecord;
  }

  /**
   * Drop every subject's grant of `permission` in the narrower scopes `match`
   * selects (a Terminal session ended, or its whole instance). Returns how many.
   */
  async revokeScopes(permission: string, match: (scope: GrantScope) => boolean): Promise<number> {
    permission = canonicalPermission(permission);
    const r = this.redis();
    let n = 0;
    for (const key of await r.smembers(GRANT_INDEX_KEY)) {
      let dropped = 0;
      for (const [f, raw] of Object.entries(await r.hgetall(key))) {
        let rec: GrantRecord;
        try { rec = JSON.parse(raw) as GrantRecord; } catch { continue; }
        if (rec.permission !== permission || !rec.scope || rec.scope.kind === 'os' || !match(rec.scope)) continue;
        await r.hdel(key, f);
        dropped++;
        this.emit({ subjectKind: rec.subject.kind, subjectId: rec.subject.id, permission, change: 'revoked' });
      }
      n += dropped;
      if (dropped && (await r.hlen(key)) === 0) await r.multi().del(key).srem(GRANT_INDEX_KEY, key).exec();
    }
    return n;
  }

  /** The grant record of one permission, or null. Read live on every check (no cache). */
  async get(subject: GrantSubject, permission: string, scope: GrantScope = OS_SCOPE): Promise<GrantRecord | null> {
    permission = canonicalPermission(permission);
    const raw = await this.redis().hget(grantKey(subject), field(permission, scope));
    return raw ? (JSON.parse(raw) as GrantRecord) : null;
  }

  /** Every grant of one subject. */
  async listFor(subject: GrantSubject): Promise<GrantRecord[]> {
    const all = await this.redis().hgetall(grantKey(subject));
    return Object.values(all).map((v) => JSON.parse(v) as GrantRecord)
      .sort((a, b) => a.permission.localeCompare(b.permission));
  }

  /** Every grant in the OS. */
  async listAll(): Promise<GrantRecord[]> {
    const r = this.redis();
    const keys = (await r.smembers(GRANT_INDEX_KEY)).sort();
    const out: GrantRecord[] = [];
    for (const k of keys) {
      for (const v of Object.values(await r.hgetall(k))) out.push(JSON.parse(v) as GrantRecord);
    }
    return out;
  }

  /** Drop every grant of a subject (e.g. its API key was revoked). */
  async revokeAll(subject: GrantSubject): Promise<number> {
    const recs = await this.listFor(subject);
    for (const rec of recs) await this.revoke(subject, rec.permission, rec.scope);
    return recs.length;
  }

  /**
   * One-time migration (idempotent): stored grants of a deprecated permission
   * name (`notifications.desktopModal`) become the current name
   * (`notifications.systemModal`) — same subject, scope, appScope pinning,
   * attribution and grant time. Returns what was migrated (for the audit).
   * No `permissions:changed` event: the effective rights do not change.
   */
  async migrateLegacy(): Promise<Array<{ subject: GrantSubject; from: string; to: string }>> {
    const r = this.redis();
    const out: Array<{ subject: GrantSubject; from: string; to: string }> = [];
    for (const key of await r.smembers(GRANT_INDEX_KEY)) {
      const all = await r.hgetall(key);
      for (const [f, raw] of Object.entries(all)) {
        let rec: GrantRecord;
        try { rec = JSON.parse(raw) as GrantRecord; } catch { continue; }
        const to = LEGACY_PERMISSION_ALIASES[rec.permission];
        if (!to) continue;
        const next: GrantRecord = { ...rec, permission: to };
        const nf = field(to, rec.scope ?? OS_SCOPE);
        const m = r.multi();
        if (!all[nf]) m.hset(key, nf, JSON.stringify(next));
        m.hdel(key, f);
        await m.exec();
        out.push({ subject: rec.subject, from: rec.permission, to });
      }
    }
    return out;
  }

  /** Human form of a grant's read scope (`all`, `app:x,sender:y`), for lists and the CLI. */
  static describeRead(rec: GrantRecord): string | undefined {
    return rec.read ? `${describeReadScope(rec.read.scope)}${rec.read.includeSecret ? ' +secret' : ''}` : undefined;
  }

  private emit(ev: PermissionsChangedEvent): void {
    try { OsEventBus.emit('permissions:changed', ev); } catch { /* the bus must never break a grant */ }
  }
}
