/**
 * `osClient.notifications` — the AuraOS notification API for apps.
 *
 *   const { notification } = await os.notifications.create({
 *     type: 'dialogue', title: 'Deploy to prod?',
 *     components: [{ kind: 'button', id: 'yes', label: 'Deploy', variant: 'primary', action: 'resolve' }],
 *     context: { kind: 'task', id: 'deploy-42', label: 'Release 1.4' },
 *   });
 *   const r = await os.notifications.waitForAnswer(notification.id, { timeoutMs: 120_000 });
 *   if (r.status === 'resolved') console.log(r.answer);
 *
 * Identity (server/browser split, as in `interfaces.ts`):
 *   - Node (an app backend, lifecycle endpoint, Astro frontmatter): sends
 *     `Authorization: Bearer $AURA_INSTANCE_TOKEN`, so the shell attributes
 *     the notification to this app as VERIFIED. Sending needs
 *     `system.notifications` in the manifest (403 otherwise); Locked and
 *     dialogue pop-ups need `notifications.locked` / `notifications.popup`
 *     requested in the manifest AND granted by an admin — otherwise they are
 *     downgraded and `warnings[]` says so.
 *   - Browser: no token is ever sent (instance tokens never reach frontend
 *     code); the caller is UNVERIFIED (attribution from the Referer only).
 *     The `senderToken` create returns is remembered here, so the same page
 *     can still update / remove what it created.
 *
 * Reads (phase 5): a verified app sees its own notifications (get / list /
 * subscribe), plus other senders' only with an admin-granted, scoped
 * `notifications.read` (manifest request + `aura grant nperm <app> read
 * --scope …`). Browser (unverified) callers read nothing — except their own
 * items by id (`get` / `waitForAnswer` send the remembered senderToken).
 */
// ---------------------------------------------------------------------------
// Types (mirror @aura/core notifications; kept local so the SDK has no
// runtime dependency on core).
// ---------------------------------------------------------------------------

export type NotificationType = 'simple' | 'locked' | 'dialogue';
export type NotificationButtonRole = 'submit' | 'cancel' | 'later';
/** How a resolved dialogue was answered (phase 4). */
export type NotificationOutcome = 'submitted' | 'cancelled';
export type NotificationPriority = 'low' | 'medium' | 'high' | 'urgent';
export type NotificationVisibility = 'public' | 'private' | 'secret';
export type NotificationState = 'active' | 'resolved' | 'removed';
export type NotificationContextKind = 'activity' | 'instance' | 'task' | 'installation' | 'app' | 'custom';

export type NotificationComponent =
  | { kind: 'input'; id: string; label?: string; placeholder?: string; multiline?: boolean; required?: boolean }
  /**
   * `display` (phase 6): 'segmented' (single choice chips, the default, ≤ 4
   * options), 'radio' (single choice vertical list, ≤ 8) or 'checkbox'
   * (`multiple: true` — its default and only display, ≤ 8). An option's
   * `description` (≤ 200) shows under its label in the lists (a tooltip on chips).
   */
  | { kind: 'options'; id: string; label?: string; multiple?: boolean; display?: 'segmented' | 'radio' | 'checkbox'; options: Array<{ id: string; label: string; description?: string }> }
  /** Phase 6: a dropdown — one option id out of 1–50; `default` preselects one. */
  | { kind: 'select'; id: string; label?: string; placeholder?: string; required?: boolean; default?: string; options: Array<{ id: string; label: string }> }
  /**
   * Phase 6: a searchable select (0–50 options). The value is an option id,
   * or — with `allowCustom` — the typed free text (≤ 200 chars).
   */
  | { kind: 'combobox'; id: string; label?: string; placeholder?: string; required?: boolean; allowCustom?: boolean; default?: string; options: Array<{ id: string; label: string }> }
  /**
   * Phase 6: a markdown document (≤ 64 KB, at most 2 per notification) —
   * reports, summaries, logs. Rendered safely (no raw HTML; only http(s) /
   * mailto links; images are not loaded) with a Rendered ⇄ Source toggle and
   * Copy. The full area shows in the dialogue; the list and pop-ups show a
   * short preview with "Show". `editable: true` makes it a form field: the
   * edited text comes back in `answer.values[id]` (drafts and `required`
   * work like an input). `maxHeight`: px (80–4000) or 'auto' (default 320).
   */
  | { kind: 'markdown'; id: string; label?: string; text: string; view?: 'rendered' | 'source'; editable?: boolean; required?: boolean; maxHeight?: 'auto' | number }
  /**
   * `role` (phase 4) marks the standard dialogue buttons: 'submit' (validates,
   * resolves outcome 'submitted'), 'cancel' (resolves outcome 'cancelled'),
   * 'later' (local; hides the dialogue). Role buttons may leave out `label`
   * (default text) and `id` (defaults to the role); missing ones are added
   * by the shell. Custom buttons need `id` and `label`.
   */
  | { kind: 'button'; id?: string; label?: string; variant?: 'primary' | 'secondary' | 'tertiary'; action?: 'resolve' | 'dismiss' | 'link'; role?: NotificationButtonRole; href?: string }
  | { kind: 'progress'; id?: string; value: number | null; label?: string };

