/**
 * Who may read which notification, and in which VIEW (phase 5).
 *
 * Two separate questions, never mixed:
 *
 *   READ ACCESS   — may this viewer see the item at all?
 *     system / admin / in-process      everything
 *     verified app (instance), API key its OWN items, plus whatever an admin
 *                                      granted with `notifications.read`
 *                                      (scope apps / senders / all; secret
 *                                      items only with `includeSecret`)
 *     shell screen (anonymous caller   every item, in the view of its lock
 *       with a client session)         state (below)
 *     anonymous WITHOUT a session      nothing
 *
 *   LOCK-SCREEN VIEW — only for shell screens. A locked (or unknown /
 *   expired) client session gets, by the EFFECTIVE visibility:
 *     public  → the content, but no components / interactions / answer
 *     private → sender + `publicTitle`/`publicText` (or a generic title)
 *     secret  → nothing at all (left out of lists, 404, not streamed)
 *   The effective visibility is the STRICTER of the sender's label and the
 *   user's per-sender override in `os/notifications.lockscreen`; `hideAll`
 *   makes everything secret.
 *
 * Visibility never grants read access: `public` is about the lock screen,
 * not about other apps.
 */
import type {
  LockState,
} from '../auth/ClientSessions.js';
import type {
  Notification, NotificationPrincipal, NotificationVisibility, StoredNotification,
} from './types.js';
import { isSystemCaller } from './types.js';

// ---------------------------------------------------------------------------
// Read grants (`notifications.read`)
// ---------------------------------------------------------------------------

export const READ_PERMISSION = 'notifications.read';

/**
 * What a `notifications.read` grant covers. `'*'` = every sender. Otherwise
 * a union of app ids (their verified `app:<id>` items) and exact sender keys
 * (`app:<id>`, `key:<keyId>`, `auraos`, `anon:rest`, …).
 * Subjects today: apps and API keys; the shape stays the same when `user` /
 * `agent` subjects arrive.
 */
export type ReadScope = '*' | { apps?: string[]; senders?: string[] };

export interface ReadGrant {
  scope: ReadScope;
  /** Secret items too. Default false. */
  includeSecret: boolean;
}

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,199}$/;

