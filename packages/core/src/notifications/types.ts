/**
 * AuraOS notifications — data model.
 *
 * Three separate concerns, never mixed:
 *
 *   • `caller`  — WHO made the request. Established server-side (verified
 *                 instance token, unverified hints, or the in-process
 *                 `SYSTEM_CALLER`). Immutable once stored.
 *   • `sender`  — what the UI shows as the source. Derived from the caller;
 *                 the client may only add a display `name` / `actor.name`,
 *                 which are marked declared / unverified.
 *   • permissions — phase 2: decided by the central `Authorizer`
 *                 (`packages/core/src/auth/`). Without an authorizer the
 *                 service keeps the phase-1 rule: locked + popup are
 *                 `SYSTEM_CALLER`-only.
 *
 * The core knows nothing about presentation.
 */

// ---------------------------------------------------------------------------
// NotificationCaller (authenticated identity of the request)
// ---------------------------------------------------------------------------

/** A request authenticated by a valid `AURA_INSTANCE_TOKEN`. */
export interface InstanceCaller {
  kind: 'instance';
  appId: string;
  instanceId: string;
  /** Set when an OS sidecar of `instanceId` calls with its own token. */
  sidecar?: string;
  verification: 'verified';
}

/** Attribution-only hints (Referer / X-Aura-Instance-Id). They NEVER authenticate. */
export interface CallerHints {
  appId?: string;
  instanceId?: string;
}

/** No credentials (or only hints). */
export interface AnonymousCaller {
  kind: 'anonymous';
  verification: 'unverified';
  hints?: CallerHints;
}

/** Aura core itself, in-process. Only the frozen `SYSTEM_CALLER` object counts. */
export interface SystemCaller {
  kind: 'system';
  verification: 'internal';
}

/**
 * A request authenticated with an admin-issued API key (`aura_k1_…`) —
 * an external REST caller. `name` is the label the admin gave the key.
 */
export interface ApiKeyCaller {
  kind: 'apiKey';
  keyId: string;
  name: string;
  verification: 'verified';
}

export type NotificationCaller = InstanceCaller | ApiKeyCaller | AnonymousCaller | SystemCaller;

/**
 * An admin session (shared operator credential). It may READ everything but
 * is not a sender: the Authorizer refuses it every sender permission. Never
 * stored as a notification's caller.
 */
export interface AdminCaller {
  kind: 'admin';
  credential: 'shared';
  sessionId: string;
  verification: 'verified';
}

/** Anyone the service can be called by: a sender, or an admin (reads only). */
export type NotificationPrincipal = NotificationCaller | AdminCaller;

/**
 * The ONLY system caller. Checked by object identity (`caller === SYSTEM_CALLER`),
 * so a structurally identical object (e.g. parsed from JSON) is not system.
 * No HTTP input can produce it — it exists for in-process calls only.
 */
const SYSTEM_CALLER_KEY = Symbol.for('aura.notifications.systemCaller');
/*
 * One object per PROCESS, not per module copy: in dev the shell loads
 * @aura/core more than once (Vite SSR graph, Node loader, HMR re-evaluation),
 * and an identity check against another copy's constant would refuse the
 * real system caller. The registry is globalThis — in-process only, nothing
 * an HTTP request can reach.
 */
export const SYSTEM_CALLER: SystemCaller = (() => {
  const g = globalThis as unknown as Record<symbol, SystemCaller | undefined>;
  return (g[SYSTEM_CALLER_KEY] ??= Object.freeze({ kind: 'system', verification: 'internal' }) as SystemCaller);
})();

export function isSystemCaller(caller: NotificationCaller): caller is SystemCaller {
  return caller === SYSTEM_CALLER;
}

/** App id of the Aura Shell Daemon — its notifications show as sender kind `agent`. */
export const SHELL_DAEMON_APP_ID = 'com.aura.aurashelld';

// ---------------------------------------------------------------------------
// Sender (display) and context
// ---------------------------------------------------------------------------

export type Attribution = 'verified' | 'declared' | 'unverified' | 'internal';
export type SenderKind = 'app' | 'agent' | 'rest' | 'auraos' | 'unknown';

export interface SenderActor {
  /** Display / audit only — never used for authorization. */
  name: string;
  attribution: 'declared' | 'unverified';
}