/** A value from an input or editable markdown (string), a select / combobox (option id or free text) or options (id, or ids when `multiple`). */
export type NotificationInteractionValue = string | string[];

/**
 * The user used a component without ending the notification (phase 3): a
 * button without `action`, an input submit or an options choice. Stored as
 * `Notification.lastInteraction` (the newest one only).
 */
export interface NotificationInteraction {
  componentId: string;
  kind: 'button' | 'input' | 'options' | 'select' | 'combobox' | 'markdown' | string;
  /** The component's own value (inputs / options). */
  value?: NotificationInteractionValue;
  /** The other fields' values sent along with a button. */
  values?: Record<string, NotificationInteractionValue>;
  /** ms since epoch — pass it as `after` to wait for the next one. */
  at: number;
  actor: Record<string, unknown>;
}

export interface NotificationContext {
  kind: NotificationContextKind;
  id: string;
  appId?: string;
  label?: string;
}

export interface NotificationInput {
  type?: NotificationType;
  title: string;
  text?: string;
  icon?: string;
  image?: string;
  priority?: NotificationPriority;
  visibility?: NotificationVisibility;
  publicTitle?: string;
  publicText?: string;
  /** Auto-remove (reason `expired`) after this many ms. Default: never. */
  timeoutMs?: number;
  pinned?: boolean;
  /**
   * How long the shell shows the POP-UP, in ms — separate from `timeoutMs`
   * (the notification's lifetime). Integer up to 24 h. > 0: hide after that
   * long (the item stays in the list). 0 or -1 (any negative is stored as
   * -1): a sticky pop-up that stays until dismissed, opened, answered,
   * removed or expired; it holds one of the 3 pop-up slots and is never
   * pushed out. Absent: the default (8 s for low / medium; high / urgent
   * stay until handled). `null` in an update goes back to the default.
   * Activity-linked items (context = your own window) ignore it: their
   * pop-up is always sticky.
   */
  popupDurationMs?: number;
  /**
   * Dialogue only; needs the admin-granted `notifications.popup`. At most 3
   * forced pop-ups per sender per 10 minutes — beyond that it is turned off
   * with a warning and the dialogue waits in the list.
   */
  popup?: boolean;
  /**
   * Dialogue only: make the sender's OWN window inert until answered (kept
   * only when `context` is an activity / instance of the calling app, else
   * turned off with a warning) — or, with `scope: 'desktop'`, the whole shell
   * (see `scope`). Default false.
   */
  blocking?: boolean;
  /**
   * Dialogue only: `'auto'` (default; placed by `context`) or `'desktop'`.
   * Phase 6: `'desktop'` + `blocking: true` is a desktop modal that blocks the
   * whole shell — it needs the admin-granted `notifications.desktopModal`
   * (else downgraded to `'auto'` with a warning; by default ≤ 5 per sender per
   * 10 min, configurable by the user — a hit is the warning code
   * `desktop-modal-rate-limited` with `retryAfterMs`). It always opens at
   * once — `popup` is irrelevant. The user sees "Requested by <your app>" and
   * can always force-hide it (history reason `force-hidden`); a revoke
   * releases it (`permission-revoked`). `'desktop'` without blocking is a
   * centred, non-blocking dialogue that also opens at once — it needs
   * `notifications.popup` (or desktopModal).
   */
  scope?: 'auto' | 'desktop';
  /**
   * Phase 6: start the dialogue maximized (e.g. a long markdown report) — a
   * presentation hint, no grant. The user's own maximize / restore in a tab
   * wins. Ignored (warning `ignored-field`) when nothing opens a dialogue
   * (not a dialogue and no form / markdown); ignored on the phone.
   */
  maximized?: boolean;
  components?: NotificationComponent[];
  /** What it is about (an activity, a task, …) — separate from who sent it. */
  context?: NotificationContext;
  /** Display hints only: `name`, `icon`, `actor.name` (always marked declared/unverified). */
  sender?: { name?: string; icon?: string; actor?: { name: string } };
}

