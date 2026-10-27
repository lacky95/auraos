/**
 * NotificationClientStore — the shell's client-side view of the ACTIVE
 * notifications. DOM-free: it takes an API (`get` / `list`) and an event
 * source (`subscribe` / `onReconnect`), so the DOM list, the pop-ups and any
 * later surface (React, voice, AR) share one state.
 *
 * Live updates: the content-free `notification:*` bus events
 * (`{eventId, id, state}`) arrive on the shared Socket.IO channel. Events
 * are de-duplicated by `eventId` and coalesced per id: each id is fetched
 * once (`GET /api/notifications/<id>`) per burst, and again only if a newer
 * event arrived while that fetch was in flight. `removed` / `resolved`
 * drop the item without a fetch.
 *
 * Catch-up: a full `list({state:'active'})` on `start()` and after every
 * reconnect of the event channel (`onReconnect`). Items that are missing
 * from that list are dropped, unless a live event touched them while the
 * list was loading.
 *
 * Sorted view: pinned first, then priority urgent > high > medium > low,
 * then newest first.
 *
 * Phase 5 (lock screen): `wipe()` drops every item AT ONCE (the DOM, toasts
 * and dialogs follow from the `removed` changes) and suspends loading, so
 * nothing fetched in the old view can land afterwards; `resume()` reloads
 * in whatever view the server now gives this client session. The first
 * load waits for the session (`session.ready()`), and a reconnect re-syncs
 * the lock state (`session.sync()`) BEFORE it reloads.
 */
import type { Notification } from './api.ts';

export interface StoreApi {
  get(id: string): Promise<Notification | null>;
  listAll(params: { state: 'active' }): Promise<Notification[]>;
}

export interface BusEvent {
  type: string;
  eventId?: unknown;
  id?: unknown;
  state?: unknown;
  [k: string]: unknown;
}

/** The tab's shell client session (phase 5) — see ClientSession.astro. */
export interface StoreSession {
  /** Resolves once the session is registered (or registration failed). */
  ready(): Promise<unknown>;
  /** Re-sync the lock state with the server (heartbeat / re-register). */
  sync(): Promise<boolean>;
}

export interface StoreEvents {
  subscribe(pattern: string | string[], handler: (ev: BusEvent) => void): () => void;
  /** Called after the channel reconnected (not on the first connect). */
  onReconnect?(fn: () => void): () => void;
}

/** Where a change came from — pop-ups only show `live` additions. */
export type ChangeSource = 'initial' | 'live' | 'refetch' | 'local';

export type StoreChange =
  | { kind: 'added'; id: string; source: ChangeSource }
  | { kind: 'updated'; id: string; source: ChangeSource }
  | { kind: 'removed'; id: string; source: ChangeSource; reason: 'removed' | 'resolved' | 'gone' };

export interface StoreError {
  status: number;
  message: string;
}

export interface StoreSnapshot {
  /** Sorted active notifications. */
  items: readonly Notification[];
  unseenCount: number;
  /** All active notifications (locked included). */
  totalCount: number;
  /** Highest priority among unseen items, or null when nothing is new. */
  highestUnseenPriority: Notification['priority'] | null;
  /** The newest unseen item (by createdAt), or null. */
  newestUnseen: Notification | null;
  /** The most important active item (see `compareImportance`), or null. */
  mostImportant: Notification | null;
  /** True after the first successful load. */
  ready: boolean;
  /** Last load error (e.g. 401/403 once the shell UI needs auth), else null. */
  error: StoreError | null;
}

export type StoreListener = (snap: StoreSnapshot, changes: readonly StoreChange[]) => void;

export interface StoreOptions {
  api: StoreApi;
  events?: StoreEvents;
  /** Phase 5: load only after the client session exists; re-sync before a reconnect reload. */
  session?: StoreSession;
  /** Schedules the coalesced flush. Default: a 0 ms timer. */
  schedule?: (fn: () => void) => void;
  /** Max remembered event ids for de-duplication. */
  dedupeWindow?: number;
  /** Error log hook (default: console.warn). */
  warn?: (msg: string, err?: unknown) => void;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, medium: 1, low: 0 };

