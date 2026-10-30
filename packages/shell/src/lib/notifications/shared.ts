/**
 * The shell's ONE notification state, shared by every surface on the page
 * (Dock button, list, pop-ups, later others) via `window.__auraNotifications`.
 *
 * Browser-only wiring (fetch + the shared Socket.IO channel), but no DOM
 * rendering: surfaces render from `store` and act through `actions`.
 */
import { NotificationApiClient } from './api.ts';
import { getAppsSnapshot } from '../appsSnapshot.ts';
import { mark, onStage, resolveStage } from '../bootTimeline.ts';
import { NotificationClientStore, type StoreEvents } from './store.ts';
import { NotificationActions } from './actions.ts';
import type { AppInfo, AppLookup } from './format.ts';

export interface NotificationsRuntime {
  api: NotificationApiClient;
  store: NotificationClientStore;
  actions: NotificationActions;
  /** App name / glyph by id (from /api/apps; refreshed on app installs). */
  appLookup: AppLookup;
  /** Subscribe to app-list refreshes (e.g. to re-render sender labels). */
  onAppsChanged(fn: () => void): () => void;
  dispose(): void;
}

/** The tab's shell client session (ClientSession.astro, inline + import-free). */
export interface ClientSessionLike {
  readonly sid: string | null;
  readonly lock: 'locked' | 'unlocked';
  readonly desired?: 'locked' | 'unlocked';
  ready: Promise<void>;
  headers(): Record<string, string>;
  report(lock: 'locked' | 'unlocked'): Promise<boolean>;
  sync(): Promise<boolean>;
  onChange(fn: (s: { sid: string | null; lock: 'locked' | 'unlocked' }) => void): () => void;
}

declare global {
  interface Window {
    __auraNotifications?: NotificationsRuntime;
    __auraClientSession?: ClientSessionLike;
  }
}

/** Fired by the lock screen BEFORE it reports `lock`: drop every sensitive view now. */
export const WIPE_EVENT = 'aura:notifications:wipe';

interface OsEventsLike {
  subscribe(p: string | string[], h: (ev: { type: string; [k: string]: unknown }) => void): () => void;
  onReconnect?: (fn: () => void) => () => void;
}

async function createRuntime(): Promise<NotificationsRuntime> {
  const { osEvents } = await import('../osEvents.ts') as { osEvents: OsEventsLike };
  const session = window.__auraClientSession;
  const api = new NotificationApiClient({ headers: () => window.__auraClientSession?.headers() ?? {} });
  const events: StoreEvents = {
    subscribe: (p, h) => osEvents.subscribe(p, h),
    // Older singleton (before a hot reload) may lack the hook.
    ...(typeof osEvents.onReconnect === 'function'
      ? { onReconnect: (fn: () => void) => osEvents.onReconnect!(fn) } : {}),
  };
  const store = new NotificationClientStore({
    api, events,
    ...(session ? { session: { ready: () => session.ready, sync: () => session.sync() } } : {}),
  });
  const actions = new NotificationActions(api, store);

  // ── Phase 5: lock screen ──
  // The lock screen fires WIPE_EVENT before it reports `lock`: drop every
  // item at once (list DOM, toasts and dialogs follow from the store's
  // `removed` changes) and stop loading. Loading resumes only once the
  // SERVER acked the state this tab wants — locked → the redacted view,
  // unlocked → the full one — so nothing fetched in the old view lands.
  const onWipe = () => store.wipe();
  window.addEventListener(WIPE_EVENT, onWipe);
  let lastLock = session?.lock ?? null;
  let lastSid = session?.sid ?? null;
  const offSession = session?.onChange((s) => {
    if (s.lock !== (session.desired ?? s.lock)) return;   // an older ack — wait for the one we asked for
    if (s.lock === lastLock && s.sid === lastSid && !store.isSuspended) return;
    lastLock = s.lock;
    lastSid = s.sid;
    store.wipe();
    void store.resume();
  }) ?? (() => {});

  const apps = new Map<string, AppInfo>();
  const appListeners = new Set<() => void>();
  let lastLoad = 0;
  const loadApps = async () => {
    lastLoad = Date.now();
    try {
      const list = await getAppsSnapshot({ maxAgeMs: 30_000 });
      apps.clear();
      for (const a of list) {
        const m = a.manifest;
        if (!m?.id || !m.name) continue;
        apps.set(m.id, { name: m.name, glyph: (m.icon ?? m.name.charAt(0)).toUpperCase().slice(0, 3) });
      }
      for (const fn of [...appListeners]) { try { fn(); } catch { /* ignore */ } }
    } catch { /* offline — labels fall back to ids */ }
  };
  void loadApps();
  const offApps = osEvents.subscribe(['app:installed', 'app:removed'], () => { void loadApps(); });
  const appLookup: AppLookup = (id) => {
    const hit = apps.get(id);
    if (!hit && Date.now() - lastLoad > 30_000) void loadApps();
    return hit;
  };

  void store.start().finally(() => resolveStage('notif:ready'));
  return {
    api, store, actions, appLookup,
    onAppsChanged(fn) { appListeners.add(fn); return () => { appListeners.delete(fn); }; },
    dispose() { offApps(); offSession(); window.removeEventListener(WIPE_EVENT, onWipe); store.dispose(); appListeners.clear(); },
  };
}

let pending: Promise<NotificationsRuntime> | null = null;

/** The page-wide runtime (created on first use). */
export function getNotifications(): Promise<NotificationsRuntime> {
  if (typeof window === 'undefined') return Promise.reject(new Error('notifications runtime is browser-only'));
  const existing = window.__auraNotifications;
  if (existing && !existing.store.isDisposed) return Promise.resolve(existing);
  pending ??= bootGate().then(createRuntime).then((rt) => { window.__auraNotifications = rt; pending = null; return rt; });
  return pending;
}

/**
 * Notifications are the desktop's lowest boot priority: on the desktop page
 * (where the boot timeline runs) the runtime — its fetches and socket
 * subscriptions — starts once the active workspace has loaded (boot stage 1),
 * or after 5 s at the latest. Elsewhere (tests, other pages) at once.
 * Notifications that arrive meanwhile are in the first list fetch.
 */
function bootGate(): Promise<void> {
  if (!(window as unknown as { __auraBoot?: unknown }).__auraBoot) return Promise.resolve();
  return new Promise((resolve) => onStage('ws:active-loaded', () => { mark('notif:start'); resolve(); }, { timeoutMs: 5000 }));
}