/** `null` clears an optional field; `type` is fixed at create. */
export type NotificationPatch = {
  [K in Exclude<keyof NotificationInput, 'type' | 'title'>]?: NotificationInput[K] | null;
} & { title?: string };

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  text: string;
  priority: NotificationPriority;
  visibility: NotificationVisibility;
  pinned: boolean;
  /** See `NotificationInput.popupDurationMs` (absent = shell default). */
  popupDurationMs?: number;
  popup: boolean;
  /** Phase 5: set when a locked shell screen reads it (no components / answer). */
  lockscreen?: true;
  /** Phase 5: a private item on a locked screen — sender + public title / text only. */
  redacted?: true;
  /** Dialogue blocks its own window (see `NotificationInput.blocking`). */
  blocking: boolean;
  scope: 'auto' | 'desktop';
  /** Phase 6: the dialogue starts maximized (see `NotificationInput.maximized`). */
  maximized?: boolean;
  state: NotificationState;
  removedReason?: 'dismissed' | 'expired' | 'completed' | 'force-removed' | 'cleared';
  answer?: unknown;
  /** Set once resolved: 'submitted' or 'cancelled' (older shells: absent → submitted). */
  outcome?: NotificationOutcome;
  context?: NotificationContext;
  components?: NotificationComponent[];
  /** The newest user interaction (see `waitForInteraction`). */
  lastInteraction?: NotificationInteraction;
  sender: { kind: string; id?: string; name?: string; attribution: string; actor?: { name: string; attribution: string } };
  senderKey: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  removedAt?: number;
  history: Array<{ event: string; at: number; actor: Record<string, unknown>; detail?: Record<string, unknown> }>;
  [key: string]: unknown;
}

export interface NotificationWarning {
  /** 'desktop-modal-rate-limited' (phase 6) carries limit / windowMinutes / retryAfterMs / remaining. */
  code: 'downgraded' | 'ignored-field' | 'desktop-modal-rate-limited' | string;
  field: string;
  message: string;
  from?: unknown;
  to?: unknown;
  limit?: number;
  windowMinutes?: number;
  retryAfterMs?: number;
  remaining?: number;
}

export interface CreateResult {
  notification: Notification;
  /** Lets an unverified creator update / remove later. Remembered by this client. */
  senderToken?: string;
  warnings: NotificationWarning[];
  /** Phase 6: a kept desktop modal's budget (`remaining` null = unlimited). */
  desktopModal?: { remaining: number | null; limit: number | null; windowMinutes: number };
}

export interface ListFilter {
  state?: NotificationState | 'all';
  /** senderKey, e.g. `app:com.example.x`. Verified apps are limited to their own anyway. */
  sender?: string;
  priority?: NotificationPriority;
  limit?: number;
  cursor?: string;
}

export interface WaitResult {
  /** `resolved` (answered), `removed` (dismissed / expired / removed), or `pending` after the timeout. */
  status: 'resolved' | 'removed' | 'pending';
  notification: Notification;
  answer?: unknown;
  /** For `removed`: why — e.g. `'force-removed'` when the user force-removed a Locked notification. */
  removedReason?: Notification['removedReason'];
  /** For `resolved`: 'submitted' (Submit / any answer) or 'cancelled' (the Cancel button). */
  outcome?: NotificationOutcome;
}