/** Validate / normalise a read scope from user input (CLI, Settings, REST). Throws on garbage. */
export function normalizeReadScope(raw: unknown): ReadScope {
  if (raw === '*' || raw === 'all' || (raw && typeof raw === 'object' && (raw as { all?: unknown }).all === true)) return '*';
  if (typeof raw === 'string') {
    // CLI form: "app:<id>,sender:<key>,all"
    const apps: string[] = [];
    const senders: string[] = [];
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (part === 'all' || part === '*') return '*';
      const m = /^(app|sender):(.+)$/.exec(part);
      if (!m) throw new Error(`invalid read scope '${part}' — use app:<appId>, sender:<senderKey> or all`);
      (m[1] === 'app' ? apps : senders).push(m[2]!);
    }
    return normalizeReadScope({ apps, senders });
  }
  if (!raw || typeof raw !== 'object') throw new Error('read scope required: {apps:[…]}, {senders:[…]} or "*"');
  const o = raw as { apps?: unknown; senders?: unknown };
  const list = (v: unknown, what: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${what} must be a list`);
    const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
    for (const x of out) if (!SCOPE_ID.test(x)) throw new Error(`invalid ${what} entry '${x}'`);
    if (out.length > 100) throw new Error(`at most 100 ${what}`);
    return out.sort();
  };
  const apps = list(o.apps, 'apps');
  const senders = list(o.senders, 'senders');
  if (apps.length === 0 && senders.length === 0) throw new Error('read scope is empty — name apps, senders, or all');
  return { ...(apps.length ? { apps } : {}), ...(senders.length ? { senders } : {}) };
}

export function readScopeCovers(scope: ReadScope, senderKey: string): boolean {
  if (scope === '*') return true;
  if (scope.senders?.includes(senderKey)) return true;
  if (senderKey.startsWith('app:') && scope.apps?.includes(senderKey.slice(4))) return true;
  return false;
}

export function describeReadScope(scope: ReadScope): string {
  if (scope === '*') return 'all';
  return [...(scope.apps ?? []).map((a) => `app:${a}`), ...(scope.senders ?? []).map((s) => `sender:${s}`)].join(',');
}

// ---------------------------------------------------------------------------
// User settings (`os/notifications`)
// ---------------------------------------------------------------------------

export type RetentionDays = number | 'forever';

export interface NotificationSettings {
  lockscreen: {
    /** Treat everything as secret on the lock screen. */
    hideAll: boolean;
    /** senderKey → the user's override (only ever makes things stricter). */
    apps: Record<string, NotificationVisibility>;
  };
  retention: {
    /** How long ended (resolved / removed) items are kept. Default 7 days. */
    days: RetentionDays;
    /** senderKey → its own retention. */
    apps: Record<string, RetentionDays>;
  };
  /**
   * Phase 6: blocking desktop modals per sender (sliding window). `limit`
   * 'unlimited' disables it (globally, or for one sender in `perSender`).
   * Force-hide + its per-tab suppression stay the loop protection either way.
   */
  desktopModal: {
    limit: number | 'unlimited';
    windowMinutes: number;
    /** senderKey → its own limit. */
    perSender: Record<string, number | 'unlimited'>;
  };
}

export const DEFAULT_DESKTOP_MODAL_LIMIT = 5;
export const DEFAULT_DESKTOP_MODAL_WINDOW_MINUTES = 10;
export const MAX_DESKTOP_MODAL_LIMIT = 1000;
export const MAX_DESKTOP_MODAL_WINDOW_MINUTES = 24 * 60;

export const DEFAULT_RETENTION_DAYS = 7;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = Object.freeze({
  lockscreen: Object.freeze({ hideAll: false, apps: Object.freeze({}) }),
  retention: Object.freeze({ days: DEFAULT_RETENTION_DAYS, apps: Object.freeze({}) }),
  desktopModal: Object.freeze({ limit: DEFAULT_DESKTOP_MODAL_LIMIT, windowMinutes: DEFAULT_DESKTOP_MODAL_WINDOW_MINUTES, perSender: Object.freeze({}) }),
}) as NotificationSettings;

/** 'unlimited' / 0 / null → unlimited; a number → 1..1000; anything else → undefined. */
function modalLimit(v: unknown): number | 'unlimited' | undefined {
  if (v === 'unlimited' || v === 0 || v === null || v === '0') return 'unlimited';
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return Math.min(MAX_DESKTOP_MODAL_LIMIT, Math.max(1, Math.round(n)));
}

const VIS: readonly NotificationVisibility[] = ['public', 'private', 'secret'];

/** A settings key → senderKey. Bare app ids mean `app:<id>`. */
export function settingsSenderKey(k: string): string {
  return k.includes(':') || k === 'auraos' ? k : `app:${k}`;
}

function retention(v: unknown): RetentionDays | undefined {
  if (v === 'forever' || v === null || v === 0) return 'forever';
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(n)));
}

/** Parse the stored `os/notifications` value leniently: garbage → defaults, never a throw. */
export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { lockscreen?: unknown; retention?: unknown; desktopModal?: unknown };
  const ls = (o.lockscreen && typeof o.lockscreen === 'object' ? o.lockscreen : {}) as { hideAll?: unknown; apps?: unknown };
  const rt = (o.retention && typeof o.retention === 'object' ? o.retention : {}) as { days?: unknown; apps?: unknown };
  const lsApps: Record<string, NotificationVisibility> = {};
  if (ls.apps && typeof ls.apps === 'object') {
    for (const [k, v] of Object.entries(ls.apps as Record<string, unknown>)) {
      if (VIS.includes(v as NotificationVisibility)) lsApps[settingsSenderKey(k)] = v as NotificationVisibility;
    }
  }
  const rtApps: Record<string, RetentionDays> = {};
  if (rt.apps && typeof rt.apps === 'object') {
    for (const [k, v] of Object.entries(rt.apps as Record<string, unknown>)) {
      const d = retention(v);
      if (d !== undefined) rtApps[settingsSenderKey(k)] = d;
    }
  }
  const dm = (o.desktopModal && typeof o.desktopModal === 'object' ? o.desktopModal : {}) as { limit?: unknown; windowMinutes?: unknown; perSender?: unknown };
  const dmPer: Record<string, number | 'unlimited'> = {};
  if (dm.perSender && typeof dm.perSender === 'object') {
    for (const [k, v] of Object.entries(dm.perSender as Record<string, unknown>)) {
      const l = modalLimit(v);
      if (l !== undefined) dmPer[settingsSenderKey(k)] = l;
    }
  }
  const win = typeof dm.windowMinutes === 'string' ? Number(dm.windowMinutes) : dm.windowMinutes;
  return {
    lockscreen: { hideAll: ls.hideAll === true, apps: lsApps },
    retention: { days: retention(rt.days) ?? DEFAULT_RETENTION_DAYS, apps: rtApps },
    desktopModal: {
      limit: modalLimit(dm.limit) ?? DEFAULT_DESKTOP_MODAL_LIMIT,
      windowMinutes: typeof win === 'number' && Number.isFinite(win) && win > 0
        ? Math.min(MAX_DESKTOP_MODAL_WINDOW_MINUTES, Math.max(1, Math.round(win))) : DEFAULT_DESKTOP_MODAL_WINDOW_MINUTES,
      perSender: dmPer,
    },
  };
}

/** Phase 6: one sender's blocking-modal limit — `max` null = unlimited. */
export function desktopModalLimitFor(settings: NotificationSettings, senderKey: string): { max: number | null; windowMs: number; windowMinutes: number } {
  const dm = settings.desktopModal ?? DEFAULT_NOTIFICATION_SETTINGS.desktopModal;
  const l = dm.perSender[senderKey] ?? dm.limit;
  return { max: l === 'unlimited' ? null : l, windowMs: dm.windowMinutes * 60_000, windowMinutes: dm.windowMinutes };
}

/** Retention of one sender's items in ms, or null = keep forever. */
export function retentionMsFor(settings: NotificationSettings, senderKey: string): number | null {
  const d = settings.retention.apps[senderKey] ?? settings.retention.days;
  return d === 'forever' ? null : d * 86_400_000;
}

// ---------------------------------------------------------------------------
// Viewers and access
// ---------------------------------------------------------------------------

/** A shell screen: an anonymous caller with a client session (lock state resolved server-side). */
export interface ScreenViewer {
  /** The client session id (opaque; not a credential). */
  sid: string;
  lock: LockState;
}

/**
 * Everything a read needs to know about who is asking. Routes build it
 * from the request; in-process callers pass nothing (= full access).
 */
export interface NotificationViewer {
  principal: NotificationPrincipal;
  /** Set for anonymous callers that sent a client session (`X-Aura-Client-Session`). */
  screen?: ScreenViewer;
  /** Proof of ownership of ONE item (the senderToken from create) — get / waitFor only. */
  senderToken?: string;
}

export type ViewerInput = NotificationPrincipal | NotificationViewer | undefined;

export function isViewer(v: ViewerInput): v is NotificationViewer {
  return !!v && typeof v === 'object' && 'principal' in v;
}

/** Resolved access of one request (computed once per call). */
export type Access =
  | { kind: 'full' }
  | { kind: 'principal'; own: string; grant: ReadGrant | null }
  | { kind: 'screen'; lock: LockState; lockscreen: NotificationSettings['lockscreen'] }
  | { kind: 'none' };

/**
 * A notification as one viewer sees it. For a LOCKED screen it carries
 * `lockscreen: true` (no components, interactions, answer or history), and a
 * private item additionally `redacted: true` with only the sender and
 * `publicTitle` / `publicText` (or a generic title) — see `viewFor`.
 */
export type NotificationView = Notification;

export const GENERIC_TITLE = 'New notification';

const RANK: Record<NotificationVisibility, number> = { public: 0, private: 1, secret: 2 };

/** The stricter of the sender's label and the user's lock-screen settings. */
export function effectiveVisibility(rec: Pick<Notification, 'visibility' | 'senderKey'>, lockscreen: NotificationSettings['lockscreen']): NotificationVisibility {
  if (lockscreen.hideAll) return 'secret';
  const label: NotificationVisibility = VIS.includes(rec.visibility) ? rec.visibility : 'private';
  const override = lockscreen.apps[rec.senderKey];
  return override && RANK[override] > RANK[label] ? override : label;
}

function strip(rec: StoredNotification): Notification {
  const { senderTokenHash: _omit, ...pub } = rec;
  return { ...pub, blocking: pub.blocking ?? false, scope: pub.scope ?? 'auto' };
}

/** May this access read `rec` at all (ignoring the lock-screen view)? */
export function accessCanRead(access: Access, rec: Pick<Notification, 'senderKey' | 'visibility'>): boolean {
  switch (access.kind) {
    case 'full': return true;
    case 'none': return false;
    case 'screen': return access.lock === 'unlocked' || effectiveVisibility(rec, access.lockscreen) !== 'secret';
    case 'principal': {
      if (rec.senderKey === access.own) return true;
      const g = access.grant;
      if (!g || !readScopeCovers(g.scope, rec.senderKey)) return false;
      return rec.visibility !== 'secret' || g.includeSecret;
    }
  }
}

/** True when the access sees the item in full (components, answer, interactions). */
export function accessSeesFull(access: Access, rec: Pick<Notification, 'senderKey' | 'visibility'>): boolean {
  if (access.kind === 'screen') return access.lock === 'unlocked';
  return accessCanRead(access, rec);
}

/**
 * The item as `access` may see it, or null (= not found for that viewer).
 * Every notification that leaves the server goes through here.
 */
export function viewFor(rec: StoredNotification, access: Access): NotificationView | null {
  if (!accessCanRead(access, rec)) return null;
  if (access.kind !== 'screen' || access.lock === 'unlocked') return strip(rec);
  const vis = effectiveVisibility(rec, access.lockscreen);
  if (vis === 'secret') return null;
  if (vis === 'public') {
    const full = strip(rec);
    delete full.components;
    delete full.lastInteraction;
    delete full.answer;
    delete full.outcome;
    return { ...full, caller: { kind: 'anonymous', verification: 'unverified' }, visibility: vis, history: [], lockscreen: true };
  }
  const s = rec.sender;
  const r: Notification = {
    id: rec.id, type: rec.type, priority: rec.priority, pinned: rec.pinned, state: rec.state,
    visibility: vis, createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    ...(rec.displayedAt !== undefined ? { displayedAt: rec.displayedAt } : {}),
    ...(rec.seenAt !== undefined ? { seenAt: rec.seenAt } : {}),
    ...(rec.resolvedAt !== undefined ? { resolvedAt: rec.resolvedAt } : {}),
    ...(rec.removedAt !== undefined ? { removedAt: rec.removedAt } : {}),
    ...(rec.removedReason !== undefined ? { removedReason: rec.removedReason } : {}),
    ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
    sender: {
      kind: s.kind, attribution: s.attribution,
      ...(s.id !== undefined ? { id: s.id } : {}),
      ...(s.name !== undefined ? { name: s.name } : {}),
      ...(s.icon !== undefined ? { icon: s.icon } : {}),
    },
    senderKey: rec.senderKey,
    title: rec.publicTitle ?? GENERIC_TITLE,
    text: rec.publicText ?? '',
    popup: false, blocking: false, scope: 'auto', history: [],
    // No identity details beyond the display sender.
    caller: { kind: 'anonymous', verification: 'unverified' },
    redacted: true, lockscreen: true,
  };
  return r;
}

/** Access without any lookups — for principals that need none (tests, in-process). */
export function staticAccess(viewer: ViewerInput, settings: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS, grant: ReadGrant | null = null): Access {
  if (viewer === undefined) return { kind: 'full' };
  const v: NotificationViewer = isViewer(viewer) ? viewer : { principal: viewer };
  const p = v.principal;
  if (p.kind === 'system') return isSystemCaller(p) ? { kind: 'full' } : { kind: 'none' };
  if (p.kind === 'admin') return { kind: 'full' };
  if (p.kind === 'instance') return { kind: 'principal', own: `app:${p.appId}`, grant };
  if (p.kind === 'apiKey') return { kind: 'principal', own: `key:${p.keyId}`, grant };
  if (v.screen) return { kind: 'screen', lock: v.screen.lock, lockscreen: settings.lockscreen };
  return { kind: 'none' };
}