/** Pinned first, then priority (urgent > high > medium > low), then newest. */
export function compareNotifications(a: Notification, b: Notification): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const pa = PRIORITY_RANK[a.priority] ?? 1;
  const pb = PRIORITY_RANK[b.priority] ?? 1;
  if (pa !== pb) return pb - pa;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * "Most important" order (the Dock bell's wide snippet): unseen before seen,
 * then pinned, then priority urgent > high > medium > low, then newest.
 */
export function compareImportance(a: Notification, b: Notification): number {
  const ua = isUnseen(a), ub = isUnseen(b);
  if (ua !== ub) return ua ? -1 : 1;
  return compareNotifications(a, b);
}

export function isUnseen(n: Notification): boolean {
  return n.state === 'active' && n.seenAt === undefined;
}

export class NotificationClientStore {
  private readonly api: StoreApi;
  private readonly events: StoreEvents | undefined;
  private readonly session: StoreSession | undefined;
  /** Bumped by `wipe()`: anything loaded under an older epoch is discarded. */
  private epoch = 0;
  private suspended = false;
  private readonly schedule: (fn: () => void) => void;
  private readonly dedupeWindow: number;
  private readonly warn: (msg: string, err?: unknown) => void;

  private readonly items = new Map<string, Notification>();
  private sortedCache: Notification[] | null = null;
  private readonly listeners = new Set<StoreListener>();
  private readonly disposers: Array<() => void> = [];

  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  /** id → pending flag (an event arrived that is not fetched yet). */
  private readonly pending = new Map<string, true>();
  private readonly inFlight = new Set<string>();
  private flushScheduled = false;
  /** Ids touched by live events while a refetch was loading. */
  private touchedDuringRefetch: Set<string> | null = null;
  private refetching: Promise<void> | null = null;
  private refetchAgain = false;

  private changes: StoreChange[] = [];
  private emitScheduled = false;
  private ready = false;
  private error: StoreError | null = null;
  private started = false;
  private disposed = false;

  constructor(opts: StoreOptions) {
    this.api = opts.api;
    this.events = opts.events;
    this.session = opts.session;
    this.schedule = opts.schedule ?? ((fn) => { setTimeout(fn, 0); });
    this.dedupeWindow = opts.dedupeWindow ?? 500;
    this.warn = opts.warn ?? ((msg, err) => console.warn(`[notifications] ${msg}`, err ?? ''));
  }

  /** Subscribe to the bus and load the active list. Idempotent. */
  start(): Promise<void> {
    if (this.started || this.disposed) return this.refetching ?? Promise.resolve();
    this.started = true;
    if (this.events) {
      this.disposers.push(this.events.subscribe('notification:*', (ev) => this.handleEvent(ev)));
      if (this.events.onReconnect) {
        // Phase 5: sync the lock state FIRST, then reload (a failed sync means
        // the server treats us as locked — the reload then gets the locked view).
        this.disposers.push(this.events.onReconnect(() => {
          void (async () => {
            try { await this.session?.sync(); } catch { /* stays locked server-side */ }
            await this.refetch();
          })();
        }));
      }
    }
    if (!this.session) return this.refetch('initial');
    return (async () => {
      try { await this.session!.ready(); } catch { /* load anyway: the server answers per session */ }
      await this.refetch('initial');
    })();
  }

  /**
   * Phase 5: drop every item NOW (lock / unlock / session change) and stop
   * loading until `resume()`. Listeners get a `removed` change per item.
   */
  wipe(): void {
    if (this.disposed) return;
    this.epoch++;
    this.suspended = true;
    this.pending.clear();
    for (const id of [...this.items.keys()]) {
      this.items.delete(id);
      this.changes.push({ kind: 'removed', id, source: 'local', reason: 'gone' });
    }
    this.sortedCache = null;
    this.emitSoon(true);
  }

  /** Phase 5: load again (in the view the server now gives this session). */
  resume(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.suspended = false;
    return this.refetch();
  }

  get isSuspended(): boolean { return this.suspended; }

  // ---- reads -------------------------------------------------------------

  get(id: string): Notification | undefined {
    return this.items.get(id);
  }

  /** Sorted active notifications (cached until the next change). */
  get sorted(): readonly Notification[] {
    if (!this.sortedCache) this.sortedCache = [...this.items.values()].sort(compareNotifications);
    return this.sortedCache;
  }

  get unseenCount(): number {
    let n = 0;
    for (const it of this.items.values()) if (isUnseen(it)) n++;
    return n;
  }

  get totalCount(): number {
    return this.items.size;
  }

  get highestUnseenPriority(): Notification['priority'] | null {
    let best: Notification['priority'] | null = null;
    for (const it of this.items.values()) {
      if (!isUnseen(it)) continue;
      if (best === null || (PRIORITY_RANK[it.priority] ?? 1) > (PRIORITY_RANK[best] ?? 1)) best = it.priority;
    }
    return best;
  }

  get newestUnseen(): Notification | null {
    let best: Notification | null = null;
    for (const it of this.items.values()) {
      if (isUnseen(it) && (!best || it.createdAt > best.createdAt)) best = it;
    }
    return best;
  }

  /** The most important active item: unseen, then pinned, then priority, then newest. */
  get mostImportant(): Notification | null {
    let best: Notification | null = null;
    for (const it of this.items.values()) if (!best || compareImportance(it, best) < 0) best = it;
    return best;
  }

  snapshot(): StoreSnapshot {
    return {
      items: this.sorted,
      unseenCount: this.unseenCount,
      totalCount: this.totalCount,
      highestUnseenPriority: this.highestUnseenPriority,
      newestUnseen: this.newestUnseen,
      mostImportant: this.mostImportant,
      ready: this.ready,
      error: this.error,
    };
  }

  /** Listener gets the snapshot right away (no changes), then on every change batch. */
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    try { listener(this.snapshot(), []); } catch (err) { this.warn('listener threw', err); }
    return () => { this.listeners.delete(listener); };
  }

  // ---- writes --------------------------------------------------------------

  /** Apply a server response (e.g. from markSeen / interact) right away. */
  apply(n: Notification | null | undefined, source: ChangeSource = 'local'): void {
    if (!n || this.disposed) return;
    this.upsert(n, source);
    this.emitSoon();
  }

  /** Drop an item locally (e.g. after a successful dismiss). */
  drop(id: string, reason: 'removed' | 'resolved' | 'gone' = 'removed'): void {
    if (this.disposed) return;
    if (this.items.delete(id)) {
      this.sortedCache = null;
      this.changes.push({ kind: 'removed', id, source: 'local', reason });
      this.emitSoon();
    }
  }

  /** Full reload of the active list. Concurrent calls are merged into one more pass. */
  refetch(source: ChangeSource = 'refetch'): Promise<void> {
    if (this.disposed || this.suspended) return Promise.resolve();
    if (this.refetching) { this.refetchAgain = true; return this.refetching; }
    this.refetching = (async () => {
      do {
        this.refetchAgain = false;
        this.touchedDuringRefetch = new Set();
        const epoch = this.epoch;
        try {
          const list = await this.api.listAll({ state: 'active' });
          if (this.disposed) return;
          if (epoch !== this.epoch || this.suspended) continue;   // wiped meanwhile: discard
          const touched = this.touchedDuringRefetch;
          const ids = new Set(list.map((n) => n.id));
          for (const id of [...this.items.keys()]) {
            if (!ids.has(id) && !touched.has(id)) {
              this.items.delete(id);
              this.sortedCache = null;
              this.changes.push({ kind: 'removed', id, source, reason: 'gone' });
            }
          }
          for (const n of list) {
            // A live fetch that finished during the load is at least as new.
            if (touched.has(n.id) && !this.items.has(n.id)) continue;
            this.upsert(n, source);
          }
          this.ready = true;
          this.error = null;
        } catch (err) {
          const e = err as { status?: unknown; message?: unknown };
          this.error = { status: typeof e?.status === 'number' ? e.status : 0, message: String(e?.message ?? err) };
          this.warn('loading the notification list failed', err);
        } finally {
          this.touchedDuringRefetch = null;
          this.emitSoon(true);
        }
      } while (this.refetchAgain && !this.disposed);
    })().finally(() => { this.refetching = null; });
    return this.refetching;
  }

  /** Handle one `notification:*` bus event (public for tests and other channels). */
  handleEvent(ev: BusEvent): void {
    if (this.disposed || !ev || typeof ev.type !== 'string' || !ev.type.startsWith('notification:')) return;
    // Suspended (lock transition): `resume()` reloads everything anyway.
    if (this.suspended) return;
    const id = typeof ev.id === 'string' ? ev.id : '';
    if (!id) return;   // the legacy content-carrying `notification` event has no id
    const eventId = typeof ev.eventId === 'string' ? ev.eventId : '';
    if (eventId) {
      if (this.seenEventIds.has(eventId)) return;
      this.seenEventIds.add(eventId);
      this.seenEventOrder.push(eventId);
      while (this.seenEventOrder.length > this.dedupeWindow) {
        const old = this.seenEventOrder.shift();
        if (old) this.seenEventIds.delete(old);
      }
    }
    this.touchedDuringRefetch?.add(id);
    const state = typeof ev.state === 'string' ? ev.state : '';
    if (state === 'removed' || state === 'resolved') {
      this.pending.delete(id);
      if (this.items.delete(id)) {
        this.sortedCache = null;
        this.changes.push({ kind: 'removed', id, source: 'live', reason: state });
        this.emitSoon();
      }
      return;
    }
    this.pending.set(id, true);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => { this.flushScheduled = false; this.flush(); });
  }

  private flush(): void {
    if (this.disposed) return;
    for (const id of [...this.pending.keys()]) {
      if (this.inFlight.has(id)) continue;   // refetched after the running fetch
      this.pending.delete(id);
      void this.fetchOne(id);
    }
  }

  private async fetchOne(id: string): Promise<void> {
    this.inFlight.add(id);
    const epoch = this.epoch;
    try {
      const n = await this.api.get(id);
      if (this.disposed || epoch !== this.epoch || this.suspended) return;
      this.touchedDuringRefetch?.add(id);
      if (!n || n.state !== 'active') {
        if (this.items.delete(id)) {
          this.sortedCache = null;
          this.changes.push({ kind: 'removed', id, source: 'live', reason: n?.state === 'resolved' ? 'resolved' : n ? 'removed' : 'gone' });
        }
      } else {
        this.upsert(n, 'live');
      }
      this.emitSoon();
    } catch (err) {
      this.warn(`fetching ${id} failed`, err);
    } finally {
      this.inFlight.delete(id);
      if (this.pending.has(id)) this.scheduleFlush();
    }
  }

  private upsert(n: Notification, source: ChangeSource): void {
    if (n.state !== 'active') {
      if (this.items.delete(n.id)) {
        this.sortedCache = null;
        this.changes.push({ kind: 'removed', id: n.id, source, reason: n.state === 'resolved' ? 'resolved' : 'removed' });
      }
      return;
    }
    const prev = this.items.get(n.id);
    // Never go back in time (an older response racing a newer one).
    if (prev && revisionOf(n) < revisionOf(prev)) return;
    if (prev && sameRevision(prev, n)) return;
    this.items.set(n.id, n);
    this.sortedCache = null;
    this.changes.push({ kind: prev ? 'updated' : 'added', id: n.id, source });
  }

  private emitSoon(force = false): void {
    if (this.emitScheduled) return;
    if (!force && this.changes.length === 0) return;
    this.emitScheduled = true;
    this.schedule(() => {
      this.emitScheduled = false;
      if (this.disposed) return;
      const changes = this.changes;
      this.changes = [];
      const snap = this.snapshot();
      for (const l of [...this.listeners]) {
        try { l(snap, changes); } catch (err) { this.warn('listener threw', err); }
      }
    });
  }

  /** Unsubscribe from the bus and drop every listener. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposers.splice(0)) { try { d(); } catch { /* ignore */ } }
    this.listeners.clear();
    this.items.clear();
    this.pending.clear();
  }

  get isDisposed(): boolean { return this.disposed; }
}

/**
 * The newest timestamp an item carries. `seen` / `displayed` / `interacted`
 * do not bump `updatedAt`, so ordering by `updatedAt` alone could let a
 * stale copy undo a seen mark.
 */
export function revisionOf(n: Notification): number {
  return Math.max(
    n.updatedAt ?? 0, n.seenAt ?? 0, n.displayedAt ?? 0, n.lastInteraction?.at ?? 0,
    n.history?.length ? n.history[n.history.length - 1]!.at : 0,
  );
}

/** Cheap equality for "nothing changed": same update time and same lifecycle marks. */
function sameRevision(a: Notification, b: Notification): boolean {
  return a.updatedAt === b.updatedAt
    && a.seenAt === b.seenAt
    && a.displayedAt === b.displayedAt
    && a.history.length === b.history.length
    && (a.lastInteraction?.at ?? 0) === (b.lastInteraction?.at ?? 0);
}