export interface Sender {
  kind: SenderKind;
  /** appId for `app` / `agent`, hinted appId for unverified app senders. */
  id?: string;
  name?: string;
  /** How trustworthy `name` is (client-supplied names are never `verified`). */
  nameAttribution?: 'declared' | 'unverified';
  icon?: string;
  /** How trustworthy `kind` + `id` are — derived from the caller only. */
  attribution: Attribution;
  actor?: SenderActor;
}

export type NotificationContextKind = 'activity' | 'instance' | 'task' | 'installation' | 'app' | 'custom';

/** What the notification is about. */
export interface NotificationContext {
  kind: NotificationContextKind;
  id: string;
  appId?: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type NotificationType = 'simple' | 'locked' | 'dialogue';
export type NotificationPriority = 'low' | 'medium' | 'high' | 'urgent';
export type NotificationVisibility = 'public' | 'private' | 'secret';
/** Placement scope of a dialogue (phase 4). `desktop` is SYSTEM_CALLER only. */
export type NotificationScope = 'auto' | 'desktop';

export interface InputComponent {
  kind: 'input';
  id: string;
  label?: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
}
export type OptionsDisplay = 'segmented' | 'radio' | 'checkbox';
export interface OptionsComponent {
  kind: 'options';
  id: string;
  label?: string;
  multiple?: boolean;
  /**
   * Phase 6: 'segmented' (single choice, default, ≤ 4 options), 'radio'
   * (single choice, vertical list, ≤ 8), 'checkbox' (multiple: true —
   * its default and only display, ≤ 8).
   */
  display?: OptionsDisplay;
  /** 1–4 options (segmented), 1–8 (radio / checkbox); `description` ≤ 200. */
  options: Array<{ id: string; label: string; description?: string }>;
}
/** Phase 6: a dropdown, one choice out of 1–50 options; the value is the option id. */
export interface SelectComponent {
  kind: 'select';
  id: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  /** Preselected option id. */
  default?: string;
  options: Array<{ id: string; label: string }>;
}
/**
 * Phase 6: a searchable select (0–50 options). The value is an option id,
 * or — only with `allowCustom` — the typed free text (≤ 200 chars).
 */
export interface ComboboxComponent {
  kind: 'combobox';
  id: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  allowCustom?: boolean;
  default?: string;
  options: Array<{ id: string; label: string }>;
}
export type ButtonRole = 'submit' | 'cancel' | 'later';
export interface ButtonComponent {
  kind: 'button';
  /** Always set once stored (a role button without one gets its role). */
  id: string;
  /** Optional on a role button: the shell shows its default text. */
  label?: string;
  variant: 'primary' | 'secondary' | 'tertiary';
  /** What a click does (rendering + wiring come in phase 3). */
  action?: 'resolve' | 'dismiss' | 'link';
  /**
   * Phase 4 standard dialogue buttons: submit (validates, resolves
   * outcome 'submitted'), cancel (resolves outcome 'cancelled'), later
   * (local: hides the dialogue). Missing ones are added by the shell.
   */
  role?: ButtonRole;
  href?: string;
}
export interface ProgressComponent {
  kind: 'progress';
  id?: string;
  /** 0..1, or null for indeterminate. */
  value: number | null;
  label?: string;
}
export type NotificationComponent = InputComponent | OptionsComponent | SelectComponent | ComboboxComponent | ButtonComponent | ProgressComponent;
/** Components that hold a value (inputs, choices, selects). */
export type FieldComponent = InputComponent | OptionsComponent | SelectComponent | ComboboxComponent;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type NotificationState = 'active' | 'resolved' | 'removed';
export type NotificationOutcome = 'submitted' | 'cancelled';
export type RemovedReason = 'dismissed' | 'expired' | 'completed' | 'force-removed' | 'cleared';
// Phase 5: ended items (resolved / removed) are deleted after the retention
// period (`os/notifications.retention`, default 7 days) — item AND history.
export type LifecycleEventName = 'created' | 'displayed' | 'seen' | 'updated' | 'resolved' | 'removed' | 'interacted';

/**
 * A user interaction with a component that does not end the notification
 * (phase 3): a button without `action`, an input submit, an options choice.
 * `value` is the used component's value; `values` optionally carries the
 * current values of every input / options component (by component id).
 */
export type InteractionValue = string | string[];
export interface Interaction {
  componentId: string;
  /** Kind of the used component. */
  kind: 'button' | 'input' | 'options' | 'select' | 'combobox';
  value?: InteractionValue;
  values?: Record<string, InteractionValue>;
  at: number;
  actor: Actor;
}

/** Who performed a lifecycle transition (recorded in `history[]`). */
export type Actor =
  | { kind: 'app'; appId: string; instanceId: string; sidecar?: string; verification: 'verified'; via?: 'senderToken' }
  | { kind: 'apiKey'; keyId: string; name: string; verification: 'verified'; via?: 'senderToken' }
  | { kind: 'anonymous'; verification: 'unverified'; hints?: CallerHints; via?: 'senderToken' }
  | { kind: 'system'; verification: 'internal'; reason?: string }
  /** Shell UI. Unauthenticated in phase 1 — always `unverified` (closed in phase 2). */
  | { kind: 'user'; verification: 'unverified' };

export const UNVERIFIED_USER: Actor = Object.freeze({ kind: 'user', verification: 'unverified' }) as Actor;

export interface HistoryEntry {
  event: LifecycleEventName;
  at: number;
  actor: Actor;
  /** e.g. the removed reason, or the fields an update touched. */
  detail?: Record<string, unknown>;
}

/** A notification as returned by the API (never contains the senderToken hash). */
export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  text: string;
  icon?: string;
  image?: string;
  priority: NotificationPriority;
  visibility: NotificationVisibility;
  publicTitle?: string;
  publicText?: string;
  timeoutMs?: number;
  /** createdAt/updatedAt + timeoutMs; the sweeper removes it after this. */
  expiresAt?: number;
  pinned: boolean;
  /**
   * How long the shell shows the pop-up, in ms (separate from `timeoutMs`,
   * the notification's lifetime): > 0 → hide after that long (the item stays
   * in the list); 0 or -1 → stays until dismissed, opened, answered, removed
   * or expired; absent → the shell default (8 s low / medium; high / urgent
   * stay until handled). Negatives are stored as -1; max 24 h.
   */
  popupDurationMs?: number;
  /** Dialogue opens as a popup. Needs `notifications.popup` (phase 2) and is rate limited (phase 4). */
  popup: boolean;
  /**
   * Dialogue only (phase 4): the dialogue makes its OWN window inert until
   * answered. Only kept when `context` is an activity / instance of the
   * caller's own app (resolved server-side); downgraded to false otherwise.
   * Records stored before phase 4 lack it; `toPublic` reads them as false.
   */
  blocking: boolean;
  /**
   * Dialogue only (phase 4): `'auto'` (placement from the context) or
   * `'desktop'` — a desktop-wide modal for AuraOS system decisions, kept only
   * for `SYSTEM_CALLER`. Pre-phase-4 records read as `'auto'` (`toPublic`).
   */
  scope: NotificationScope;
  components?: NotificationComponent[];
  context?: NotificationContext;

