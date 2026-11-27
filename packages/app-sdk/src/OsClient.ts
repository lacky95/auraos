/**
 * Client used by apps to talk to the OS and other apps.
 *
 * Most cross-app data access goes through `queryProvider/writeProvider/watchProvider`,
 * which under the hood hit `/api/data/<authority>/<resource>` on the shell. From a
 * page they go through the App Host gateway (`/_aura/os/`), which signs the app's
 * verified identity onto every call; nothing the page sends can name another app.
 *
 * Theme-related methods read the runtime bootstrap (`AuraRuntimeBootstrap`, set by
 * `/_aura/runtime.js` before any app script runs) when available, and fall back to
 * a fetch otherwise. The full palette/theme can be obtained via
 * `getPalette()`/`getTheme()`; most apps should just consume `var(--aura-color-*)`
 * directly in CSS.
 */

import type {
  OsTheme,
  ColorMode,
  ResolvedMode,
  ThemeTone,
  ColorPalette,
  DesignFramework,
  ThemeSummary,
} from '@aura/core/theme';

export type {
  OsTheme,
  ColorMode,
  ResolvedMode,
  ThemeTone,
  ColorPalette,
  DesignFramework,
  ThemeSummary,
};

import type { ThemeSelection, ThemeStrategy } from './theme.js';
export type { ThemeSelection, ThemeStrategy } from './theme.js';

import { bodylessMutationHeaders, osAuthHeaders, osBase } from './os-auth.js';
import { isFromShell } from './channel.js';
import { KeymapApi } from './keymap.js';
import { NavApi } from './nav.js';
import { SystemApi } from './system.js';
import { SurfaceApi } from './surface.js';
import { ActivityApi } from './activity.js';
import { InterfacesApi } from './interfaces.js';
import { NotificationsApi, type CreateResult } from './notifications.js';
import { FlightApi } from './flight.js';
import { UserApi } from './user.js';
import { StorageApi } from './storage.js';
import { ContextApi } from './aura-context.js';
import { ApprovalsApi } from './approvals.js';
import { CredentialsApi } from './credentials.js';
import { SetupApi } from './setup.js';
import { PermissionsApi } from './permissions.js';
import { ThemeApi } from './theme.js';
import { DataApi } from './data.js';
import { IntentsApi, type StartIntent, type StartIntentResult } from './intents.js';
import { ownInstanceId } from './context.js';
import { osErrorFrom } from './errors.js';
export type { KeymapHandler, KeymapHandlerCtx, KeymapChangeInfo } from './keymap.js';
export type { BackEvent, BackHandler } from './nav.js';
export type { NavigateOptions } from './activity.js';
export type { InterfaceView, ConsumerView, InterfaceFilter, InterfaceSpec, InterfaceKind } from './interfaces.js';
export type {
  Notification, NotificationInput, NotificationPatch, NotificationEvent, NotificationWarning,
  NotificationComponent, NotificationContext, ListFilter as NotificationListFilter, WaitResult,
} from './notifications.js';

export class OsClient {
  private base: string;