export interface InteractionWaitResult {
  /**
   * `interaction` (a new `lastInteraction`), `resolved`, `removed`, or
   * `pending` after the timeout.
   */
  status: 'interaction' | 'resolved' | 'removed' | 'pending';
  notification: Notification;
  /** For `interaction`: the new interaction. */
  interaction?: NotificationInteraction;
  answer?: unknown;
  outcome?: NotificationOutcome;
  removedReason?: Notification['removedReason'];
}

/**
 * One frame of the live feed. `type` is `notification:<event>` (created,
 * updated, displayed, seen, resolved, removed — later versions may add more;
 * unknown types are passed through) or `reset` (reload with `list()`).
 */
export interface NotificationEvent {
  type: string;
  eventId: string;
  event?: string;
  id?: string;
  state?: NotificationState;
  /** The item's CURRENT full state (null when gone). */
  notification?: Notification | null;
}

export interface SubscribeOptions {
  /** Resume after this event id (else live only). Reconnects resume automatically. */
  since?: string;
  onError?: (err: Error) => void;
}

export class NotificationsError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'NotificationsError';
  }
}

export interface NotificationsOptions {
  /** OS API base. Default: '' in the browser (same origin), OS_API_BASE on Node. */
  base?: string;
  /** Instance token (Node only). Default: AURA_INSTANCE_TOKEN. Never used in a browser. */
  token?: string;
  fetch?: typeof fetch;
}

// ---------------------------------------------------------------------------

