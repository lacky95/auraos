/**
 * GrantStore — permissions the owner GRANTED to a subject (central Valkey).
 *
 *   grant:<subjectKind>:<subjectId>   HASH  "<scopeKey>|<permission>" → JSON GrantRecord
 *   grant:idx                         SET   of the subject hash keys above
 *
 * The manifest REQUESTS a privileged permission; a grant here is the owner's
 * answer. `Authorizer` needs both. Grants are explicitly scoped
 * (`GrantScope`), so per-user grants can be added later without re-keying.
 * Today a grant is OS-wide (`{kind:'os'}`), except a Terminal embed grant for
 * ONE session (`{kind:'terminal-session', id}`, D25): the shell records it
 * when an app holding the OS-wide `terminal.embed` grant creates that session,
 * and it counts only while that OS-wide grant does.
 *
 * App grants are pinned to the app's install scope (`appScope`): a clone,
 * scaffold or store install that SHADOWS the app from another scope under the
 * same id does not inherit the grant (it has to be granted again). And they
 * are pinned to the app's installation (`installationId`, S1, 5-main, like
 * `app.use:<installationId>`): a grant counts only while that installation is
 * the app's current one (`appGrantCounts`), so a new app under the same id
 * and scope (`rm app` then `dev new`, a different-origin reinstall after a
 * keep-data uninstall, a reassigned origin) inherits nothing. Grants from
 * before 5-main are pinned once at boot (`attachInstallations`).
 *
 * A `user` subject (I.2, D82) holds only the app permissions
 * `app.use:<installationId>` (open and start the user's own instance) and
 * `app.jump:<installationId>` (jump into it, H/J), OS-wide. The owner or the
 * host operator grants them; nothing grants them implicitly.
 *
 * Subject, scope and installation ids never contain `@`: a qualified
 * (`…@systemId`) subject is a federation change (D85 A3), not a value.
 *
 * `grant:` is not a KvClient namespace, so `/api/kv` can't read or write it.
 * Every change emits `OsEventBus 'permissions:changed'` (content: subject,
 * permission, change — no secrets).
 */
import type { Redis } from '@aura/kv-store';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { describeReadScope, normalizeReadScope, type ReadGrant } from '../notifications/access.js';
import {
  OS_SCOPE, type AppGrantBinding, type ChangeAttribution, type GrantScope, type LegacyAdminAttribution, type GrantSubject, type GrantSubjectKind,
} from './types.js';

export const GRANT_PREFIX = 'grant:';
export const GRANT_INDEX_KEY = 'grant:idx';
export const grantKey = (s: GrantSubject) => `grant:${s.kind}:${s.id}`;

/**
 * Permissions that only take effect when the owner grants them.
 * `notifications.read` (phase 5) additionally carries a read scope
 * (`GrantRecord.read`): which senders, and whether secret items count.
 */