  /**
   * Keyboard-action API. Apps declare actions in `app.manifest.json`'s
   * `keymapActions` and register handlers here. The combo currently bound
   * to each action is exposed via `keymap.getBinding('save')` so menu
   * shortcut labels render the user's mapping, not a hard-coded combo.
   */
  readonly keymap: KeymapApi;
  /** Android-style Back interception + `finish()`. */
  readonly nav:    NavApi;
  /** Programmatic OS actions (open launcher, switch workspace, …). */
  readonly system: SystemApi;
  /**
   * In-place activity navigation — `navigate()` replaces the current
   * iframe URL and records a back stack the OS pops on Escape. Use
   * instead of opening a new activity when the next "screen" should
   * occupy the SAME slot (Settings drill-downs, wizards).
   */
  readonly activity: ActivityApi;
  /**
   * Interface Registry — discover who provides what, publish what this app
   * provides. Returns addresses you then talk to directly; the OS is a
   * phone book, never the data path.
   */
  readonly interfaces: InterfacesApi;
  /**
   * Native surfaces — a host-rendered top-level document painted over part of
   * this window, for sites that refuse to run in an iframe. See ./surface.ts.
   */
  readonly surface: SurfaceApi;
  /**
   * Notifications — create / update / remove your own, read them, wait for a
   * dialogue answer, or subscribe to their lifecycle. Verified (instance
   * token) on the server, unverified in the browser. See ./notifications.ts.
   */
  readonly notifications: NotificationsApi;
  /**
   * Free-flight activities — small floating popups of your app above every
   * workspace that can perch on a screen edge as a tab. Needs
   * `system.overlay`. See ./flight.ts.
   */
  readonly flight: FlightApi;
  /**
   * The user this app acts for: `get()` and `onChange()` (D46). The owner's
   * `confirm()` asks for their yes in AuraOS's own dialog, with the password
   * for `level: 'fresh'` (D49); it needs `user.confirm`. See ./user.ts.
   */
  readonly user: UserApi;
  /**
   * This app's storage, per user (D46), with `.shared` for every user of the
   * app. Needs `storage.read` / `storage.write`. See ./storage.ts.
   */
  readonly storage: StorageApi;
  /**
   * The Aura Context values this app declared in `context[]`, on its server
   * (D48). See ./aura-context.ts.
   */
  readonly context: ContextApi;
  /** Ask the owner to approve an action; the answer carries a single-use grant (5.10). See ./approvals.ts. */
  readonly approvals: ApprovalsApi;
  /**
   * Ask the owner for a secret in AuraOS's dialog and get a handle; read the
   * value on the server with the owner's separate grant (D56). See ./credentials.ts.
   */
  readonly credentials: CredentialsApi;
  /** This app's own setup values, on its server (D108). See ./setup.ts. */
  readonly setup: SetupApi;
  /** What this app may do now, to hide what it may not. See ./permissions.ts. */
  readonly permissions: PermissionsApi;
  /** The OS theme: selection, inventory, palette, changes. See ./theme.ts. */
  readonly theme: ThemeApi;
  /** Other apps' content providers. See ./data.ts. */
  readonly data: DataApi;
  /** Start an intent. See ./intents.ts. */
  readonly intents: IntentsApi;

  constructor() {
    // Safe in both Node and the browser. In a browser this is the page's
    // origin, so it is right even on a non-localhost host.
    this.base = osBase({ mode: 'origin' });
    this.keymap   = new KeymapApi(this);
    this.nav      = new NavApi(this);
    this.system   = new SystemApi(this);
    this.surface  = new SurfaceApi(this);
    this.activity = new ActivityApi(this);
    this.interfaces = new InterfacesApi(this);
    this.notifications = new NotificationsApi();
    this.flight = new FlightApi(this);
    this.user = new UserApi(this);
    this.storage = new StorageApi();
    this.context = new ContextApi();
    this.approvals = new ApprovalsApi();
    this.credentials = new CredentialsApi();
    this.setup = new SetupApi();
    this.permissions = new PermissionsApi();
    const base = () => this.base;
    this.theme = new ThemeApi(base);
    this.data = new DataApi(base);
    this.intents = new IntentsApi(base);
  }

  // -------- OS event subscription (BroadcastReceiver-equivalent) --------