const LONG_POLL_S = 25;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function env(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

export class NotificationsApi {
  private readonly senderTokens = new Map<string, string>();

  constructor(private readonly opts: NotificationsOptions = {}) {}

  // ---- internals ---------------------------------------------------------

  private base(): string {
    if (this.opts.base !== undefined) return this.opts.base.replace(/\/+$/, '');
    if (isBrowser()) return '';
    return (env()['OS_API_BASE'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** Bearer on Node only — a browser never sends (or sees) the instance token. */
  private authHeaders(): Record<string, string> {
    if (isBrowser()) return {};
    const token = this.opts.token ?? env()['AURA_INSTANCE_TOKEN'];
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private doFetch(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, signal?: AbortSignal): Promise<{ data: T; res: Response }> {
    const res = await this.doFetch()(`${this.base()}${path}`, {
      method,
      headers: { ...this.authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
      const d = data as { error?: string; message?: string; details?: unknown } | undefined;
      throw new NotificationsError(res.status, `notifications: ${method} ${path} → ${res.status}: ${d?.message ?? d?.error ?? text}`, d?.details);
    }
    return { data: data as T, res };
  }

  private senderHeader(id: string, explicit?: string): Record<string, string> {
    const t = explicit ?? this.senderTokens.get(id);
    return t ? { 'X-Aura-Sender-Token': t } : {};
  }

  // ---- sender ops ----------------------------------------------------------

  /** Create a notification. Check `warnings` for downgrades (missing grants). */
  async create(input: NotificationInput): Promise<CreateResult> {
    const { data } = await this.call<CreateResult & { ok?: boolean }>('POST', '/api/notifications', input);
    if (data.senderToken) this.senderTokens.set(data.notification.id, data.senderToken);
    const { ok: _ok, ...rest } = data;
    return rest;
  }

  /** Change your own notification (e.g. progress). `null` clears an optional field. */
  async update(id: string, patch: NotificationPatch, opts: { senderToken?: string } = {}): Promise<{ notification: Notification; warnings: NotificationWarning[] }> {
    const { data } = await this.call<{ notification: Notification; warnings: NotificationWarning[] }>(
      'PATCH', `/api/notifications/${encodeURIComponent(id)}`, patch, this.senderHeader(id, opts.senderToken));
    return data;
  }

  /**
   * You are done with it (e.g. the task finished): removes your own
   * notification with reason `completed`. (Dismissing is a user action.)
   */
  async remove(id: string, opts: { senderToken?: string } = {}): Promise<Notification> {
    const { data } = await this.call<Notification>('POST', `/api/notifications/${encodeURIComponent(id)}/remove`, {}, this.senderHeader(id, opts.senderToken));
    this.senderTokens.delete(id);
    return data;
  }

  // ---- reads -----------------------------------------------------------------

  /**
   * One notification, or null (not found — or not yours). Phase 5: in the
   * browser (no instance token) the senderToken remembered from `create`
   * proves ownership of this one item, so a page reads its own back.
   */
  async get(id: string): Promise<Notification | null> {
    try {
      return (await this.call<Notification>('GET', `/api/notifications/${encodeURIComponent(id)}`, undefined, this.senderHeader(id))).data;
    } catch (err) {
      if (err instanceof NotificationsError && err.status === 404) return null;
      throw err;
    }
  }

  async list(filter: ListFilter = {}): Promise<{ items: Notification[]; nextCursor?: string }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const q = qs.toString();
    return (await this.call<{ items: Notification[]; nextCursor?: string }>('GET', `/api/notifications${q ? `?${q}` : ''}`)).data;
  }

  /**
   * Wait until the notification is answered (`resolved`) or gone (`removed`),
   * up to `timeoutMs` (default 60 s; 0 = check once). Uses the shell's
   * bounded long-poll (`GET /api/notifications/<id>?waitFor=resolved`), so
   * nothing is polled in a tight loop. Returns `pending` on timeout; throws
   * 404 when the notification doesn't exist (or isn't yours).
   */
  async waitForAnswer(id: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    const deadline = Date.now() + Math.max(0, opts.timeoutMs ?? 60_000);
    for (;;) {
      const left = Math.max(0, deadline - Date.now());
      const t = Math.min(LONG_POLL_S, Math.ceil(left / 1000));
      const { data } = await this.call<Notification>('GET',
        `/api/notifications/${encodeURIComponent(id)}?waitFor=resolved&timeout=${t}`, undefined, this.senderHeader(id), opts.signal);
      if (data.state !== 'active') {
        return {
          status: data.state, notification: data,
          ...(data.state === 'resolved' && data.answer !== undefined ? { answer: data.answer } : {}),
          ...(data.state === 'removed' && data.removedReason ? { removedReason: data.removedReason } : {}),
          ...(data.state === 'resolved' ? { outcome: data.outcome ?? 'submitted' } : {}),
        };
      }
      if (Date.now() >= deadline || opts.signal?.aborted) return { status: 'pending', notification: data };
    }
  }

  /**
   * Wait for the next user interaction — a button without `action`, an input
   * submit or an options choice — or for the notification to end, up to
   * `timeoutMs` (default 60 s; 0 = check once). Uses the shell's long-poll
   * `GET /api/notifications/<id>?waitFor=interaction&after=<ms>`.
   *
   * `after` (ms): only interactions newer than this count. Default: the
   * current `lastInteraction.at` (i.e. the next one). Pass the `at` of the
   * interaction you handled last, so one in between is never missed:
   *
   *   let after = 0;
   *   for (;;) {
   *     const r = await os.notifications.waitForInteraction(id, { after });
   *     if (r.status === 'interaction') { handle(r.interaction); after = r.interaction!.at; }
   *     else if (r.status !== 'pending') break;   // resolved / removed
   *   }
   */
  async waitForInteraction(id: string, opts: { after?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<InteractionWaitResult> {
    const deadline = Date.now() + Math.max(0, opts.timeoutMs ?? 60_000);
    let after = opts.after;
    for (;;) {
      const left = Math.max(0, deadline - Date.now());
      const t = Math.min(LONG_POLL_S, Math.ceil(left / 1000));
      const qs = `waitFor=interaction&timeout=${t}${after !== undefined ? `&after=${after}` : ''}`;
      const { data, res } = await this.call<Notification>('GET',
        `/api/notifications/${encodeURIComponent(id)}?${qs}`, undefined, this.senderHeader(id), opts.signal);
      if (data.state !== 'active') {
        return {
          status: data.state, notification: data,
          ...(data.state === 'resolved' && data.answer !== undefined ? { answer: data.answer } : {}),
          ...(data.state === 'removed' && data.removedReason ? { removedReason: data.removedReason } : {}),
          ...(data.state === 'resolved' ? { outcome: data.outcome ?? 'submitted' } : {}),
        };
      }
      const li = data.lastInteraction;
      const reason = res.headers.get('X-Aura-Wait-Reason');
      if (li && (after !== undefined ? li.at > after : reason === 'interaction')) {
        return { status: 'interaction', notification: data, interaction: li };
      }
      // Keep the baseline the first call used, so the next poll can't skip one.
      if (after === undefined) after = li?.at ?? 0;
      if (Date.now() >= deadline || opts.signal?.aborted) return { status: 'pending', notification: data };
    }
  }

  /**
   * Live feed of YOUR notifications (verified apps are scoped by the shell):
   * every lifecycle change, including dialogue answers (`notification:resolved`
   * with the full item and its `answer`). Browser: EventSource; Node: a
   * fetch-stream SSE parser with the Bearer. Both resume from the last event
   * id after a reconnect (`Last-Event-ID`). Returns an unsubscribe function.
   */
  subscribe(handler: (ev: NotificationEvent) => void, opts: SubscribeOptions = {}): () => void {
    let lastId = opts.since ?? '';
    let closed = false;
    const url = () => `${this.base()}/api/notifications/stream${lastId && isBrowser() ? `?since=${encodeURIComponent(lastId)}` : ''}`;
    const deliver = (data: string, id?: string) => {
      if (id) lastId = id;
      try {
        const ev = JSON.parse(data) as NotificationEvent;
        if (typeof ev.type === 'string') {
          if (ev.eventId) lastId = ev.eventId;
          handler(ev);
        }
      } catch { /* malformed frame */ }
    };

    if (isBrowser() && typeof EventSource !== 'undefined') {
      let es: EventSource | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const open = () => {
        if (closed) return;
        es = new EventSource(url());
        es.onmessage = (e) => deliver(e.data, e.lastEventId || undefined);
        es.onerror = () => {
          // Native EventSource retries by itself (sending Last-Event-ID); only
          // a hard close needs us — then resume from the last id we saw.
          if (es && es.readyState === 2 /* CLOSED */) {
            es = null;
            if (!closed) timer = setTimeout(open, 1000);
          }
        };
      };
      open();
      return () => { closed = true; if (timer) clearTimeout(timer); es?.close(); };
    }

    // Node: fetch + streaming parser, Bearer auth, Last-Event-ID resume.
    let controller: AbortController | null = null;
    let backoff = 500;
    const run = async () => {
      while (!closed) {
        controller = new AbortController();
        try {
          const res = await this.doFetch()(url(), {
            headers: { Accept: 'text/event-stream', ...this.authHeaders(), ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            const text = await res.text().catch(() => '');
            const err = new NotificationsError(res.status, `notifications: stream → ${res.status}: ${text}`);
            opts.onError?.(err);
            if (res.status === 401 || res.status === 403) return; // credentials won't fix themselves
          } else {
            backoff = 500;
            await parseSse(res.body, (data, id) => deliver(data, id));
          }
        } catch (err) {
          if (closed) return;
          opts.onError?.(err as Error);
        }
        if (closed) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    };
    void run();
    return () => { closed = true; controller?.abort(); };
  }

  /** The legacy shortcut: a Simple notification. Works in the browser too. */
  async simple(title: string, text = ''): Promise<CreateResult> {
    return this.create({ type: 'simple', title, text });
  }
}

/**
 * Minimal SSE parser over a byte stream: calls `onMessage(data, id?)` per
 * event (multi-line `data:` joined with \n); comments and other fields are
 * skipped. Exported for tests.
 */
export async function parseSse(body: ReadableStream<Uint8Array>, onMessage: (data: string, id?: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  let id: string | undefined;
  const flush = () => {
    if (data.length) onMessage(data.join('\n'), id);
    data = [];
    id = undefined;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { flush(); continue; }
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      let val = i === -1 ? '' : line.slice(i + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'data') data.push(val);
      else if (field === 'id') id = val;
    }
  }
  flush();
}
