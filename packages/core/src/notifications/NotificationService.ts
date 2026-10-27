/**
 * NotificationService — the AuraOS notification core (phase 1 + 2).
 *
 * Applies the identity model (caller ≠ sender ≠ permissions), the phase-1
 * gating of privileged features, sender/user operation rules and the
 * lifecycle; persists through `NotificationStore` (central Valkey).
 *
 *   Sender ops  (create, update, remove)  — authenticated `NotificationCaller`.
 *     update/remove: same verified appId, or the `senderToken` that create
 *     returned once (stored only as a sha256).
 *   User ops    (displayed, seen, resolve, dismiss, clear, force-remove) —
 *     come from shell interfaces; unauthenticated in phase 1 and recorded as
 *     `actor {kind:'user', verification:'unverified'}` (closed in phase 2).
 *
 * Permissions (phase 2) come from an injected `NotificationAuthorizer` (the
 * core auth `Authorizer`; `getNotificationService()` wires it):
 *   - sender ops need `system.notifications` (403 without it);
 *   - `type:'locked'` needs `notifications.locked`, dialogue `popup:true`
 *     needs `notifications.popup`; without them the request is DOWNGRADED
 *     (locked → simple, popup → off) with a `warnings[]` entry;
 *   - a verified principal (app, API key) changes only its OWN notifications,
 *     and verified app / API-key readers see only their own (read scoping).
 * Without an authorizer the phase-1 rule applies: locked + popup are
 * `SYSTEM_CALLER`-only, no send check, no read scoping.
 *
 * Phase 4 (dialogues): `blocking:true` only for a verified app on an activity /
 * instance the AppManager says is its own; at most 3 forced pop-ups per
 * sender per 10 minutes. Anything else is downgraded with a warning.
 * Phase 6 (desktop modals, supersedes "desktop = AuraOS only"):
 *   scope desktop + blocking  blocks the whole shell and ALWAYS opens at once
 *                             (popup is irrelevant, stored true) — needs the
 *                             privileged `notifications.desktopModal` (or
 *                             SYSTEM_CALLER), a verified sender, and a free slot
 *                             of the desktop-modal limit (os/notifications,
 *                             default 5 per sender per 10 min).
 *   scope desktop, no blocking  a centred dialogue that also opens at once:
 *                             needs `notifications.popup` (or desktopModal)
 *                             and counts against the forced pop-up limit.
 * The app stays the sender. A revoke / disable / uninstall releases its
 * active modals (blocking off, scope auto, history `updated`, reason
 * `permission-revoked`); the user can force-hide one (`force-hidden`), an
 * admin release it (`admin-released`).
 *
 * Phase 5 (privacy + housekeeping): every read and every user-op response
 * goes through `viewFor()` (access.ts) for the viewer's resolved `Access`:
 * apps / API keys read their own items plus `notifications.read` grants; a
 * shell screen (client session) reads everything in the view of its lock
 * state; anonymous callers without a session read nothing. Ended items are
 * deleted after the retention period (`os/notifications.retention`,
 * default 7 days; active items never), with a one-time backfill of the
 * `ended` index.
 *
 * A globalThis singleton (`getNotificationService()`), like AppManager /
 * OsEventBus, so the shell's soft-reloads share one sweeper.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { defaultRedis, type Redis } from '@aura/kv-store';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { getAuthServices } from '../auth/services.js';
import type { ZodError } from 'zod';
import {
  AnswerSchema, ClearFilterSchema, CreateInputSchema, InteractionInputSchema, ListQuerySchema, UpdatePatchSchema,
  identityOverrideWarnings, outcomeOf, MAX_COMBOBOX_CUSTOM, MAX_MARKDOWN_CHARS,
  type ClearFilter, type CreateInput, type InteractionInput, type ListQuery, type UpdatePatch,
} from './schema.js';
import {
  KEY_ACTIVE, KEY_ALL, NotificationStore, endedAtOf, senderIndexKey, type RedisProvider,
} from './NotificationStore.js';
import {
  DEFAULT_NOTIFICATION_SETTINGS, accessCanRead, accessSeesFull, isViewer, parseNotificationSettings,
  retentionMsFor, viewFor, desktopModalLimitFor,
  type Access, type NotificationSettings, type NotificationViewer, type ReadGrant, type ViewerInput,
} from './access.js';
import {
  SHELL_DAEMON_APP_ID, UNVERIFIED_USER, isSystemCaller,
  type Actor, type NotificationCaller, type NotificationPrincipal, type HistoryEntry, type LifecycleEvent, type LifecycleEventName,
  type Interaction, type InteractionValue, type Notification, type NotificationComponent,
  type NotificationWarning, type RemovedReason, type Sender, type StoredNotification,
} from './types.js';

/** Max `history[]` entries kept per notification (first `created` is always kept). */
export const HISTORY_LIMIT = 100;
export const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
/** Default per-sender create limit of the shell-wide service. */
export const DEFAULT_CREATES_PER_MINUTE = 30;
/** Max wait of `waitFor` (the REST long-poll caps `timeout` at 25 s). */
export const MAX_WAIT_MS = 60_000;

/** Phase 6: what `waitFor` waits for. */
export type WaitForUntil = 'resolved' | 'interaction';
export interface WaitForOptions {
  timeoutMs: number;
  /** 'resolved' (default): until the item leaves `active`. 'interaction': also on the next interaction. */
  until?: WaitForUntil;
  /** For 'interaction': only interactions with `at` greater than this (ms) count. Default: the current `lastInteraction.at`. */
  after?: number;
}
export interface WaitForResult {
  notification: Notification;
  timedOut: boolean;
  reason: 'resolved' | 'removed' | 'interaction' | 'timeout';
}

/** Bump when the class changes incompatibly: `getNotificationService()` replaces older singletons. */
export const NOTIFICATION_SERVICE_VERSION = 14;

/** Phase 5: how often the sweeper runs the retention pass. */
export const DEFAULT_RETENTION_INTERVAL_MS = 60_000;

/** Phase 4: forced pop-ups per sender within `DEFAULT_POPUP_WINDOW_MS` (shell-wide default). */
export const DEFAULT_POPUPS_PER_WINDOW = 3;
export const DEFAULT_POPUP_WINDOW_MS = 10 * 60_000;

/**
 * Phase 4: who owns the window a context points at. Returns the owning
 * appId, or null when the activity / instance is unknown. The shell wires
 * the AppManager (`getActivity` / `getInstance`); never `context.appId`.
 */
export type WindowOwnerResolver = (context: { kind: 'activity' | 'instance'; id: string }) => string | null | Promise<string | null>;

export const DESKTOP_SCOPE_MESSAGE = 'desktop-wide dialogues are reserved for AuraOS system decisions';
/** Phase 6: blocking desktop modals per sender (sliding window), on top of the pop-up limit. */
export const DEFAULT_DESKTOP_MODALS_PER_WINDOW = 5;
export const DEFAULT_DESKTOP_MODAL_WINDOW_MS = 10 * 60_000;
/** Why an app desktop modal stopped blocking. */
export type DesktopModalRelease = 'force-hidden' | 'permission-revoked' | 'admin-released';

/**
 * The permission check the service needs (structural, so tests can fake it;
 * the real one is core auth's `Authorizer`).
 */
export interface NotificationAuthorizer {
  authorize(principal: NotificationPrincipal & { actor?: { name: string; verification: 'unverified' } }, action: string): Promise<{ allow: boolean; reason: string }>;
  /**
   * Phase 5: the `notifications.read` grant of an app / API key (requested
   * in the manifest AND granted by an admin), or null.
   */
  readGrant?(principal: NotificationPrincipal): Promise<ReadGrant | null>;
}

export const SEND_PERMISSION = 'system.notifications';
export const LOCKED_PERMISSION = 'notifications.locked';
export const POPUP_PERMISSION = 'notifications.popup';
/** Phase 6: block the whole shell (scope desktop + blocking). */
export const DESKTOP_MODAL_PERMISSION = 'notifications.desktopModal';

/** An app (not AuraOS) dialogue that blocks the whole shell. */
export function isAppDesktopModal(n: Pick<Notification, 'type' | 'scope' | 'blocking' | 'state'> & { caller?: NotificationCaller }): boolean {
  return n.type === 'dialogue' && n.state === 'active' && n.scope === 'desktop' && n.blocking === true
    && !(n.caller && isSystemCaller(n.caller)) && (n as { senderKey?: string }).senderKey !== 'auraos';
}

/** Error with an HTTP-ish status, mapped 1:1 by the REST routes. */
export class NotificationError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'NotificationError';
  }
}

export interface NotificationServiceOptions {
  /** Redis connection (or provider). Default: `defaultRedis()` on the singleton KvServer. */
  redis?: Redis | RedisProvider;
  /** Clock, for tests. */
  now?: () => number;
  sweepIntervalMs?: number;
  /** Called after every committed lifecycle event (live delivery hook). */
  onEvent?: (ev: LifecycleEvent) => void;
  /** Phase-2 permission checks. Absent: phase-1 rules (see the file header). */
  authorizer?: NotificationAuthorizer;
  /** Per-sender create limit (Valkey counter per minute). 0/absent: unlimited. */
  createsPerMinute?: number;
  /** Phase 4: forced pop-up limit per sender (sliding window). Absent: unlimited. */
  popupLimit?: { max: number; windowMs: number };
  /** Phase 6: blocking desktop modals per sender (default: unlimited). */
  desktopModalLimit?: { max: number; windowMs: number };
  /** Phase 4: window ownership for `blocking`. Absent: blocking is always downgraded. */
  windowOwner?: WindowOwnerResolver;
  /** Phase 5: the user's `os/notifications` settings. Absent: defaults (7-day retention, no overrides). */
  settings?: () => NotificationSettings | Promise<NotificationSettings>;
  /** Phase 5: retention pass interval of the sweeper. */
  retentionIntervalMs?: number;
}

export interface CreateResult {
  notification: Notification;
  /** Returned ONCE; lets the creator update/remove later without a verified identity. */
  senderToken?: string;
  warnings: NotificationWarning[];
  /** Phase 6: a kept desktop modal's budget (remaining null = unlimited). */
  desktopModal?: DesktopModalBudget;
}

export interface DesktopModalBudget { remaining: number | null; limit: number | null; windowMinutes: number }