  /**
   * Subscribe to the OS event bus with a topic filter. Browser-only; no-op on
   * the server (returns a no-op unsubscribe). Topics use the glob syntax
   * documented in `@aura/core` (`app:*`, `theme:**`, etc.) — the server-side
   * filter drops non-matching events before they hit the wire.
   *
   * Mirrors Android's `registerReceiver(receiver, IntentFilter)`. Consumers
   * stop having to do client-side `if (data.type === 'app:stateChanged')`
   * branching and the SSE stream stays lean.
   *
   * Reconnects with simple linear backoff on transport drop.
   */
  subscribeOsEvents<T = Record<string, unknown>>(
    topics: readonly string[],
    handler: (ev: { type: string } & T) => void,
  ): () => void {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return () => undefined;
    }
    const qs = topics.length ? `?topics=${encodeURIComponent(topics.join(','))}` : '';
    const url = `${this.base}/api/apps/events${qs}`;

    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (cancelled) return;
      es = new EventSource(url);
      es.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data) as { type?: unknown };
          if (typeof parsed.type === 'string') {
            handler(parsed as { type: string } & T);
          }
        } catch { /* malformed frame — ignore */ }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        // Browsers do their own reconnect by default; we still guard against
        // the rare hard-close case (close called on us, etc.).
        reconnectTimer = setTimeout(open, 1000);
      };
    };
    open();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }

  // -------- Notifications + lifecycle --------

  /**
   * Shortcut for a Simple notification: `notifications.create({type:'simple',
   * title, text: body})`. Server-side the instance token (`AURA_INSTANCE_TOKEN`)
   * is sent as a Bearer, so the shell attributes it to this app as *verified*
   * (needs `system.notifications` in the manifest). In the browser no token is
   * sent (unverified) — it works there too now.
   *
   * @deprecated Use `notifications.create({ type: 'simple', title, text })`.
   */
  async sendNotification(title: string, body = ''): Promise<CreateResult> {
    return this.notifications.create({ type: 'simple', title, text: body });
  }

  /** Returns this instance's lifecycle state via the OS status endpoint. */
  async getState(): Promise<string> {
    const instanceId = ownInstanceId() ?? 'unknown';
    const url = `${this.base}/api/instances/${encodeURIComponent(instanceId)}/status`;
    const res = await fetch(url, { headers: osAuthHeaders(url) });
    if (!res.ok) throw await osErrorFrom(res, 'getState');
    const data = await res.json() as { instance: { state: string } };
    return data.instance.state;
  }

  // -------- Intent dispatch (Android `startActivity(intent)` equivalent) --------

  /**
   * Resolve + start an intent.
   *
   * @deprecated Use `intents.start(intent)` (./intents.ts), the same call.
   */
  startIntent(intent: StartIntent): Promise<StartIntentResult> {
    return this.intents.start(intent);
  }

  // -------- BackStack (Android-`Activity.finish()`-equivalent) --------

  /**
   * Close the calling activity and, if it was launched on top of another
   * activity in the same instance, refocus the parent. Mirrors Android's
   * `Activity.finish()` — apps can use this from a "← Back" button in
   * a sub-screen instead of hand-rolling close + open-parent calls.
   *
   * The activity id comes from `activity.getActivityId()`. No-op if no
   * activity id is available.
   */
  async finish(): Promise<void> {
    const activityId = this.activity.getActivityId();
    if (!activityId) return;
    const url = `${this.base}/api/activities/${encodeURIComponent(activityId)}/back`;
    await fetch(url, {
      method: 'POST',
      headers: { ...bodylessMutationHeaders(), ...osAuthHeaders(url) },
    });
  }

  // -------- Deprecated flat aliases (kept so existing apps keep working) --------

  /** @deprecated Use `data.query(authority, resource)`. */
  queryProvider<T = unknown>(authority: string, resource: string): Promise<T> {
    return this.data.query<T>(authority, resource);
  }

  /** @deprecated Use `data.write(authority, resource, body, method)`. */
  writeProvider<T = unknown>(
    authority: string, resource: string, body: unknown, method: 'PUT' | 'POST' | 'PATCH' | 'DELETE' = 'PUT',
  ): Promise<T> {
    return this.data.write<T>(authority, resource, body, method);
  }

  /** @deprecated Use `data.watch(authority, resource)`. */
  watchProvider(authority: string, resource: string): EventSource {
    return this.data.watch(authority, resource);
  }

  /** @deprecated Use `theme.getSelection()`. */
  getThemeSelection(): Promise<ThemeSelection> { return this.theme.getSelection(); }
  /** @deprecated Use `theme.list()`. */
  listThemes(): Promise<ThemeSummary[]> { return this.theme.list(); }
  /** @deprecated Use `theme.setForTone(tone, themeId)`. */
  setOsThemeForTone(tone: ThemeTone, themeId: string): Promise<void> { return this.theme.setForTone(tone, themeId); }
  /** @deprecated Use `theme.getActiveId()`. */
  getActiveThemeId(): string | null { return this.theme.getActiveId(); }
  /** @deprecated Use `theme.getModePreference()`. */
  getModePreference(): Promise<ColorMode> { return this.theme.getModePreference(); }
  /** @deprecated Use `theme.getMode()`. */
  getMode(): Promise<ResolvedMode> { return this.theme.getMode(); }
  /** @deprecated Use `theme.setMode(mode)`. */
  setMode(mode: ColorMode): Promise<void> { return this.theme.setMode(mode); }
  /** @deprecated Use `theme.getPalette()`. */
  getPalette(): ColorPalette { return this.theme.getPalette(); }
  /** @deprecated Use `theme.getDesignFramework()`. */
  getDesignFramework(): Promise<DesignFramework> { return this.theme.getDesignFramework(); }
  /** @deprecated Use `theme.get()`. */
  getTheme(): Promise<OsTheme> { return this.theme.get(); }
  /** @deprecated Use `theme.getStrategy()`. */
  getThemeStrategy(): ThemeStrategy { return this.theme.getStrategy(); }
  /** @deprecated Use `theme.onChange(cb)`. */
  onThemeChange(cb: Parameters<ThemeApi['onChange']>[0]): () => void { return this.theme.onChange(cb); }
  /** @deprecated Use `theme.onModeChange(cb)`. */
  onModeChange(cb: Parameters<ThemeApi['onModeChange']>[0]): () => void { return this.theme.onModeChange(cb); }

  // -------- Viewport --------

  /**
   * Subscribe to viewport changes — fires whenever the shell resizes this
   * app's tile (tiling reflow / window open-close) or changes the viewport
   * scale (zoom / margins). These are signals a child cannot detect on its
   * own: a CSS `transform: scale()` is paint-only (no ResizeObserver fires)
   * and grid reflow can race the iframe's layout-settle. Apps that measure
   * their own size (e.g. a terminal fitting xterm to its container) should
   * re-measure here. Browser-only — no-op on the server. Returns an
   * unsubscribe function.
   *
   * `reason` distinguishes 'layout' (tile resized), 'zoom' (scale changed)
   * and 'mount' (sent once on iframe load with the current scale).
   *
   * `contentW`/`contentH` are this iframe's authoritative LOGICAL content box
   * in CSS px, measured by the shell (transform-independent). An app should
   * size off these instead of re-measuring its own (still-settling) DOM. The
   * callback is never invoked with a 0-sized box (iframe hidden / off the
   * active workspace) — those are swallowed here, so `contentW`/`contentH` are
   * always usable. For grid-based apps, pair with the exported `viewportGrid()`
   * helper.
   */
  onViewportChange(cb: (info: ViewportChangeInfo) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const handler = (ev: MessageEvent) => {
      if (!isFromShell(ev)) return;
      const d = ev.data as {
        type?: string; reason?: string; shellZoom?: number; iframeScale?: number;
        contentW?: number; contentH?: number;
      } | null;
      if (!d || d.type !== 'aura.viewport.changed') return;
      // A 0-sized box means the iframe is display:none (off the active
      // workspace). Swallow it centrally so no app ever refits to a degenerate
      // box — the next non-zero box (slot revealed) delivers the real size.
      if (d.contentW === 0 || d.contentH === 0) return;
      cb({
        reason:      d.reason === 'zoom' || d.reason === 'mount' ? d.reason : 'layout',
        shellZoom:   typeof d.shellZoom   === 'number' ? d.shellZoom   : 1,
        iframeScale: typeof d.iframeScale === 'number' ? d.iframeScale : 1,
        contentW:    typeof d.contentW    === 'number' ? d.contentW    : 0,
        contentH:    typeof d.contentH    === 'number' ? d.contentH    : 0,
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }
}

/**
 * Payload delivered to {@link OsClient.onViewportChange} subscribers. `reason`
 * says why ('layout' tile resize / 'zoom' scale change / 'mount' first paint);
 * `shellZoom`/`iframeScale` are the live scale factors; `contentW`/`contentH`
 * are this iframe's authoritative logical content box in CSS px (0 = hidden).
 */
export interface ViewportChangeInfo {
  reason:      'layout' | 'zoom' | 'mount';
  shellZoom:   number;
  iframeScale: number;
  contentW:    number;
  contentH:    number;
}

/**
 * Compute a character/cell grid that fits a content box. Pure arithmetic — the
 * shell hands an app its authoritative box via {@link OsClient.onViewportChange}
 * and the app divides by its (font-dependent, size-independent) cell metrics.
 * This replaces measure-and-settle DOM races with one floor division.
 *
 * @param boxW   available width in logical px (e.g. `contentW` minus chrome)
 * @param boxH   available height in logical px
 * @param cell   measured cell size `{ w, h }` in logical px
 * @param chrome optional fixed insets `{ x, y }` to subtract before dividing
 *               (toolbars, padding, scrollbars). Defaults to 0.
 * @returns `{ cols, rows }`, each clamped to a minimum of 1.
 */
export function viewportGrid(
  boxW: number,
  boxH: number,
  cell: { w: number; h: number },
  chrome?: { x?: number; y?: number },
): { cols: number; rows: number } {
  const x = chrome?.x ?? 0;
  const y = chrome?.y ?? 0;
  const cols = Math.max(1, Math.floor((boxW - x) / cell.w));
  const rows = Math.max(1, Math.floor((boxH - y) / cell.h));
  return { cols, rows };
}