  caller: NotificationCaller;
  sender: Sender;
  /** Index key for "by sender" queries, e.g. `app:com.example.x`, `auraos`, `anon:rest`. */
  senderKey: string;

  state: NotificationState;
  removedReason?: RemovedReason;
  createdAt: number;
  updatedAt: number;
  displayedAt?: number;
  seenAt?: number;
  resolvedAt?: number;
  removedAt?: number;
  answer?: unknown;
  /** Phase 4: how a resolved dialogue was answered (a resolve without one = submitted). */
  outcome?: NotificationOutcome;
  /** The latest component interaction (phase 3); the history keeps only `{componentId, kind}`. */
  lastInteraction?: Interaction;
  history: HistoryEntry[];
  /**
   * Phase 5, read views only (never stored): set when a LOCKED shell screen
   * gets the item — no components, interactions, answer or history.
   */
  lockscreen?: true;
  /** Phase 5: a private item on a locked screen — sender + publicTitle/publicText only. */
  redacted?: true;
}

/** Stored form: the public shape plus the senderToken hash. */
export interface StoredNotification extends Notification {
  senderTokenHash?: string;
}

/** One entry of the `notif:events` stream / the live feed. */
export interface LifecycleEvent {
  /** Valkey stream id (`<ms>-<seq>`), usable as SSE `id` / Last-Event-ID. */
  eventId: string;
  id: string;
  event: LifecycleEventName;
  state: NotificationState;
  at: number;
}

/** A non-fatal note in a create/update response (downgrades, ignored fields). */
export interface NotificationWarning {
  code: 'downgraded' | 'ignored-field';
  field: string;
  message: string;
  from?: unknown;
  to?: unknown;
}