export const PRIVILEGED_PERMISSIONS = [
  'notifications.locked', 'notifications.popup', 'notifications.read', 'notifications.systemModal',
  // The owner's System Terminal (D25, D29, 5.16). `terminal.embed`: create
  // Terminal sessions and show and close the ones it created (each is also
  // granted per session). `terminal.sessions.list`: read every session's metadata.
  // `terminal.screen.read`: programmatic screen access (5.16), with the list
  // grant: whether a listed session's screen shows an agent at work.
  'terminal.embed', 'terminal.sessions.list', 'terminal.screen.read',
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

/**
 * Writing an OS-wide KV topic (`/api/kv/os/<topic>`: the theme, keymap, lock
 * screen, notification settings, ...): one family of privileged permissions,
 * one per topic. Declaring it only requests it; the owner grants it. The
 * owner acting through system Settings (D45) is the owner and needs none.
 */
export const KV_OS_WRITE_PERMISSION_RE = /^system\.kv\.os\.[A-Za-z0-9_-]{1,128}\.write$/;

/**
 * A user's app permissions (I.2, C7): `app.use:<installationId>` and
 * `app.jump:<installationId>`, granted to a `user` subject only. Same pattern
 * as `credential.read:<NAME>`: one grant per installation.
 */
export const USER_APP_PERMISSION_RE = /^app\.(use|jump):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const appUsePermission = (installationId: string): string => `app.use:${installationId}`;
export const appJumpPermission = (installationId: string): string => `app.jump:${installationId}`;

/**
 * Reading the raw value of a credential in a user's vault (D56): one grant
 * per app, credential and user (scope `{kind: 'user', id}`), given on the
 * owner's `fresh` approval and revocable. Never OS-wide. A handle alone
 * never reads a value.
 */
export const CREDENTIAL_READ_PERMISSION_RE = /^credential\.read:[A-Z_][A-Z0-9_]{0,63}$/;
export const credentialReadPermission = (name: string): string => `credential.read:${name}`;
/** The grant scope of one user's vault. */
export const userScope = (userId: string): GrantScope => ({ kind: 'user', id: userId });

/**
 * A user's Private Home for an app (D107-a, D108 P9): `home.private` (the app
 * process runs as that user with that user's Private Home) and
 * `home.private.sidecar:<name>` (one `owner-environment` sidecar of such an
 * instance gets the same). Same pattern as `credential.read:<NAME>`: an app
 * subject, scope `{kind: 'user', id}` (the home's own user), pinned to the
 * installation, never OS-wide. Given only on that user's forced + fresh
 * `app.setup.apply` approval (core setup/homeEnvironment.ts
 * `grantHomePrivate`), never by an install or update approval. The names are
 * setup/contracts.ts `HOME_PRIVATE_PERMISSION` / `homePrivateSidecarPermission`
 * (sidecar names: sidecar-spec.ts `SIDECAR_NAME_RE`).
 */
export const HOME_PRIVATE_PERMISSION_RE = /^home\.private(\.sidecar:[a-z][a-z0-9-]{0,47})?$/;

/**
 * A key of the system Context reaching an app (stream C, Q7): one grant per
 * app and key, OS-wide, pinned to the app's install scope. It counts only
 * while the app also declares the key in its manifest `context[]`; given by
 * the owner's install or update approval, by the owner directly, or by the
 * Phase 5 migration.
 */
export const CONTEXT_READ_PERMISSION_RE = /^context\.read:[A-Z_][A-Z0-9_]{0,127}$/;
export const contextReadPermission = (key: string): string => `context.read:${key}`;

export function isPrivilegedPermission(p: string): boolean {
  return (PRIVILEGED_PERMISSIONS as readonly string[]).includes(p) || KV_OS_WRITE_PERMISSION_RE.test(p)
    || CREDENTIAL_READ_PERMISSION_RE.test(p) || CONTEXT_READ_PERMISSION_RE.test(p) || HOME_PRIVATE_PERMISSION_RE.test(p);
}

const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** A Terminal session id, `<instanceId>#<label>` (com.aura.terminal pty-server). */
const TERMINAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}#[A-Za-z0-9._-]{1,64}$/;
const SUBJECT_KINDS: readonly GrantSubjectKind[] = ['app', 'apiKey', 'user'];
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A local user id as a grant subject: the form `user:<id>` records hold (lowercase, C10). */
const USER_SUBJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Who grants: the owner, the host operator or AuraOS itself (D50). */
export type GrantedBy = ChangeAttribution | { kind: 'system' };

export interface GrantRecord {
  subject: GrantSubject;
  permission: string;
  scope: GrantScope;
  /** App subjects: the install scope the grant was given for (system|global|user). */
  appScope?: string;
  /**
   * App subjects (S1): the installation the grant was given to; it counts only
   * while that installation is the app's current one. `null`: pinned to none
   * (the 5-main migration found no installation for it): it never counts and
   * is never attached later. Absent: a record from before 5-main, not
   * migrated yet: it does not count either.
   */
  installationId?: string | null;
  grantedAt: number;
  /** A record from before D50 may name the retired shared admin credential. */
  grantedBy: GrantedBy | LegacyAdminAttribution;
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

/**
 * Whether an app grant counts (S1): it exists, was given for the install scope
 * the app resolves to now (a shadowing copy from another scope has to be
 * granted again), and to the installation the app is now. The one rule for
 * every app grant: the Authorizer's privileged permissions, Context keys and
 * vault reads.
 */
export function appGrantCounts(record: Pick<GrantRecord, 'appScope' | 'installationId'> | null, current: AppGrantBinding): boolean {
  if (!record) return false;
  if (record.appScope && current.scope && record.appScope !== current.scope) return false;
  return typeof record.installationId === 'string' && record.installationId === current.installationId;
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
    // I.2: a user holds its app permissions and nothing else; nobody else holds them.
    const userApp = USER_APP_PERMISSION_RE.test(permission);
    if (subject.kind === 'user' || userApp) {
      if (subject.kind !== 'user' || !userApp || !USER_SUBJECT_ID.test(subject.id) || scope.kind !== 'os') {
        throw new GrantError(400, 'app.use:<installationId> and app.jump:<installationId> are a user\'s, OS-wide, and a user holds nothing else');
      }
      return;
    }
    if (!isPrivilegedPermission(permission)) {
      throw new GrantError(400, `'${permission}' cannot be granted here — grantable: ${GRANTABLE_PERMISSIONS.join(', ')}, system.kv.os.<topic>.write, credential.read:<NAME>, context.read:<KEY>, home.private[.sidecar:<name>]`);
    }
    if (CONTEXT_READ_PERMISSION_RE.test(permission) && (subject.kind !== 'app' || scope.kind !== 'os')) {
      throw new GrantError(400, 'a context.read:<KEY> grant is an app\'s, OS-wide');
    }
    const credential = CREDENTIAL_READ_PERMISSION_RE.test(permission);
    const home = HOME_PRIVATE_PERMISSION_RE.test(permission);
    if (credential || home || scope.kind === 'user') {
      if (!(credential || home) || scope.kind !== 'user' || subject.kind !== 'app' || typeof scope.id !== 'string' || !USER_ID.test(scope.id)) {
        throw new GrantError(400, home
          ? 'a home.private grant is an app\'s, for one user\'s own Private Home'
          : 'a credential.read:<NAME> grant is an app\'s, for one user\'s vault');
      }
      return;
    }
    if (scope.kind === 'os') return;
    if (scope.kind !== 'terminal-session' || permission !== TERMINAL_EMBED_PERMISSION || subject.kind !== 'app'
      || typeof scope.id !== 'string' || !TERMINAL_SESSION_ID.test(scope.id)) {
      throw new GrantError(400, 'only an app\'s terminal.embed grant can be scoped to one Terminal session');
    }
  }