export interface UpdateResult {
  notification: Notification;
  warnings: NotificationWarning[];
}

export interface ListResult {
  items: Notification[];
  /** Pass back as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
}

// ---------------------------------------------------------------------------

function zodDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatches(token: string | undefined, hash: string | undefined): boolean {
  if (!token || !hash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function newId(now: number): string {
  // Time-sortable: base36 ms (zero-padded) + 8 random hex chars.
  return `ntf_${now.toString(36).padStart(9, '0')}${randomBytes(4).toString('hex')}`;
}

export const NOTIFICATION_ID_PATTERN = /^ntf_[a-z0-9]{9,20}$/;

/** Strip storage-only fields. */
export function toPublic(rec: StoredNotification): Notification {
  const { senderTokenHash: _omit, ...pub } = rec;
  // Records stored before phase 4 have no blocking / scope.
  return { ...pub, blocking: pub.blocking ?? false, scope: pub.scope ?? 'auto' };
}

/** Index key for "by sender" queries. */
export function senderKeyFor(caller: NotificationCaller): string {
  if (isSystemCaller(caller)) return 'auraos';
  if (caller.kind === 'instance') return `app:${caller.appId}`;
  if (caller.kind === 'apiKey') return `key:${caller.keyId}`;
  return caller.hints?.appId ? `anon:${caller.hints.appId}` : 'anon:rest';
}

/** History actor for a sender operation. */
export function actorFor(caller: NotificationCaller, via?: 'senderToken'): Actor {
  if (isSystemCaller(caller)) return { kind: 'system', verification: 'internal' };
  if (caller.kind === 'instance') {
    return {
      kind: 'app', appId: caller.appId, instanceId: caller.instanceId,
      ...(caller.sidecar ? { sidecar: caller.sidecar } : {}),
      verification: 'verified', ...(via ? { via } : {}),
    };
  }
  if (caller.kind === 'apiKey') {
    return { kind: 'apiKey', keyId: caller.keyId, name: caller.name, verification: 'verified', ...(via ? { via } : {}) };
  }
  return {
    kind: 'anonymous', verification: 'unverified',
    ...(caller.hints ? { hints: caller.hints } : {}), ...(via ? { via } : {}),
  };
}

/**
 * Display sender, derived from the caller. The client may only contribute
 * `name`, `icon` and `actor.name` — never kind, id or any attribution.
 */
export function deriveSender(caller: NotificationCaller, input?: { name?: string; icon?: string; actor?: { name: string } }): Sender {
  let sender: Sender;
  if (isSystemCaller(caller)) {
    sender = { kind: 'auraos', id: 'auraos', name: input?.name ?? 'AuraOS', attribution: 'internal' };
    if (input?.icon) sender.icon = input.icon;
    if (input?.actor) sender.actor = { name: input.actor.name, attribution: 'declared' };
    return sender;
  }
  if (caller.kind === 'instance') {
    const isDaemon = caller.appId === SHELL_DAEMON_APP_ID;
    sender = { kind: isDaemon ? 'agent' : 'app', id: caller.appId, attribution: 'verified' };
    if (input?.actor) sender.actor = { name: input.actor.name, attribution: 'declared' };
    if (input?.name) { sender.name = input.name; sender.nameAttribution = 'declared'; }
  } else if (caller.kind === 'apiKey') {
    // External REST caller with an admin-issued key: the key's admin-given
    // name is the display name unless the request declares one.
    sender = { kind: 'rest', id: caller.keyId, name: caller.name, attribution: 'verified' };
    if (input?.actor) sender.actor = { name: input.actor.name, attribution: 'declared' };
    if (input?.name) { sender.name = input.name; sender.nameAttribution = 'declared'; }
  } else {
    const hinted = caller.hints?.appId;
    sender = hinted
      ? { kind: 'app', id: hinted, attribution: 'unverified' }
      : { kind: input?.name ? 'rest' : 'unknown', attribution: 'unverified' };
    if (input?.actor) sender.actor = { name: input.actor.name, attribution: 'unverified' };
    if (input?.name) { sender.name = input.name; sender.nameAttribution = 'unverified'; }
  }
  if (input?.icon) sender.icon = input.icon;
  return sender;
}

/** The identity part of a principal — what gets stored as `caller` (no actor, no key scopes). */
export function storedCallerOf(caller: NotificationCaller): NotificationCaller {
  if (isSystemCaller(caller)) return caller;
  switch (caller.kind) {
    case 'instance':
      return { kind: 'instance', appId: caller.appId, instanceId: caller.instanceId, ...(caller.sidecar ? { sidecar: caller.sidecar } : {}), verification: 'verified' };
    case 'apiKey':
      return { kind: 'apiKey', keyId: caller.keyId, name: caller.name, verification: 'verified' };
    case 'anonymous':
      return { kind: 'anonymous', verification: 'unverified', ...(caller.hints ? { hints: structuredClone(caller.hints) } : {}) };
    default:
      return structuredClone(caller);
  }
}

/**
 * The OWN sender key of a verified app / API key, else null. Not an access
 * decision any more (phase 5) — use `NotificationService.accessFor()` /
 * `viewFor()`: anonymous callers without a client session read nothing.
 */
export function readScopeFor(viewer: NotificationPrincipal | undefined): string | null {
  if (!viewer) return null;
  if (viewer.kind === 'instance') return `app:${viewer.appId}`;
  if (viewer.kind === 'apiKey') return `key:${viewer.keyId}`;
  return null;
}

/**
 * May `viewer` read `rec` without any grant or lock-screen lookup? (In-process
 * / system and admin: yes; apps / keys: own items; screens: per their lock;
 * anonymous without a session: no.) Routes use `accessFor()` instead.
 */
export function canRead(viewer: ViewerInput, rec: Pick<Notification, 'senderKey' | 'visibility'>): boolean {
  if (viewer === undefined) return true;
  const v: NotificationViewer = isViewer(viewer) ? viewer : { principal: viewer };
  const p = v.principal;
  if (p.kind === 'system') return isSystemCaller(p);
  if (p.kind === 'admin') return true;
  if (p.kind === 'instance') return rec.senderKey === `app:${p.appId}`;
  if (p.kind === 'apiKey') return rec.senderKey === `key:${p.keyId}`;
  if (!v.screen) return false;
  return accessCanRead({ kind: 'screen', lock: v.screen.lock, lockscreen: DEFAULT_NOTIFICATION_SETTINGS.lockscreen }, rec);
}

/**
 * Validate one interaction value against its component (phase 3):
 *   input   → a string (≤ 4000 chars)
 *   options → option ids of that component; a single choice is stored as a
 *             string, a `multiple` one as an array
 *   select  → one option id (phase 6)
 *   combobox→ an option id, or with `allowCustom` a trimmed free text ≤ 200
 * Throws a 400 NotificationError otherwise.
 */
function normalizeValue(c: NotificationComponent, v: InteractionValue | undefined, where: string): InteractionValue | undefined {
  if (v === undefined) return undefined;
  if (c.kind === 'input') {
    if (typeof v !== 'string') throw new NotificationError(400, `${where}: input '${c.id}' takes a string`);
    if (v.length > 4000) throw new NotificationError(400, `${where}: input '${c.id}' is longer than 4000 chars`);
    return v;
  }
  if (c.kind === 'markdown') {
    if (!c.editable) throw new NotificationError(400, `${where}: markdown '${c.id}' is read-only`);
    if (typeof v !== 'string') throw new NotificationError(400, `${where}: markdown '${c.id}' takes a string`);
    if (v.length > MAX_MARKDOWN_CHARS) throw new NotificationError(400, `${where}: markdown '${c.id}' is longer than 64 KB`);
    return v;
  }
  if (c.kind === 'options') {
    const ids = typeof v === 'string' ? [v] : v;
    const known = new Set(c.options.map((o) => o.id));
    for (const id of ids) {
      if (!known.has(id)) throw new NotificationError(400, `${where}: '${id}' is not an option of '${c.id}'`);
    }
    if (new Set(ids).size !== ids.length) throw new NotificationError(400, `${where}: duplicate option ids for '${c.id}'`);
    if (c.multiple) return [...ids];
    if (ids.length > 1) throw new NotificationError(400, `${where}: '${c.id}' allows a single choice`);
    return ids[0] ?? [];
  }
  if (c.kind === 'select') {
    if (typeof v !== 'string') throw new NotificationError(400, `${where}: select '${c.id}' takes one option id (a string)`);
    if (!c.options.some((o) => o.id === v)) throw new NotificationError(400, `${where}: '${v}' is not an option of '${c.id}'`);
    return v;
  }
  if (c.kind === 'combobox') {
    if (typeof v !== 'string') throw new NotificationError(400, `${where}: combobox '${c.id}' takes a string (an option id${c.allowCustom ? ' or free text' : ''})`);
    if (c.options.some((o) => o.id === v)) return v;
    if (!c.allowCustom) throw new NotificationError(400, `${where}: '${v}' is not an option of '${c.id}' (it does not allow free text)`);
    const text = v.trim();
    if (!text) throw new NotificationError(400, `${where}: combobox '${c.id}' needs a non-empty text`);
    if (text.length > MAX_COMBOBOX_CUSTOM) throw new NotificationError(400, `${where}: free text for '${c.id}' is longer than ${MAX_COMBOBOX_CUSTOM} chars`);
    return text;
  }
  throw new NotificationError(400, `${where}: component '${(c as { id?: string }).id ?? '?'}' (${c.kind}) takes no value`);
}

function isFieldComponent(c: NotificationComponent): boolean {
  return c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox' || (c.kind === 'markdown' && !!c.editable);
}

/**
 * Phase 6: an answer's `values` (the shell sends `{outcome, buttonId,
 * values}`) are checked against the item's field components like
 * `interact` values — an unknown option, a non-option select value or free
 * text in a combobox without `allowCustom` is a 400. Keys that are not
 * field components are left alone (older senders' own answer shapes), and
 * an answer without a `values` object is not touched. A value for a
 * read-only markdown component is refused (400). Returns the answer
 * with normalised values (e.g. trimmed combobox text).
 */
function normalizeAnswerValues(rec: StoredNotification, answer: unknown): unknown {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  const vals = (answer as Record<string, unknown>)['values'];
  if (!vals || typeof vals !== 'object' || Array.isArray(vals)) return answer;
  const byId = new Map((rec.components ?? []).filter((c) => c.id && (isFieldComponent(c) || c.kind === 'markdown')).map((c) => [c.id as string, c]));
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(vals as Record<string, unknown>)) {
    const c = byId.get(k);
    if (!c) continue;
    if (typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
      throw new NotificationError(400, `answer.values: '${k}' must be a string or a list of option ids`);
    }
    if (typeof v === 'string' && v === '' && c.kind !== 'input' && c.kind !== 'markdown') continue;   // nothing chosen
    const n = normalizeValue(c, v as InteractionValue, 'answer.values');
    if (n !== v) { out ??= { ...(vals as Record<string, unknown>) }; out[k] = n; }
  }
  return out ? { ...(answer as Record<string, unknown>), values: out } : answer;
}

function pushHistory(rec: StoredNotification, entry: HistoryEntry): void {
  rec.history.push(entry);
  if (rec.history.length > HISTORY_LIMIT) {
    // Keep `created` (index 0) and the newest HISTORY_LIMIT-1 entries.
    rec.history.splice(1, rec.history.length - HISTORY_LIMIT);
  }
}

// ---------------------------------------------------------------------------

export class NotificationService {
  readonly version = NOTIFICATION_SERVICE_VERSION;
  private readonly store: NotificationStore;
  private readonly redisProvider: RedisProvider;
  private authorizer: NotificationAuthorizer | undefined;
  private createsPerMinute: number;
  private popupLimit: { max: number; windowMs: number } | undefined;
  private desktopModalLimit: { max: number; windowMs: number } | undefined;
  private windowOwner: WindowOwnerResolver | undefined;
  private settingsProvider: (() => NotificationSettings | Promise<NotificationSettings>) | undefined;
  private readonly retentionIntervalMs: number;
  private lastRetentionAt = 0;
  private backfilled = false;
  /** In-process waiters of `waitFor`, woken on every committed event of their id. */
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private onEvent: ((ev: LifecycleEvent) => void) | undefined;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: NotificationServiceOptions = {}) {
    const r = opts.redis;
    const provider: RedisProvider = typeof r === 'function' ? r : r ? () => r : () => defaultRedis();
    this.redisProvider = provider;
    this.store = new NotificationStore(provider);
    this.now = opts.now ?? Date.now;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.onEvent = opts.onEvent;
    this.authorizer = opts.authorizer;
    this.createsPerMinute = opts.createsPerMinute ?? 0;
    this.popupLimit = opts.popupLimit;
    this.desktopModalLimit = opts.desktopModalLimit;
    this.windowOwner = opts.windowOwner;
    this.settingsProvider = opts.settings;
    this.retentionIntervalMs = opts.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
  }

  /** Phase 5: where the user's `os/notifications` settings come from (the shell wires the KV). */
  setSettingsProvider(fn: (() => NotificationSettings | Promise<NotificationSettings>) | undefined): void {
    this.settingsProvider = fn;
  }

  /** The current user settings (defaults when unset or unreadable). */
  async settings(): Promise<NotificationSettings> {
    if (!this.settingsProvider) return DEFAULT_NOTIFICATION_SETTINGS;
    try { return parseNotificationSettings(await this.settingsProvider()); } catch { return DEFAULT_NOTIFICATION_SETTINGS; }
  }

  /**
   * Resolve who is reading, ONCE per request (phase 5).
   *   undefined (in-process), system, admin → full
   *   app instance / API key               → own + `notifications.read` grant
   *   anonymous with a client session      → screen view of its lock state
   *   anonymous without                    → none
   */
  async accessFor(viewer: ViewerInput): Promise<Access> {
    if (viewer === undefined) return { kind: 'full' };
    const v: NotificationViewer = isViewer(viewer) ? viewer : { principal: viewer };
    const p = v.principal;
    if (p.kind === 'system') return isSystemCaller(p) ? { kind: 'full' } : { kind: 'none' };
    if (p.kind === 'admin') return { kind: 'full' };
    if (p.kind === 'instance' || p.kind === 'apiKey') {
      let grant: ReadGrant | null = null;
      try { grant = (await this.authorizer?.readGrant?.(p)) ?? null; } catch { grant = null; }
      return { kind: 'principal', own: p.kind === 'instance' ? `app:${p.appId}` : `key:${p.keyId}`, grant };
    }
    if (v.screen) return { kind: 'screen', lock: v.screen.lock === 'unlocked' ? 'unlocked' : 'locked', lockscreen: (await this.settings()).lockscreen };
    return { kind: 'none' };
  }

  /** One item as `access` sees it, or null — for live delivery (the SSE stream). */
  async viewById(id: string, access: Access): Promise<Notification | null> {
    if (!NOTIFICATION_ID_PATTERN.test(id)) return null;
    const rec = await this.store.load(id);
    return rec ? viewFor(rec, access) : null;
  }

  /** Phase 4: forced pop-up limit per sender; `undefined` = unlimited. */
  /** Phase 6: blocking desktop modals per sender (undefined = unlimited). */
  setDesktopModalLimit(limit: { max: number; windowMs: number } | undefined): void {
    this.desktopModalLimit = limit;
  }

  setPopupLimit(limit: { max: number; windowMs: number } | undefined): void {
    this.popupLimit = limit;
  }

  /** Phase 4: window ownership for `blocking` (the shell wires the AppManager). */
  setWindowOwnerResolver(fn: WindowOwnerResolver | undefined): void {
    this.windowOwner = fn;
  }

  /** Wire (or replace) the permission checks — the shell uses core auth's Authorizer. */
  setAuthorizer(a: NotificationAuthorizer | undefined): void {
    this.authorizer = a;
  }

  setCreateRateLimit(perMinute: number): void {
    this.createsPerMinute = Math.max(0, Math.floor(perMinute));
    this.rateLimitSet = true;
  }

  private rateLimitSet = false;
  get rateLimitConfigured(): boolean {
    return this.rateLimitSet;
  }

  /** Replace the live-delivery hook (the shell wires OsEventBus here). */
  setEventListener(fn: ((ev: LifecycleEvent) => void) | undefined): void {
    this.onEvent = fn;
  }

  /** Start the expiry sweeper. Idempotent. */
  start(): void {
    if (this.sweeper) return;
    // Phase 6: modals whose grant went away while the shell was down stop blocking.
    void this.sweepDesktopModals().then((ids) => {
      if (ids.length) console.log(`[notifications] released ${ids.length} desktop modal(s) without a grant`);
    }).catch((err) => console.warn(`[notifications] desktop-modal sweep failed: ${(err as Error).message}`));
    this.sweeper = setInterval(() => { void this.sweep().catch((err) => {
      console.warn(`[notifications] sweep failed: ${(err as Error).message}`);
    }); }, this.sweepIntervalMs);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  get running(): boolean {
    return this.sweeper !== null;
  }

  /** Raw access for live delivery (catch-up from the event stream). */
  get events(): Pick<NotificationStore, 'eventsSince' | 'eventBounds'> {
    return this.store;
  }

  /** The stored item regardless of scoping — for in-process consumers that scope themselves. */
  async getRaw(id: string): Promise<Notification | null> {
    if (!NOTIFICATION_ID_PATTERN.test(id)) return null;
    const rec = await this.store.load(id);
    return rec ? toPublic(rec) : null;
  }

  // ---- internals ---------------------------------------------------------

  /** Serialise read-modify-write per notification id (the shell is the only writer). */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    try { return await run; }
    finally { if (this.locks.get(id) === tail) this.locks.delete(id); }
  }

  private async mustLoad(id: string): Promise<StoredNotification> {
    if (!NOTIFICATION_ID_PATTERN.test(id)) throw new NotificationError(404, `notification not found: ${id}`);
    const rec = await this.store.load(id);
    if (!rec) throw new NotificationError(404, `notification not found: ${id}`);
    return rec;
  }

  private async commit(rec: StoredNotification, event: LifecycleEventName, at: number): Promise<LifecycleEvent> {
    const ev = await this.store.write(rec, event, at);
    try { this.onEvent?.(ev); } catch (err) {
      console.warn(`[notifications] event listener failed: ${(err as Error).message}`);
    }
    const ws = this.waiters.get(rec.id);
    if (ws) for (const wake of [...ws]) wake();
    return ev;
  }

  private assertCaller(caller: NotificationPrincipal): asserts caller is NotificationCaller {
    // A look-alike of SYSTEM_CALLER is not system and not anything else either.
    if (caller.kind === 'system' && !isSystemCaller(caller)) {
      throw new NotificationError(403, 'only the in-process SYSTEM_CALLER may act as system');
    }
    if (caller.kind === 'admin') {
      throw new NotificationError(403, 'an admin session manages grants and keys — it cannot send or change notifications');
    }
  }

  /** Phase 2: the declared actor goes to the Authorizer's delegation hook (never decides anything today). */
  private withActor(caller: NotificationCaller, actorName?: string) {
    return actorName ? { ...caller, actor: { name: actorName, verification: 'unverified' as const } } : caller;
  }

  /** Sender ops need `system.notifications` (403 otherwise). No-op without an authorizer. */
  private async assertMaySend(caller: NotificationCaller, actorName?: string): Promise<void> {
    if (!this.authorizer || isSystemCaller(caller)) return;
    const d = await this.authorizer.authorize(this.withActor(caller, actorName), SEND_PERMISSION);
    if (!d.allow) {
      throw new NotificationError(403, `not allowed to send notifications: ${d.reason}`, { permission: SEND_PERMISSION });
    }
  }

  /** Privileged features: allowed, or downgraded with a warning. Mutates `fields`. */
  private async gate(caller: NotificationCaller, fields: { type?: string; popup?: boolean; scope?: string }, warnings: NotificationWarning[], actorName?: string): Promise<void> {
    const system = isSystemCaller(caller);
    const check = async (permission: string): Promise<{ allow: boolean; reason: string }> => {
      if (system) return { allow: true, reason: 'system' };
      if (!this.authorizer) return { allow: false, reason: 'phase 1: AuraOS core only' };
      return this.authorizer.authorize(this.withActor(caller, actorName), permission);
    };
    if (fields.type === 'locked') {
      const d = await check(LOCKED_PERMISSION);
      if (!d.allow) {
        fields.type = 'simple';
        warnings.push({ code: 'downgraded', field: 'type', from: 'locked', to: 'simple',
          message: `type 'locked' requires the '${LOCKED_PERMISSION}' permission (requested in the manifest and granted by an admin): ${d.reason}` });
      }
    }
    if (fields.popup === true) {
      const d = await check(POPUP_PERMISSION);
      if (!d.allow) {
        fields.popup = false;
        warnings.push({ code: 'downgraded', field: 'popup', from: true, to: false,
          message: `popup requires the '${POPUP_PERMISSION}' permission (requested in the manifest and granted by an admin): ${d.reason}` });
      }
    }
  }

  /**
   * Phase 6: a desktop modal (scope desktop + blocking) needs a verified
   * sender with `notifications.desktopModal` and a free slot of the
   * per-sender limit; else scope → auto with a warning (blocking is then
   * judged as an own-window block by `gateBlocking`). Non-blocking desktop
   * dialogues need nothing. SYSTEM_CALLER: always. Mutates `fields`.
   */
  private async gateDesktop(caller: NotificationCaller, fields: { scope?: string; blocking?: boolean }, warnings: NotificationWarning[], actorName?: string, countIt = true, budget: { value?: DesktopModalBudget } = {}): Promise<void> {
    if (fields.scope !== 'desktop' || isSystemCaller(caller)) return;
    if (!fields.blocking) {
      // A centred desktop dialogue opens by itself: popup (or desktopModal) is required.
      const ask = async (perm: string) => (this.authorizer
        ? await this.authorizer.authorize(this.withActor(caller, actorName), perm)
        : { allow: false, reason: 'phase 1: AuraOS core only' });
      const pd = await ask(POPUP_PERMISSION);
      if (pd.allow || (await ask(DESKTOP_MODAL_PERMISSION)).allow) return;
      fields.scope = 'auto';
      warnings.push({ code: 'downgraded', field: 'scope', from: 'desktop', to: 'auto',
        message: `a desktop dialogue opens by itself, so it requires the '${POPUP_PERMISSION}' (or '${DESKTOP_MODAL_PERMISSION}') permission (requested in the manifest and granted by an admin): ${pd.reason}` });
      return;
    }
    const downgrade = (why: string) => {
      fields.scope = 'auto';
      warnings.push({ code: 'downgraded', field: 'scope', from: 'desktop', to: 'auto',
        message: `a desktop-wide modal (scope desktop + blocking) ${why}` });
    };
    if (caller.kind !== 'instance' && caller.kind !== 'apiKey') { downgrade('needs a verified sender (an app or API key) with an admin grant'); return; }
    const d = this.authorizer
      ? await this.authorizer.authorize(this.withActor(caller, actorName), DESKTOP_MODAL_PERMISSION)
      : { allow: false, reason: 'phase 1: AuraOS core only' };
    if (!d.allow) { downgrade(`requires the '${DESKTOP_MODAL_PERMISSION}' permission (requested in the manifest and granted by an admin): ${d.reason}`); return; }
    // The limit: an explicit override (tests / embedders), else the user's
    // `os/notifications.desktopModal` (default 5 per sender per 10 min).
    const sk = senderKeyFor(caller);
    const lim = this.desktopModalLimit
      ? { max: this.desktopModalLimit.max > 0 ? this.desktopModalLimit.max : null, windowMs: this.desktopModalLimit.windowMs, windowMinutes: Math.round(this.desktopModalLimit.windowMs / 60_000) }
      : desktopModalLimitFor(await this.settings(), sk);
    if (!countIt) return;
    if (lim.max === null) { budget.value = { remaining: null, limit: null, windowMinutes: lim.windowMinutes }; return; }
    const key = `ratelimit:notifdesktop:${sk}`;
    const r = this.redisProvider();
    const now = this.now();
    await r.zremrangebyscore(key, '-inf', now - lim.windowMs);
    const n = await r.zcard(key);
    if (n >= lim.max) {
      const oldest = await r.zrange(key, 0, 0, 'WITHSCORES');
      const retryAfterMs = Math.max(0, (oldest[1] !== undefined ? Number(oldest[1]) : now) + lim.windowMs - now);
      fields.scope = 'auto';
      warnings.push({ code: 'desktop-modal-rate-limited', field: 'scope', from: 'desktop', to: 'auto',
        message: `a desktop-wide modal is limited to ${lim.max} per sender per ${lim.windowMinutes} minutes — it waits as a normal dialogue (next one possible in ${Math.ceil(retryAfterMs / 1000)} s; the user can change the limit in Settings → Notifications & access)`,
        limit: lim.max, windowMinutes: lim.windowMinutes, retryAfterMs, remaining: 0 });
      return;
    }
    await r.zadd(key, now, `${now}-${randomBytes(4).toString('hex')}`);
    await r.pexpire(key, lim.windowMs);
    budget.value = { remaining: Math.max(0, lim.max - n - 1), limit: lim.max, windowMinutes: lim.windowMinutes };
  }

  /**
   * Phase 4: may `caller` make `context`'s window inert? Only a verified app
   * instance (not the Shell Daemon's agents, not API keys / anonymous) for
   * an activity / instance that the AppManager says belongs to its OWN app.
   * Returns null when allowed, else the reason.
   */
  private async blockingRefusal(caller: NotificationCaller, context: Notification['context']): Promise<string | null> {
    if (isSystemCaller(caller)) return null;
    if (caller.kind !== 'instance') return 'only a verified app may block a window (its own)';
    if (caller.appId === SHELL_DAEMON_APP_ID) return 'agents cannot block a window';
    if (!context || (context.kind !== 'activity' && context.kind !== 'instance')) {
      return "blocking needs a context of kind 'activity' or 'instance' (the sender's own window)";
    }
    if (!this.windowOwner) return 'window ownership cannot be checked here';
    let owner: string | null = null;
    try { owner = await this.windowOwner({ kind: context.kind, id: context.id }); } catch { owner = null; }
    if (owner === null) return `no running ${context.kind} '${context.id}'`;
    if (owner !== caller.appId) return 'a sender can only block its own window';
    return null;
  }

  /** Phase 4: downgrade `fields.blocking` unless allowed (see `blockingRefusal`). */
  private async gateBlocking(caller: NotificationCaller, fields: { blocking: boolean; scope?: string }, context: Notification['context'], warnings: NotificationWarning[]): Promise<void> {
    // A kept desktop modal blocks the shell, not a window (gateDesktop decided).
    if (!fields.blocking || fields.scope === 'desktop') return;
    const why = await this.blockingRefusal(caller, context);
    if (why) {
      fields.blocking = false;
      warnings.push({ code: 'downgraded', field: 'blocking', from: true, to: false,
        message: `blocking only applies to the sender's own window: ${why}` });
    }
  }

  /**
   * Phase 4: forced pop-ups per sender (sliding window in a Valkey sorted
   * set). Counts only a pop-up that is kept; over the limit → popup off with
   * a warning (the dialogue stays in the list). System is exempt.
   */
  private async gatePopupRate(caller: NotificationCaller, fields: { popup: boolean }, warnings: NotificationWarning[]): Promise<void> {
    const lim = this.popupLimit;
    if (!fields.popup || !lim || lim.max <= 0 || isSystemCaller(caller)) return;
    const key = `ratelimit:notifpopup:${senderKeyFor(caller)}`;
    const r = this.redisProvider();
    const now = this.now();
    await r.zremrangebyscore(key, '-inf', now - lim.windowMs);
    const n = await r.zcard(key);
    if (n >= lim.max) {
      fields.popup = false;
      warnings.push({ code: 'downgraded', field: 'popup', from: true, to: false,
        message: `at most ${lim.max} forced pop-ups per sender per ${Math.round(lim.windowMs / 60_000)} minutes — the dialogue waits in the list` });
      return;
    }
    await r.zadd(key, now, `${now}-${randomBytes(4).toString('hex')}`);
    await r.pexpire(key, lim.windowMs);
  }

  /** Phase 4: blocking / scope only mean something for dialogues. */
  private dialogueOnly(type: string, fields: { blocking?: boolean; scope?: string }, warnings: NotificationWarning[], given: { blocking?: boolean; scope?: string }): void {
    if (type === 'dialogue') return;
    if (given.blocking === true) {
      warnings.push({ code: 'ignored-field', field: 'blocking', message: 'blocking only applies to type dialogue' });
    }
    if (given.scope === 'desktop') {
      warnings.push({ code: 'ignored-field', field: 'scope', message: 'scope only applies to type dialogue' });
    }
    if (fields.blocking !== undefined) fields.blocking = false;
    if (fields.scope !== undefined) fields.scope = 'auto';
  }

  /**
   * Who may run a sender op on `rec`. Returns the history actor.
   *   - system: always
   *   - a verified principal (app, API key): only its OWN notifications —
   *     same appId / same keyId. A different verified principal is refused
   *     even with the senderToken.
   *   - anyone else: the senderToken returned by create.
   */
  private authorizeSender(rec: StoredNotification, caller: NotificationCaller, senderToken?: string): Actor {
    if (isSystemCaller(caller)) return actorFor(caller);
    if (caller.kind === 'instance' && rec.caller.kind === 'instance' && rec.caller.appId === caller.appId) {
      return actorFor(caller);
    }
    if (caller.kind === 'apiKey' && rec.caller.kind === 'apiKey' && rec.caller.keyId === caller.keyId) {
      return actorFor(caller);
    }
    if (caller.kind === 'instance' || caller.kind === 'apiKey') {
      throw new NotificationError(403, 'a verified sender may only change its own notifications');
    }
    if (tokenMatches(senderToken, rec.senderTokenHash)) return actorFor(caller, 'senderToken');
    throw new NotificationError(403, 'only the verified sender app or the holder of its senderToken may change this notification');
  }

  /** Per-sender create limit (fixed one-minute window in Valkey). System is exempt. */
  private async rateLimit(caller: NotificationCaller): Promise<void> {
    if (!this.createsPerMinute || isSystemCaller(caller)) return;
    const bucket = `ratelimit:notif:${senderKeyFor(caller)}:${Math.floor(this.now() / 60_000)}`;
    const r = this.redisProvider();
    const n = await r.incr(bucket);
    if (n === 1) await r.pexpire(bucket, 120_000);
    if (n > this.createsPerMinute) {
      throw new NotificationError(429, `rate limit: at most ${this.createsPerMinute} notifications per minute per sender`, { limit: this.createsPerMinute });
    }
  }

  // ---- sender ops ----------------------------------------------------------

  async create(input: CreateInput | unknown, caller: NotificationPrincipal): Promise<CreateResult> {
    this.assertCaller(caller);
    const warnings = identityOverrideWarnings(input);
    const parsed = CreateInputSchema.safeParse(input);
    if (!parsed.success) throw new NotificationError(400, 'invalid notification', zodDetails(parsed.error));
    const p = parsed.data;
    const actorName = p.sender?.actor?.name;
    await this.assertMaySend(caller, actorName);
    await this.rateLimit(caller);
    const fields: { type: string; popup: boolean; blocking: boolean; scope: 'auto' | 'desktop' } = {
      type: p.type, popup: p.popup, blocking: p.blocking, scope: p.scope,
    };
    if (fields.type !== 'dialogue') {
      // Not gated at all: these fields mean nothing outside dialogues.
      this.dialogueOnly(fields.type, fields, warnings, { blocking: p.blocking, scope: p.scope });
    }
    // Phase 6: an app desktop dialogue ALWAYS opens at once — there is no
    // "waits in the list" variant. Blocking: needs desktopModal, counts only
    // against the desktop-modal limit, `popup` is irrelevant (stored true).
    // Non-blocking (centred): auto-interrupts, so it needs popup (or
    // desktopModal) and counts against the forced pop-up limit.
    const budget: { value?: DesktopModalBudget } = {};
    if (fields.type === 'dialogue' && fields.scope === 'desktop' && !isSystemCaller(caller)) {
      await this.gateDesktop(caller, fields, warnings, actorName, true, budget);
    }
    if (fields.type === 'dialogue' && fields.scope === 'desktop' && !isSystemCaller(caller)) {
      fields.popup = true;
      if (!fields.blocking) {
        await this.gatePopupRate(caller, fields, warnings);
        if (!fields.popup) fields.scope = 'auto';   // over the pop-up limit: a normal dialogue
      }
    } else {
      await this.gate(caller, fields, warnings, actorName);
      if (fields.popup && fields.type !== 'dialogue') {
        fields.popup = false;
        warnings.push({ code: 'ignored-field', field: 'popup', message: 'popup only applies to type dialogue' });
      }
      await this.gateBlocking(caller, fields, p.context, warnings);
      await this.gatePopupRate(caller, fields, warnings);
    }

    const now = this.now();
    const senderToken = isSystemCaller(caller) ? undefined : `nst_${randomBytes(24).toString('base64url')}`;
    const rec: StoredNotification = {
      id: newId(now),
      type: fields.type as StoredNotification['type'],
      title: p.title,
      text: p.text,
      ...(p.icon !== undefined ? { icon: p.icon } : {}),
      ...(p.image !== undefined ? { image: p.image } : {}),
      priority: p.priority,
      visibility: p.visibility,
      ...(p.publicTitle !== undefined ? { publicTitle: p.publicTitle } : {}),
      ...(p.publicText !== undefined ? { publicText: p.publicText } : {}),
      ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs, expiresAt: now + p.timeoutMs } : {}),
      pinned: p.pinned,
      ...(p.popupDurationMs !== undefined ? { popupDurationMs: p.popupDurationMs } : {}),
      popup: fields.popup,
      blocking: fields.blocking,
      scope: fields.scope,
      ...(p.components ? { components: p.components } : {}),
      ...(p.context ? { context: p.context } : {}),
      caller: storedCallerOf(caller),
      sender: deriveSender(caller, p.sender),
      senderKey: senderKeyFor(caller),
      state: 'active',
      createdAt: now,
      updatedAt: now,
      history: [{ event: 'created', at: now, actor: actorFor(caller) }],
      ...(senderToken ? { senderTokenHash: hashToken(senderToken) } : {}),
    };
    await this.commit(rec, 'created', now);
    return { notification: toPublic(rec), ...(senderToken ? { senderToken } : {}), warnings, ...(budget.value && fields.scope === 'desktop' ? { desktopModal: budget.value } : {}) };
  }

  async update(id: string, patch: UpdatePatch | unknown, caller: NotificationPrincipal, senderToken?: string): Promise<UpdateResult> {
    this.assertCaller(caller);
    const warnings = identityOverrideWarnings(patch);
    if (patch && typeof patch === 'object' && 'type' in patch) {
      warnings.push({ code: 'ignored-field', field: 'type', message: 'type is fixed at create' });
    }
    const parsed = UpdatePatchSchema.safeParse(patch);
    if (!parsed.success) throw new NotificationError(400, 'invalid update', zodDetails(parsed.error));
    const p = parsed.data;
    const actorName = p.sender?.actor?.name;
    await this.assertMaySend(caller, actorName);

    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      const actor = this.authorizeSender(rec, caller, senderToken);
      if (rec.state !== 'active') throw new NotificationError(409, `notification is ${rec.state}`);

      const now = this.now();
      const touched: string[] = [];
      const setOpt = <K extends keyof StoredNotification>(k: K, v: StoredNotification[K] | null | undefined) => {
        if (v === undefined) return;
        touched.push(String(k));
        if (v === null) delete rec[k];
        else rec[k] = v;
      };
      setOpt('title', p.title);
      setOpt('text', p.text);
      setOpt('icon', p.icon);
      setOpt('image', p.image);
      setOpt('priority', p.priority);
      setOpt('visibility', p.visibility);
      setOpt('publicTitle', p.publicTitle);
      setOpt('publicText', p.publicText);
      setOpt('pinned', p.pinned);
      setOpt('popupDurationMs', p.popupDurationMs);
      setOpt('components', p.components);
      setOpt('context', p.context);
      // (A kept app desktop dialogue keeps popup true: it always opens at once.)
      if (p.popup !== undefined && !(rec.type === 'dialogue' && rec.scope === 'desktop' && !isSystemCaller(caller))) {
        const f = { popup: p.popup };
        await this.gate(caller, f, warnings, actorName);
        if (f.popup && rec.type !== 'dialogue') {
          f.popup = false;
          warnings.push({ code: 'ignored-field', field: 'popup', message: 'popup only applies to type dialogue' });
        }
        // Turning popup on again counts against the forced pop-up limit.
        if (f.popup && !rec.popup) await this.gatePopupRate(caller, f, warnings);
        setOpt('popup', f.popup);
      }
      // Phase 4: scope / blocking are re-gated like popup. A context change
      // re-checks an existing blocking flag (it must stay the sender's own window).
      if (p.scope !== undefined || p.blocking !== undefined) {
        const f: { blocking?: boolean; scope?: string } = {};
        if (p.scope !== undefined) f.scope = p.scope;
        if (p.blocking !== undefined) f.blocking = p.blocking;
        this.dialogueOnly(rec.type, f, warnings, { ...(p.blocking !== undefined ? { blocking: p.blocking } : {}), ...(p.scope !== undefined ? { scope: p.scope } : {}) });
        // Phase 6: judged on the RESULTING scope + blocking (one may be unchanged).
        const eff = { scope: f.scope ?? rec.scope ?? 'auto', blocking: f.blocking ?? rec.blocking ?? false };
        const wasModal = rec.scope === 'desktop' && rec.blocking === true;
        if (rec.type === 'dialogue') await this.gateDesktop(caller, eff, warnings, actorName, !wasModal);
        // A kept app desktop dialogue always opens at once (popup is irrelevant).
        if (rec.type === 'dialogue' && eff.scope === 'desktop' && !isSystemCaller(caller)) setOpt('popup', true);
        if (f.scope !== undefined || eff.scope !== (rec.scope ?? 'auto')) setOpt('scope', (rec.type === 'dialogue' ? eff.scope : f.scope) as StoredNotification['scope']);
        if (f.blocking !== undefined || (eff.scope !== 'desktop' && rec.blocking)) {
          const b = { blocking: rec.type === 'dialogue' ? eff.blocking : (f.blocking ?? false), scope: rec.type === 'dialogue' ? eff.scope : 'auto' };
          await this.gateBlocking(caller, b, rec.context, warnings);
          setOpt('blocking', b.blocking);
        }
      } else if (p.context !== undefined && rec.blocking && rec.scope !== 'desktop') {
        const b = { blocking: true };
        await this.gateBlocking(caller, b, rec.context, warnings);
        if (!b.blocking) setOpt('blocking', false);
      }
      if (p.timeoutMs !== undefined) {
        touched.push('timeoutMs');
        if (p.timeoutMs === null) { delete rec.timeoutMs; delete rec.expiresAt; }
        else { rec.timeoutMs = p.timeoutMs; rec.expiresAt = now + p.timeoutMs; }
      }
      if (p.sender) {
        // Only display hints; identity is re-derived from the ORIGINAL caller.
        rec.sender = deriveSender(rec.caller, { ...p.sender });
        touched.push('sender');
      }
      rec.updatedAt = now;
      pushHistory(rec, { event: 'updated', at: now, actor, detail: { fields: touched } });
      await this.commit(rec, 'updated', now);
      return { notification: toPublic(rec), warnings };
    });
  }

  /** Sender op: the sender is done with it (e.g. task complete). Reason `completed`. */
  async removeBySender(id: string, caller: NotificationPrincipal, senderToken?: string): Promise<Notification> {
    this.assertCaller(caller);
    await this.assertMaySend(caller);
    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      const actor = this.authorizeSender(rec, caller, senderToken);
      return this.removeLocked(rec, 'completed', actor);
    });
  }

  // ---- reads -----------------------------------------------------------------

  /**
   * One notification, or null. With a `viewer`, read scoping applies: a
   * verified app / API key gets null (= 404) for anything not its own.
   */
  async get(id: string, viewer?: ViewerInput): Promise<Notification | null> {
    return this.getWith(id, await this.accessFor(viewer), isViewer(viewer) ? viewer.senderToken : undefined);
  }

  /** `get` with an already resolved access. A matching senderToken proves ownership of this one item. */
  private async getWith(id: string, access: Access, senderToken?: string): Promise<Notification | null> {
    if (!NOTIFICATION_ID_PATTERN.test(id)) return null;
    const rec = await this.store.load(id);
    if (!rec) return null;
    if (senderToken && tokenMatches(senderToken, rec.senderTokenHash)) return toPublic(rec);
    return viewFor(rec, access);
  }

  /**
   * Wait until notification `id` leaves `active` (resolved or removed), or
   * `timeoutMs` passes. Read-scoped like `get` (null → not found / not yours).
   * Woken in-process by the commit of the change (the shell is the only writer),
   * with a slow poll as a safety net.
   *
   * Phase 6: `until: 'interaction'` also returns on the next user interaction
   * (`lastInteraction.at > after`). `after` defaults to the current
   * `lastInteraction.at` (or 0 when there is none), so a caller that passes the
   * `at` it saw last never misses one that happened in between.
   * `reason` says why it returned.
   */
  async waitFor(id: string, viewer: ViewerInput, opts: WaitForOptions): Promise<WaitForResult | null> {
    const timeoutMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(opts.timeoutMs)));
    const until = opts.until ?? 'resolved';
    const access = await this.accessFor(viewer);
    const token = isViewer(viewer) ? viewer.senderToken : undefined;
    const first = await this.getWith(id, access, token);
    if (!first) return null;
    const after = until === 'interaction'
      ? (typeof opts.after === 'number' && Number.isFinite(opts.after) ? opts.after : (first.lastInteraction?.at ?? 0))
      : Infinity;
    const settled = (n: Notification): WaitForResult | null => {
      if (n.state !== 'active') return { notification: n, timedOut: false, reason: n.state === 'resolved' ? 'resolved' : 'removed' };
      if (until === 'interaction' && n.lastInteraction && n.lastInteraction.at > after) return { notification: n, timedOut: false, reason: 'interaction' };
      return null;
    };
    const done0 = settled(first);
    if (done0) return done0;
    if (timeoutMs === 0) return { notification: first, timedOut: true, reason: 'timeout' };
    const deadline = Date.now() + timeoutMs;
    let set = this.waiters.get(id);
    if (!set) { set = new Set(); this.waiters.set(id, set); }
    const waiters = set;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) => {
          const wake = () => { clearTimeout(t); waiters.delete(wake); resolve(); };
          const t = setTimeout(wake, Math.min(remaining, 5_000));
          waiters.add(wake);
        });
        const cur = await this.getWith(id, access, token);
        if (!cur) return null;
        const done = settled(cur);
        if (done) return done;
      }
    } finally {
      if (waiters.size === 0 && this.waiters.get(id) === waiters) this.waiters.delete(id);
    }
    const last = await this.getWith(id, access, token);
    if (!last) return null;
    return settled(last) ?? { notification: last, timedOut: true, reason: 'timeout' };
  }

  /**
   * List. With a `viewer`, read scoping applies: a verified app / API key is
   * limited to its own senderKey (asking for another sender returns nothing).
   */
  async list(query: ListQuery | unknown = {}, viewer?: ViewerInput): Promise<ListResult> {
    const parsed = ListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new NotificationError(400, 'invalid list query', zodDetails(parsed.error));
    const q = parsed.data;
    const access = await this.accessFor(viewer);
    if (access.kind === 'none') return { items: [] };
    // An app / key without a read grant can only ever see its own sender key.
    if (access.kind === 'principal' && !access.grant) {
      if (q.sender && q.sender !== access.own) return { items: [] };
      q.sender = access.own;
    }
    let cursor: { score: number; id: string } | undefined;
    if (q.cursor) {
      const m = /^(\d+):(ntf_[a-z0-9]+)$/.exec(q.cursor);
      if (!m) throw new NotificationError(400, 'invalid cursor');
      cursor = { score: Number(m[1]), id: m[2]! };
    }
    const key = q.sender ? senderIndexKey(q.sender) : q.state === 'active' ? KEY_ACTIVE : KEY_ALL;
    const items: Notification[] = [];
    let last: { score: number; id: string } | undefined;
    let more = false;
    let batch: Array<{ id: string; score: number }> = [];

    const flush = async (): Promise<boolean> => {
      const recs = await this.store.loadMany(batch.map((b) => b.id));
      const byId = new Map(recs.map((r) => [r.id, r]));
      const dangling: string[] = [];
      try {
        for (const b of batch) {
          const rec = byId.get(b.id);
          if (!rec) { dangling.push(b.id); continue; }
          if (q.state !== 'all' && rec.state !== q.state) continue;
          if (q.priority && rec.priority !== q.priority) continue;
          const view = viewFor(rec, access);
          if (!view) continue;
          if (items.length >= q.limit) { more = true; return false; }
          items.push(view);
          last = b;
        }
        batch = [];
        return true;
      } finally {
        // Safety net (phase 5): an index entry whose item is gone is dropped.
        if (dangling.length) void this.store.pruneDangling(dangling, key).catch(() => undefined);
      }
    };

    for await (const entry of this.store.iterateDesc(key, cursor)) {
      batch.push(entry);
      if (batch.length >= 100 && !(await flush())) break;
    }
    if (!more && batch.length) await flush();
    const lastEntry = last as { score: number; id: string } | undefined;
    return { items, ...(more && lastEntry ? { nextCursor: `${lastEntry.score}:${lastEntry.id}` } : {}) };
  }

  // ---- user ops ----------------------------------------------------------------
  //
  // Every user op takes an optional `viewer` (the routes always pass one).
  // With a viewer (phase 5):
  //   - an item the viewer can't read is 404 — nothing happens;
  //   - an app / API key acts only on its OWN items (a read grant is not a
  //     write grant: 403);
  //   - a LOCKED screen may only mark displayed / seen; everything else
  //     needs the unlocked screen ("unlock first", 403);
  //   - the response is the viewer's view of the item.
  // Without a viewer (in-process callers and tests): no checks, full item.

  /** Throws 404 / 403 per the rules above. */
  private gateUserOp(rec: StoredNotification, access: Access, op: string, needFull: boolean): void {
    if (!accessCanRead(access, rec)) throw new NotificationError(404, `notification not found: ${rec.id}`);
    if (access.kind === 'principal' && rec.senderKey !== access.own) {
      throw new NotificationError(403, `${op}: read access to another sender's notifications does not allow changing them`);
    }
    if (needFull && !accessSeesFull(access, rec)) {
      throw new NotificationError(403, `${op}: the screen is locked — unlock first`);
    }
  }

  private out(rec: StoredNotification, access: Access | undefined): Notification {
    if (!access) return toPublic(rec);
    // Readable before the op (gated); after it the item can only be MORE visible.
    return viewFor(rec, access) ?? ({ id: rec.id, state: rec.state } as Notification);
  }

  private async userAccess(viewer: ViewerInput | undefined): Promise<Access | undefined> {
    return viewer === undefined ? undefined : this.accessFor(viewer);
  }

  async markDisplayed(id: string, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<Notification> {
    return this.mark(id, 'displayed', actor, await this.userAccess(viewer));
  }

  async markSeen(id: string, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<Notification> {
    return this.mark(id, 'seen', actor, await this.userAccess(viewer));
  }

  private async mark(id: string, event: 'displayed' | 'seen', actor: Actor, access?: Access): Promise<Notification> {
    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      if (access) this.gateUserOp(rec, access, event, false);
      if (rec.state === 'removed') throw new NotificationError(409, 'notification is removed');
      const field = event === 'displayed' ? 'displayedAt' : 'seenAt';
      if (rec[field] !== undefined) return this.out(rec, access); // idempotent: first time only
      const now = this.now();
      rec[field] = now;
      // Seeing implies it was displayed.
      if (event === 'seen' && rec.displayedAt === undefined) rec.displayedAt = now;
      pushHistory(rec, { event, at: now, actor: structuredClone(actor) });
      await this.commit(rec, event, now);
      return this.out(rec, access);
    });
  }

  async resolve(id: string, answer: unknown, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<Notification> {
    const parsed = AnswerSchema.safeParse(answer);
    if (!parsed.success) throw new NotificationError(400, 'invalid answer', zodDetails(parsed.error));
    const access = await this.userAccess(viewer);
    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      if (access) this.gateUserOp(rec, access, 'resolve', true);
      if (rec.state !== 'active') throw new NotificationError(409, `notification is ${rec.state}`);
      answer = normalizeAnswerValues(rec, answer);
      const now = this.now();
      rec.state = 'resolved';
      rec.resolvedAt = now;
      if (answer !== undefined) rec.answer = answer;
      // Phase 4: submitted / cancelled (no outcome given → submitted).
      rec.outcome = outcomeOf(answer);
      rec.updatedAt = now;
      pushHistory(rec, { event: 'resolved', at: now, actor: structuredClone(actor), detail: { outcome: rec.outcome } });
      await this.commit(rec, 'resolved', now);
      return this.out(rec, access);
    });
  }

  /**
   * User op (phase 3): the user used a component without ending the
   * notification — a button without `action`, an input submit or an options
   * choice. Only while active. Validated against the item's components;
   * stored as `lastInteraction`, recorded as history `interacted`
   * (`{componentId, kind}` only) and published as lifecycle event
   * `interacted`, so the sender gets it via SSE / bus / `GET`.
   * Buttons with an `action` are not interactions: resolve → `resolve()`,
   * dismiss → `dismiss()`, link → the client opens `href`.
   */
  async interact(id: string, input: InteractionInput | unknown, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<Notification> {
    const parsed = InteractionInputSchema.safeParse(input);
    if (!parsed.success) throw new NotificationError(400, 'invalid interaction', zodDetails(parsed.error));
    const p = parsed.data;
    const access = await this.userAccess(viewer);
    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      if (access) this.gateUserOp(rec, access, 'interact', true);
      if (rec.state !== 'active') throw new NotificationError(409, `notification is ${rec.state}`);
      const byId = new Map((rec.components ?? []).filter((c) => c.id).map((c) => [c.id as string, c]));
      const c = byId.get(p.componentId);
      if (!c) throw new NotificationError(400, `unknown component '${p.componentId}'`);
      if (c.kind === 'progress') throw new NotificationError(400, `component '${c.id}' is a progress bar — nothing to interact with`);
      if (c.kind === 'button' && c.role) {
        throw new NotificationError(400, `button '${c.id}' has role '${c.role}' — ${c.role === 'later' ? 'it is local to the shell' : 'POST …/resolve with answer.outcome'} instead`);
      }
      if (c.kind === 'button') {
        if (c.action) {
          throw new NotificationError(400, `button '${c.id}' has action '${c.action}' — ${c.action === 'resolve' ? 'POST …/resolve' : c.action === 'dismiss' ? 'DELETE the notification' : 'open its href'} instead`);
        }
        if (p.value !== undefined) throw new NotificationError(400, `button '${c.id}' takes no value`);
      } else if (p.value === undefined) {
        throw new NotificationError(400, `${c.kind} '${c.id}' needs a value`);
      }
      const value = c.kind === 'button' ? undefined : normalizeValue(c, p.value, 'value');
      let values: Record<string, InteractionValue> | undefined;
      if (p.values) {
        values = {};
        for (const [k, v] of Object.entries(p.values)) {
          const vc = byId.get(k);
          if (!vc || !isFieldComponent(vc)) {
            throw new NotificationError(400, `values: '${k}' is not an input, options, select or combobox component`);
          }
          values[k] = normalizeValue(vc, v, 'values') as InteractionValue;
        }
      }
      const now = this.now();
      const interaction: Interaction = {
        componentId: p.componentId,
        kind: c.kind,
        ...(value !== undefined ? { value } : {}),
        ...(values ? { values } : {}),
        at: now,
        actor: structuredClone(actor),
      };
      rec.lastInteraction = interaction;
      pushHistory(rec, { event: 'interacted', at: now, actor: structuredClone(actor), detail: { componentId: c.id, kind: c.kind } });
      await this.commit(rec, 'interacted', now);
      return this.out(rec, access);
    });
  }

  /**
   * Phase 6: stop an APP desktop modal from blocking — it stays an active,
   * normal dialogue (scope auto, blocking off, no auto-open) and the sender
   * sees an `updated` history entry with `detail.reason`:
   *   force-hidden        the user (an unlocked shell screen) hid it
   *   permission-revoked  its sender lost `notifications.desktopModal` / was disabled
   *   admin-released      `aura admin notif release`
   * It is not resolved or dismissed. AuraOS's own decisions cannot be
   * released (409). Without a viewer (in-process / admin) no read check.
   */
  async releaseDesktopModal(id: string, reason: DesktopModalRelease, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<Notification> {
    const access = await this.userAccess(viewer);
    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      if (access) this.gateUserOp(rec, access, 'release', true);
      if (rec.state !== 'active') throw new NotificationError(409, `notification is ${rec.state}`);
      if (isSystemCaller(rec.caller) || rec.senderKey === 'auraos') throw new NotificationError(409, 'AuraOS decisions cannot be hidden or released — answer them');
      if (!(rec.scope === 'desktop' && rec.blocking)) throw new NotificationError(409, 'not a blocking desktop modal');
      this.releaseRec(rec, reason, actor);
      await this.commit(rec, 'updated', rec.updatedAt);
      return this.out(rec, access);
    });
  }

  /** Mutates `rec` (lock held): blocking off, scope auto, no auto-open, history. */
  private releaseRec(rec: StoredNotification, reason: DesktopModalRelease, actor: Actor): void {
    const now = this.now();
    rec.blocking = false;
    rec.scope = 'auto';
    rec.popup = false;
    rec.updatedAt = now;
    pushHistory(rec, { event: 'updated', at: now, actor: structuredClone(actor), detail: { fields: ['scope', 'blocking', 'popup'], reason } });
  }

  /**
   * Phase 6: release every active desktop modal of one sender (`app:<id>`,
   * `key:<id>`) — after a revoke, a disable or an uninstall. Returns the ids.
   */
  async releaseDesktopModalsOf(senderKey: string, reason: DesktopModalRelease, actor: Actor = { kind: 'system', verification: 'internal', reason }): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list({ state: 'active', sender: senderKey, limit: 200, ...(cursor ? { cursor } : {}) });
      for (const n of page.items) {
        if (!(n.type === 'dialogue' && n.scope === 'desktop' && n.blocking)) continue;
        await this.withLock(n.id, async () => {
          const rec = await this.store.load(n.id);
          if (!rec || rec.state !== 'active' || !(rec.scope === 'desktop' && rec.blocking) || isSystemCaller(rec.caller)) return;
          this.releaseRec(rec, reason, actor);
          await this.commit(rec, 'updated', rec.updatedAt);
          out.push(rec.id);
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /**
   * Phase 6: release every active app desktop modal whose sender may no
   * longer block the desktop (grant revoked, app disabled / uninstalled,
   * scope changed). Runs at start and with every retention pass. Returns ids.
   */
  async sweepDesktopModals(): Promise<string[]> {
    if (!this.authorizer) return [];
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list({ state: 'active', limit: 200, ...(cursor ? { cursor } : {}) });
      for (const n of page.items) {
        if (!(n.type === 'dialogue' && n.scope === 'desktop' && n.blocking) || n.senderKey === 'auraos') continue;
        const rec = await this.store.load(n.id);
        if (!rec || isSystemCaller(rec.caller)) continue;
        const c = rec.caller;
        const allowed = (c.kind === 'instance' || c.kind === 'apiKey')
          && (await this.authorizer.authorize(c, DESKTOP_MODAL_PERMISSION).catch(() => ({ allow: false }))).allow;
        if (allowed) continue;
        await this.withLock(n.id, async () => {
          const cur = await this.store.load(n.id);
          if (!cur || cur.state !== 'active' || !(cur.scope === 'desktop' && cur.blocking)) return;
          this.releaseRec(cur, 'permission-revoked', { kind: 'system', verification: 'internal', reason: 'permission-revoked' });
          await this.commit(cur, 'updated', cur.updatedAt);
          out.push(cur.id);
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /** User op. Locked notifications cannot be dismissed (use force-remove). */
  async dismiss(id: string, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<Notification> {
    const access = await this.userAccess(viewer);
    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      if (access) this.gateUserOp(rec, access, 'dismiss', true);
      if (rec.type === 'locked' && rec.state === 'active') {
        throw new NotificationError(409, 'locked notifications cannot be dismissed — use force-remove');
      }
      return this.out(await this.removeLockedRec(rec, 'dismissed', actor), access);
    });
  }

  /** User op: remove regardless of type (also locked). */
  async forceRemove(id: string, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<Notification> {
    const access = await this.userAccess(viewer);
    return this.withLock(id, async () => {
      const rec = await this.mustLoad(id);
      if (access) this.gateUserOp(rec, access, 'force-remove', true);
      return this.out(await this.removeLockedRec(rec, 'force-removed', actor), access);
    });
  }

  /**
   * Bulk user ops (clear, clear history) with a viewer: a locked screen is
   * refused, anonymous without a session is refused, an app / key only
   * touches its own items. Returns the per-item predicate.
   */
  private async bulkGate(viewer: ViewerInput | undefined, op: string): Promise<(rec: StoredNotification) => boolean> {
    if (viewer === undefined) return () => true;
    const access = await this.accessFor(viewer);
    if (access.kind === 'none') throw new NotificationError(403, `${op} needs the shell (a client session) or a verified caller`);
    if (access.kind === 'screen' && access.lock !== 'unlocked') throw new NotificationError(403, `${op}: the screen is locked — unlock first`);
    if (access.kind === 'principal') return (rec) => rec.senderKey === access.own;
    return () => true;
  }

  /** User op: remove every active notification matching `filter`, except locked ones. */
  async clear(filter: ClearFilter | unknown = {}, actor: Actor = UNVERIFIED_USER, viewer?: ViewerInput): Promise<{ cleared: number; skippedLocked: number }> {
    const parsed = ClearFilterSchema.safeParse(filter ?? {});
    if (!parsed.success) throw new NotificationError(400, 'invalid clear filter', zodDetails(parsed.error));
    const f = parsed.data;
    const allowed = await this.bulkGate(viewer, 'clear');
    let cleared = 0;
    let skippedLocked = 0;
    const ids: string[] = [];
    for await (const e of this.store.iterateDesc(KEY_ACTIVE)) ids.push(e.id);
    for (const id of ids) {
      await this.withLock(id, async () => {
        const rec = await this.store.load(id);
        if (!rec || rec.state !== 'active') return;
        if (f.sender && rec.senderKey !== f.sender) return;
        if (f.priority && rec.priority !== f.priority) return;
        if (!allowed(rec)) return;
        if (rec.type === 'locked') { skippedLocked++; return; }
        await this.removeLocked(rec, 'cleared', actor);
        cleared++;
      });
    }
    return { cleared, skippedLocked };
  }

  /**
   * User op (phase 5): delete ended (resolved / removed) items NOW, item and
   * history, optionally of one sender. Active items are never touched.
   */
  async clearHistory(filter: { sender?: string } = {}, viewer?: ViewerInput): Promise<{ deleted: number }> {
    const sender = typeof filter.sender === 'string' && filter.sender ? filter.sender : undefined;
    if (sender !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:\-]{0,199}$/.test(sender)) throw new NotificationError(400, 'invalid sender');
    const allowed = await this.bulkGate(viewer, 'clear history');
    const ids: string[] = [];
    for await (const e of this.store.iterateDesc(sender ? senderIndexKey(sender) : KEY_ALL)) ids.push(e.id);
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const recs = await this.store.loadMany(ids.slice(i, i + 200));
      const gone = recs.filter((r) => r.state !== 'active' && (!sender || r.senderKey === sender) && allowed(r));
      for (const r of gone) {
        await this.withLock(r.id, async () => {
          const cur = await this.store.load(r.id);
          if (!cur || cur.state === 'active') return;
          deleted += await this.store.deleteItems([{ id: cur.id, senderKey: cur.senderKey }]);
        });
      }
    }
    return { deleted };
  }

  /**
   * Phase 5 retention pass: delete ended items older than their sender's
   * retention (`os/notifications.retention`, default 7 days, `'forever'`
   * keeps them). Active items are never deleted here — only their timeout
   * ends them. The first pass backfills the `ended` index once.
   */
  async sweepRetention(): Promise<{ deleted: number; backfilled: number | null }> {
    let backfilled: number | null = null;
    if (!this.backfilled) {
      backfilled = await this.store.backfillEnded();
      this.backfilled = true;
    }
    const settings = await this.settings();
    const spans = [settings.retention.days, ...Object.values(settings.retention.apps)]
      .filter((d): d is number => d !== 'forever');
    if (spans.length === 0) return { deleted: 0, backfilled };
    const now = this.now();
    const cutoff = now - Math.min(...spans) * 86_400_000;
    let deleted = 0;
    let offset = 0;
    for (let rounds = 0; rounds < 100; rounds++) {
      const batch = await this.store.endedBefore(cutoff, 500 + offset);
      const slice = batch.slice(offset);
      if (slice.length === 0) break;
      const recs = new Map((await this.store.loadMany(slice.map((b) => b.id))).map((r) => [r.id, r]));
      const doomed: Array<{ id: string; senderKey: string }> = [];
      const dangling: string[] = [];
      for (const b of slice) {
        const rec = recs.get(b.id);
        if (!rec) { dangling.push(b.id); continue; }
        const endedAt = endedAtOf(rec);
        const keep = retentionMsFor(settings, rec.senderKey);
        if (endedAt === null) { dangling.push(b.id); continue; }   // active again? not ended — drop the index entry
        if (keep !== null && endedAt < now - keep) doomed.push({ id: rec.id, senderKey: rec.senderKey });
        else offset++;
      }
      if (dangling.length) await this.store.pruneDangling(dangling);
      for (const d of doomed) {
        await this.withLock(d.id, async () => {
          const cur = await this.store.load(d.id);
          if (!cur || cur.state === 'active') return;
          deleted += await this.store.deleteItems([d]);
        });
      }
      if (slice.length < 500) break;
    }
    return { deleted, backfilled };
  }

  /** Remove timed-out notifications (reason `expired`); every 60 s also the retention pass. Called by the sweeper. */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const now = this.now();
      if (now - this.lastRetentionAt >= this.retentionIntervalMs) {
        this.lastRetentionAt = now;
        try {
          const released = await this.sweepDesktopModals();
          if (released.length) console.log(`[notifications] released ${released.length} desktop modal(s) without a grant`);
        } catch (err) {
          console.warn(`[notifications] desktop-modal sweep failed: ${(err as Error).message}`);
        }
        try {
          const r = await this.sweepRetention();
          if (r.deleted || r.backfilled) console.log(`[notifications] retention: ${r.deleted} deleted${r.backfilled ? `, ${r.backfilled} backfilled into the ended index` : ''}`);
        } catch (err) {
          console.warn(`[notifications] retention pass failed: ${(err as Error).message}`);
        }
      }
      let n = 0;
      for (const id of await this.store.expiredIds(now)) {
        await this.withLock(id, async () => {
          const rec = await this.store.load(id);
          if (!rec || rec.state !== 'active' || rec.expiresAt === undefined || rec.expiresAt > now) return;
          await this.removeLocked(rec, 'expired', { kind: 'system', verification: 'internal', reason: 'timeout' });
          n++;
        });
      }
      return n;
    } finally {
      this.sweeping = false;
    }
  }

  /** NotificationCaller must hold the lock for rec.id. */
  private async removeLocked(rec: StoredNotification, reason: RemovedReason, actor: Actor): Promise<Notification> {
    return toPublic(await this.removeLockedRec(rec, reason, actor));
  }

  private async removeLockedRec(rec: StoredNotification, reason: RemovedReason, actor: Actor): Promise<StoredNotification> {
    if (rec.state === 'removed') throw new NotificationError(409, 'notification is already removed');
    const now = this.now();
    rec.state = 'removed';
    rec.removedReason = reason;
    rec.removedAt = now;
    rec.updatedAt = now;
    pushHistory(rec, { event: 'removed', at: now, actor: structuredClone(actor), detail: { reason } });
    await this.commit(rec, 'removed', now);
    return rec;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const GLOBAL_KEY = '__auraNotificationService';
type GlobalWithService = typeof globalThis & { [GLOBAL_KEY]?: NotificationService };

/** Relay a committed lifecycle event onto OsEventBus as `notification:<event>` (no content). */
export function emitNotificationBusEvent(ev: LifecycleEvent): void {
  OsEventBus.emit(`notification:${ev.event}`, { eventId: ev.eventId, id: ev.id, state: ev.state });
}

/**
 * The shell-wide service on the singleton KvServer (lazily connects on first
 * use), wired to OsEventBus. The listener is (re)attached on every call so a
 * singleton created by an older module copy still relays after a reload.
 */
export function getNotificationService(): NotificationService {
  const g = globalThis as GlobalWithService;
  let svc = g[GLOBAL_KEY];
  // A singleton built by an older module copy (no phase-2 authorizer, …) is
  // replaced once; the new one takes over its sweeper.
  if (svc && ((svc as { version?: number }).version ?? 1) < NOTIFICATION_SERVICE_VERSION) {
    const wasRunning = svc.running;
    try { svc.stop(); } catch { /* old copy */ }
    svc = new NotificationService();
    if (wasRunning) svc.start();
    g[GLOBAL_KEY] = svc;
  }
  svc ??= g[GLOBAL_KEY] = new NotificationService();
  svc.setEventListener(emitNotificationBusEvent);
  // Phase 2: the central Authorizer + the default create rate limit.
  svc.setAuthorizer(getAuthServices().authorizer);
  if (!svc.rateLimitConfigured) svc.setCreateRateLimit(DEFAULT_CREATES_PER_MINUTE);
  // Phase 4: forced pop-up limit + window ownership through the AppManager.
  svc.setPopupLimit({ max: DEFAULT_POPUPS_PER_WINDOW, windowMs: DEFAULT_POPUP_WINDOW_MS });
  // Phase 6: blocking desktop modals per sender, and releasing them on revoke / disable / uninstall.
  // (the blocking desktop-modal limit comes from `os/notifications.desktopModal`, default 5 / 10 min)
  attachDesktopModalRelease();
  svc.setWindowOwnerResolver(appManagerWindowOwner);
  // Phase 5: the user's lock-screen + retention settings from the OS KV.
  svc.setSettingsProvider(kvNotificationSettings);
  return svc;
}

const RELEASE_HOOK_KEY = '__auraNotifDesktopModalReleaseHook';
/**
 * Phase 6: on `permissions:changed` (desktopModal revoked), `app:removed` and
 * `app:enabledChanged` (disabled), release that sender's desktop modals at
 * once. Attached once per process; always uses the CURRENT singleton.
 */
function attachDesktopModalRelease(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[RELEASE_HOOK_KEY]) return;
  g[RELEASE_HOOK_KEY] = true;
  const bus = OsEventBus as unknown as { on(t: string, fn: (ev: Record<string, unknown>) => void): void };
  const release = (senderKey: string, why: string) => {
    void getNotificationService().releaseDesktopModalsOf(senderKey, 'permission-revoked', { kind: 'system', verification: 'internal', reason: why })
      .then((ids) => { if (ids.length) console.log(`[notifications] ${why}: released ${ids.length} desktop modal(s) of ${senderKey}`); })
      .catch((err) => console.warn(`[notifications] desktop-modal release failed: ${(err as Error).message}`));
  };
  bus.on('permissions:changed', (ev) => {
    if (ev['permission'] !== DESKTOP_MODAL_PERMISSION || ev['change'] !== 'revoked') return;
    const id = String(ev['subjectId'] ?? '');
    if (!id) return;
    release(ev['subjectKind'] === 'apiKey' ? `key:${id}` : `app:${id}`, 'permission-revoked');
  });
  bus.on('app:removed', (ev) => { if (typeof ev['appId'] === 'string') release(`app:${ev['appId']}`, 'app-removed'); });
  bus.on('app:enabledChanged', (ev) => { if (ev['enabled'] === false && typeof ev['appId'] === 'string') release(`app:${ev['appId']}`, 'app-disabled'); });
}

/**
 * `os/notifications` from the central KV (the key `/api/kv/os/notifications`
 * writes — KvClient's `<ns>:<key>` JSON `{value, updatedAt}`), cached and
 * refreshed on `kv:changed` (plus a 5 s safety TTL).
 */
const SETTINGS_KV_KEY = 'os:notifications';
const SETTINGS_CACHE_KEY = '__auraNotificationSettingsCache';
interface SettingsCache { value: NotificationSettings; at: number; listening: boolean }
export async function kvNotificationSettings(): Promise<NotificationSettings> {
  const g = globalThis as Record<string, unknown>;
  let c = g[SETTINGS_CACHE_KEY] as SettingsCache | undefined;
  if (!c) {
    c = { value: DEFAULT_NOTIFICATION_SETTINGS, at: 0, listening: false };
    g[SETTINGS_CACHE_KEY] = c;
  }
  const cache = c;
  if (!cache.listening) {
    cache.listening = true;
    (OsEventBus as unknown as { on(t: string, fn: (ev: { namespace?: string; key?: string }) => void): void })
      .on('kv:changed', (ev) => { if (ev?.namespace === 'os' && ev.key === 'notifications') cache.at = 0; });
  }
  if (Date.now() - cache.at < 5_000) return cache.value;
  try {
    const raw = await defaultRedis().get(SETTINGS_KV_KEY);
    const entry = raw ? JSON.parse(raw) as { value?: unknown } : null;
    cache.value = parseNotificationSettings(entry?.value);
  } catch {
    // Keep the last known settings (defaults on a cold start).
  }
  cache.at = Date.now();
  return cache.value;
}

/**
 * Window ownership from the AppManager singleton. Looked up on globalThis
 * (the key `initAppManager` uses) instead of importing AppManager.ts, which
 * would pull the whole runtime into every notifications consumer.
 */
const APP_MANAGER_KEY = '__aura_app_manager__';
interface OwnerLookup {
  getActivity(id: string): { appId: string } | undefined;
  getInstance(id: string): { appId: string } | undefined;
}
export function appManagerWindowOwner(context: { kind: 'activity' | 'instance'; id: string }): string | null {
  const mgr = (globalThis as Record<string, unknown>)[APP_MANAGER_KEY] as OwnerLookup | undefined;
  if (!mgr) return null;
  if (context.kind === 'activity') return mgr.getActivity(context.id)?.appId ?? null;
  return mgr.getInstance(context.id)?.appId ?? null;
}