  /**
   * Grant (idempotent; re-granting refreshes appScope, the installation and
   * the attribution, and for `notifications.read` replaces the read scope).
   * An app grant needs `opts.installationId`: the installation it is given to
   * (S1). `notifications.read` needs `opts.read` with an explicit scope.
   */
  async grant(
    subject: GrantSubject, permission: string,
    opts: {
      by: GrantedBy; appScope?: string; installationId?: string; scope?: GrantScope;
      read?: { scope: unknown; includeSecret?: boolean }; binding?: string;
    },
  ): Promise<{ record: GrantRecord; changed: boolean }> {
    permission = canonicalPermission(permission);
    const scope = opts.scope ?? OS_SCOPE;
    this.validate(subject, permission, scope);
    if (subject.kind !== 'app' && opts.installationId !== undefined) throw new GrantError(400, 'only an app grant is pinned to an installation');
    if (subject.kind === 'app' && (typeof opts.installationId !== 'string' || !SUBJECT_ID.test(opts.installationId))) {
      throw new GrantError(409, `an app grant is given to one installation of the app, and ${subject.id} has none`);
    }
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
      ...(subject.kind === 'app' ? { installationId: opts.installationId! } : {}),
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
    const changed = !prevRec || prevRec.appScope !== record.appScope || prevRec.installationId !== record.installationId || prevRec.binding !== record.binding
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
   * Drop an app's grants for one install scope: those pinned to `appScope`,
   * and unpinned ones (they would count in any scope). The app under that id
   * and scope was deleted or replaced by another app, so nothing the owner
   * granted to the previous one may pass to it (Hotfix 2, S1; temporary until
   * grants are bound to the installation). Each revoke emits
   * `permissions:changed`, so caches keyed on it (system modals) follow.
   */
  async revokeAppScope(appId: string, appScope: string): Promise<GrantRecord[]> {
    const subject: GrantSubject = { kind: 'app', id: appId };
    const drop = (await this.listFor(subject)).filter((g) => !g.appScope || g.appScope === appScope);
    for (const g of drop) await this.revoke(subject, g.permission, g.scope ?? OS_SCOPE);
    return drop;
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

  /**
   * S1 one-time migration (idempotent): every app grant from before 5-main
   * (no `installationId`) is pinned to the installation it was given to,
   * `installationOf(appId, appScope)`, or to none (`null`: it never counts and
   * is never attached later, so no future installation under that id
   * inherits it). `installationOf` throws on a read error: nothing is pinned
   * to none by a Valkey hiccup, the next boot retries. Returns what was
   * pinned (for the audit). No `permissions:changed` event: an unpinned
   * grant already does not count.
   */
  async attachInstallations(
    installationOf: (appId: string, appScope: string | undefined) => Promise<string | null>,
  ): Promise<Array<{ subject: GrantSubject; permission: string; scope: GrantScope; appScope?: string; installationId: string | null }>> {
    const r = this.redis();
    const out: Array<{ subject: GrantSubject; permission: string; scope: GrantScope; appScope?: string; installationId: string | null }> = [];
    for (const key of await r.smembers(GRANT_INDEX_KEY)) {
      if (!key.startsWith('grant:app:')) continue;
      for (const [f, raw] of Object.entries(await r.hgetall(key))) {
        let rec: GrantRecord;
        try { rec = JSON.parse(raw) as GrantRecord; } catch { continue; }
        if (rec.subject?.kind !== 'app' || rec.installationId !== undefined) continue;
        const installationId = await installationOf(rec.subject.id, rec.appScope);
        // A grant changed meanwhile (re-granted with its installation) keeps the newer record.
        if ((await r.hget(key, f)) !== raw) continue;
        await r.hset(key, f, JSON.stringify({ ...rec, installationId } satisfies GrantRecord));
        out.push({
          subject: rec.subject, permission: rec.permission, scope: rec.scope ?? OS_SCOPE,
          ...(rec.appScope ? { appScope: rec.appScope } : {}), installationId,
        });
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
