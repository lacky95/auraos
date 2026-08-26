/**
 * Client used by apps to talk to the OS and other apps.
 *
 * Most cross-app data access goes through `queryProvider/writeProvider/watchProvider`,
 * which under the hood hit `/api/data/<authority>/<resource>` on the shell. The shell
 * proxy reads `Referer` for source-app identification, so calls made from an app's
 * iframe automatically carry their identity.
 *
 * Theme-related methods read from the proxy-injected `<meta>` tags when
 * available (synchronous, set by the shell proxy's HTML rewriter) and fall
 * back to a content-provider fetch otherwise. The full palette/theme can be
 * obtained via `getPalette()`/`getTheme()`; most apps should just consume
 * `var(--aura-color-*)` directly in CSS.
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

/** Full theme selection persisted in Settings. */
export interface ThemeSelection {
  themeIdDark:  string;
  themeIdLight: string;
  colorMode:    ColorMode;
}

/** How an app participates in OS theming. Read from `<meta name="aura-theme-strategy">`. */
export type ThemeStrategy = 'inherit' | 'themed' | 'override';

import { KeymapApi } from './keymap.js';
import { NavApi } from './nav.js';
import { SystemApi } from './system.js';
import { ActivityApi } from './activity.js';
import { InterfacesApi } from './interfaces.js';
export type { KeymapHandler, KeymapHandlerCtx, KeymapChangeInfo } from './keymap.js';
export type { BackEvent, BackHandler } from './nav.js';
export type { NavigateOptions } from './activity.js';
export type { InterfaceView, ConsumerView, InterfaceFilter, InterfaceSpec, InterfaceKind } from './interfaces.js';

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

  constructor() {
    // Bare `process.env.X` throws `ReferenceError: process is not defined`
    // in the browser, which would prevent every browser-side `new OsClient()`
    // from working — the SDK is consumed both server-side (lifecycle
    // endpoints, Astro frontmatter) and client-side (page <script> blocks,
    // React islands), so the constructor has to be safe in both.
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    // In-browser default is same-origin (so the URL is correct even when
    // the app's iframe was launched on a non-localhost host). The
    // OS_API_BASE env var is only honoured server-side.
    const browserDefault = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    this.base = env['OS_API_BASE'] ?? browserDefault;
    this.keymap   = new KeymapApi(this);
    this.nav      = new NavApi(this);
    this.system   = new SystemApi(this);
    this.activity = new ActivityApi(this);
    this.interfaces = new InterfacesApi(this);
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

  async sendNotification(title: string, body = ''): Promise<void> {
    const appId = process.env['APP_ID'] ?? 'unknown';
    await fetch(`${this.base}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, title, body }),
    });
  }

  /** Returns this instance's lifecycle state via the OS status endpoint. */
  async getState(): Promise<string> {
    const instanceId = process.env['APP_INSTANCE_ID'] ?? process.env['APP_ID'] ?? 'unknown';
    const res = await fetch(`${this.base}/api/instances/${encodeURIComponent(instanceId)}/status`);
    const data = await res.json() as { instance: { state: string } };
    return data.instance.state;
  }

  // -------- Intent dispatch (Android `startActivity(intent)` equivalent) --------

  /**
   * Resolve + start an intent. The OS picks the highest-scored handler from
   * declared `intentFilters` across all installed apps. Returns the OS's
   * verdict — a single chosen handler, a disambiguation list, or `noHandler`.
   * Apps use this instead of hand-coding `start()` + `openActivity()` so the
   * routing logic stays in one place.
   *
   * Throws on transport errors or non-JSON responses; HTTP 404 (no handler)
   * is returned as `{ kind: 'noHandler' }` so the caller doesn't have to
   * catch for the common case.
   */
  async startIntent(intent: {
    action:    string;
    category?: string[];
    type?:     string;
    uri?:      string;
    extras?:   Record<string, unknown>;
  }): Promise<
    | { kind: 'started'; appId: string; instanceId: string; activityId?: string }
    | { kind: 'disambiguation'; candidates: Array<{ appId: string; score: number }> }
    | { kind: 'noHandler' }
  > {
    const res = await fetch(`${this.base}/api/intents/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    });
    if (res.status === 404) return { kind: 'noHandler' };
    if (!res.ok) throw new Error(`startIntent: HTTP ${res.status}`);
    return (await res.json()) as Awaited<ReturnType<OsClient['startIntent']>>;
  }

  // -------- BackStack (Android-`Activity.finish()`-equivalent) --------

  /**
   * Close the calling activity and, if it was launched on top of another
   * activity in the same instance, refocus the parent. Mirrors Android's
   * `Activity.finish()` — apps can use this from a "← Back" button in
   * a sub-screen instead of hand-rolling close + open-parent calls.
   *
   * Reads the current activity id from `APP_ACTIVITY_ID` (Node) or the
   * proxy-injected `<meta name="aura-activity-id">` tag (browser). No-op
   * if no activity id is available.
   */
  async finish(): Promise<void> {
    let activityId: string | null = null;
    if (typeof process !== 'undefined' && process.env) {
      activityId = process.env['APP_ACTIVITY_ID'] ?? null;
    }
    if (!activityId && typeof document !== 'undefined') {
      activityId = document.querySelector('meta[name="aura-activity-id"]')?.getAttribute('content') ?? null;
    }
    if (!activityId) return;
    await fetch(`${this.base}/api/activities/${encodeURIComponent(activityId)}/back`, {
      method: 'POST',
    });
  }

  // -------- Content-Provider Access --------

  /**
   * Read from another app's content provider.
   *
   * `resource` is the path SEGMENT after `/api/data/<authority>/` — e.g. for
   * Settings's theme endpoint declared as `/api/data/theme` in its manifest,
   * pass `"theme"` here. Don't include the `/api/data/` prefix.
   */
  async queryProvider<T = unknown>(authority: string, resource: string): Promise<T> {
    const r = resource.replace(/^\/+/, '');
    const url = `${this.base}/api/data/${encodeURIComponent(authority)}/${r}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`queryProvider ${authority}/${r} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Write to another app's content provider. Method defaults to PUT; pass POST/PATCH/DELETE
   * to override. Body is JSON-encoded. `resource` is the short segment (see queryProvider).
   */
  async writeProvider<T = unknown>(
    authority: string,
    resource: string,
    body: unknown,
    method: 'PUT' | 'POST' | 'PATCH' | 'DELETE' = 'PUT',
  ): Promise<T> {
    const r = resource.replace(/^\/+/, '');
    const url = `${this.base}/api/data/${encodeURIComponent(authority)}/${r}`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`writeProvider ${authority}/${r} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Open an SSE stream against a provider with `?watch=1` appended. The provider must
   * implement its own watch handler; the proxy just streams the response.
   */
  watchProvider(authority: string, resource: string): EventSource {
    const r = resource.replace(/^\/+/, '');
    const sep = r.includes('?') ? '&' : '?';
    const url = `${this.base}/api/data/${encodeURIComponent(authority)}/${r}${sep}watch=1`;
    return new EventSource(url);
  }

  // -------- Theme (v3) — selection + inventory --------

  /**
   * Current selection from the OS KV: both slot ids plus colorMode. The
   * value lives at `/api/kv/os/theme` (shell-served); writes require the
   * `system.kv.os.theme.write` permission, reads are public.
   */
  async getThemeSelection(): Promise<ThemeSelection> {
    const res = await fetch(`${this.base}/api/kv/os/theme`);
    if (!res.ok) throw new Error(`getThemeSelection → HTTP ${res.status}`);
    const body = await res.json() as { value: ThemeSelection };
    return body.value;
  }

  /** Lightweight inventory of every theme the OS ships (no palettes). */
  async listThemes(): Promise<ThemeSummary[]> {
    const res = await fetch(`${this.base}/api/os/themes`);
    if (!res.ok) throw new Error(`listThemes → HTTP ${res.status}`);
    const body = await res.json() as { themes: ThemeSummary[] };
    return body.themes;
  }

  /**
   * Persist a theme pick for a specific tone slot. Slots are independent:
   * setting the dark slot doesn't disturb the light slot, and vice versa.
   * `colorMode` decides which slot is currently rendered.
   *
   * Read-modify-write against `/api/kv/os/theme` because KV PUT replaces
   * the entire value at a key.
   */
  async setOsThemeForTone(tone: ThemeTone, themeId: string): Promise<void> {
    const previous = await this.getThemeSelection().catch(() => null);
    const next = { ...(previous ?? {}), [tone === 'dark' ? 'themeIdDark' : 'themeIdLight']: themeId };
    await this.kvPut('os', 'theme', next);
  }

  private async kvPut(namespace: string, key: string, value: unknown): Promise<void> {
    const segs = `${namespace}/${key}`.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${this.base}/api/kv/${segs}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(`kv PUT ${namespace}/${key} → HTTP ${res.status}: ${await res.text()}`);
  }

  /** Reads `<meta name="aura-theme-id">` set by the proxy (synchronous). */
  getActiveThemeId(): string | null {
    if (typeof document === 'undefined') return null;
    return document.querySelector('meta[name="aura-theme-id"]')?.getAttribute('content') ?? null;
  }

  // -------- Theme (v2) — mode (light / dark / auto) --------

  /** User pref including `'auto'`. */
  async getModePreference(): Promise<ColorMode> {
    const { colorMode } = await this.getThemeSelection();
    return colorMode;
  }

  /** Resolved mode — turns `'auto'` into `'light'` or `'dark'` via the browser media query. */
  async getMode(): Promise<ResolvedMode> {
    const pref = await this.getModePreference();
    return resolveMode(pref);
  }

  /** Persist a colorMode preference. Broadcasts on the OS bus. */
  async setMode(mode: ColorMode): Promise<void> {
    const previous = await this.getThemeSelection().catch(() => null);
    const next = { ...(previous ?? {}), colorMode: mode };
    await this.kvPut('os', 'theme', next);
  }

  // -------- Theme (v3) — palette + framework --------

  /**
   * Active palette read off `--aura-color-*` CSS vars (the proxy auto-injects
   * /api/os/theme.css for `inherit`-strategy apps). Most apps don't need this —
   * `var(--aura-color-*)` works directly in CSS. Use this for things like an
   * in-app theme preview swatch or canvas painting.
   */
  getPalette(): ColorPalette {
    return readPaletteFromCss('current');
  }

  /**
   * Returns design-framework metadata. Reads `<meta name="aura-design-framework">`
   * synchronously when available (set by the proxy on every proxied HTML
   * response). Falls back to looking up the active theme's framework via the
   * Settings inventory.
   */
  async getDesignFramework(): Promise<DesignFramework> {
    if (typeof document !== 'undefined') {
      const id  = document.querySelector('meta[name="aura-design-framework"]')        ?.getAttribute('content');
      const ver = document.querySelector('meta[name="aura-design-framework-version"]')?.getAttribute('content');
      if (id && ver) {
        // `source` isn't exposed via meta — the framework registry is static
        // for now (scificn only). Hardcode here; if we ever ship multiple
        // frameworks we'll surface source via meta too.
        return { id, name: id, source: 'https://www.scificn.dev', version: ver };
      }
    }
    const themes  = await this.listThemes();
    const activeId = this.getActiveThemeId() ?? themes[0]?.id ?? '';
    const meta    = themes.find((t) => t.id === activeId);
    if (!meta) throw new Error(`getDesignFramework: unknown active themeId '${activeId}'`);
    return meta.framework;
  }

  /**
   * Full active theme object — single palette + tone + framework + tags.
   * Useful for theme-picker UIs that want all the metadata in one call.
   * The palette is reconstructed from the live CSS vars.
   */
  async getTheme(): Promise<OsTheme> {
    const themes = await this.listThemes();
    const id     = this.getActiveThemeId() ?? themes[0]?.id ?? '';
    const meta   = themes.find((t) => t.id === id);
    if (!meta) throw new Error(`getTheme: unknown active themeId '${id}'`);
    return {
      id:           meta.id,
      name:         meta.name,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.tags        !== undefined ? { tags:        meta.tags        } : {}),
      tone:         meta.tone,
      framework:    meta.framework,
      palette:      readPaletteFromCss('current'),
    };
  }

  /** Reads `<meta name="aura-theme-strategy">` set by the proxy. Defaults to `'inherit'`. */
  getThemeStrategy(): ThemeStrategy {
    if (typeof document === 'undefined') return 'inherit';
    const v = document.querySelector('meta[name="aura-theme-strategy"]')?.getAttribute('content');
    return (v === 'themed' || v === 'override') ? v : 'inherit';
  }

  // -------- Theme (v2) — subscriptions --------

  /**
   * Subscribe to theme-id changes (NOT mode changes; see `onModeChange`).
   * Browser-only — no-op on the server. Returns an unsubscribe function.
   * Callback receives the FULL new selection so apps can react without an
   * extra `getThemeSelection()` round-trip.
   */
  onThemeChange(cb: (info: ThemeSelection & {
    themeId:      string;            // active (resolved) theme id
    resolvedMode: ResolvedMode;
    framework?:   DesignFramework;
  }) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const handler = (ev: MessageEvent) => {
      const d = ev.data as Partial<ThemeSelection> & {
        type?: string; themeId?: string; resolvedMode?: ResolvedMode; framework?: DesignFramework;
      };
      if (d?.type === 'aura.theme.changed'
          && d.themeId && d.themeIdDark && d.themeIdLight && d.colorMode && d.resolvedMode) {
        cb({
          themeId:      d.themeId,
          themeIdDark:  d.themeIdDark,
          themeIdLight: d.themeIdLight,
          colorMode:    d.colorMode,
          resolvedMode: d.resolvedMode,
          ...(d.framework ? { framework: d.framework } : {}),
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }

  /**
   * Subscribe to color-mode changes. Fires on:
   *   • `aura.mode.changed` postMessage from the shell (user toggled the picker), AND
   *   • `(prefers-color-scheme: light)` media-query change when the user's pref is `'auto'`
   *     (so apps see the resolved mode flip even if the OS itself didn't broadcast).
   */
  onModeChange(cb: (info: ThemeSelection & {
    themeId:      string;            // active (resolved) theme id
    resolvedMode: ResolvedMode;
  }) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const handler = (ev: MessageEvent) => {
      const d = ev.data as Partial<ThemeSelection> & {
        type?: string; themeId?: string; resolvedMode?: ResolvedMode;
      };
      if (d?.type === 'aura.mode.changed'
          && d.themeId && d.themeIdDark && d.themeIdLight && d.colorMode && d.resolvedMode) {
        cb({
          themeId:      d.themeId,
          themeIdDark:  d.themeIdDark,
          themeIdLight: d.themeIdLight,
          colorMode:    d.colorMode,
          resolvedMode: d.resolvedMode,
        });
      }
    };
    window.addEventListener('message', handler);

    // Auto-mode bridge: if the persisted pref is 'auto', changes to the OS
    // `prefers-color-scheme` need to be surfaced too — the shell can't
    // broadcast that itself. Fire-and-forget lookup; only wire the listener
    // if the current pref is 'auto'.
    let mql: MediaQueryList | null = null;
    let mqlHandler: ((e: MediaQueryListEvent) => void) | null = null;
    this.getThemeSelection()
      .then((sel) => {
        if (sel.colorMode !== 'auto' || typeof window.matchMedia !== 'function') return;
        mql = window.matchMedia('(prefers-color-scheme: light)');
        mqlHandler = (e) => {
          const resolved: ResolvedMode = e.matches ? 'light' : 'dark';
          const activeId = resolved === 'light' ? sel.themeIdLight : sel.themeIdDark;
          cb({ ...sel, themeId: activeId, resolvedMode: resolved });
        };
        if (mql.addEventListener) mql.addEventListener('change', mqlHandler);
        else                       mql.addListener(mqlHandler); // legacy Safari
      })
      .catch(() => undefined);

    return () => {
      window.removeEventListener('message', handler);
      if (mql && mqlHandler) {
        if (mql.removeEventListener) mql.removeEventListener('change', mqlHandler);
        else                          mql.removeListener(mqlHandler);
      }
    };
  }

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
      // Same-origin proxied iframes: trust the parent only.
      if (ev.source !== window.parent) return;
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

// -------- internals --------

function resolveMode(pref: ColorMode): ResolvedMode {
  if (pref === 'light') return 'light';
  if (pref === 'dark')  return 'dark';
  // 'auto' — use the live browser media query when available; SSR default = dark
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

/**
 * Reconstruct a `ColorPalette` from the live CSS variables. Reads the active
 * palette by default (`mode = current`), or pins to light/dark via the
 * `--aura-{light,dark}-color-*` variants always present in /api/os/theme.css.
 */
function readPaletteFromCss(mode: ResolvedMode | 'current' = 'current'): ColorPalette {
  if (typeof document === 'undefined') {
    // SSR fallback — return zeroed palette; the shape is what callers care about
    return zeroPalette();
  }
  const prefix = mode === 'current' ? '' : `${mode}-`;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string) => cs.getPropertyValue(`--aura-${prefix}${name}`).trim();
  return {
    primary:   read('color-primary'),
    secondary: read('color-secondary'),
    danger:    read('color-danger'),
    info:      read('color-info'),
    warning:   read('color-warning'),
    success:   read('color-success'),
    bg:        read('color-bg'),
    surface:   read('color-surface'),
    surface2:  read('color-surface-2'),
    text:      read('color-text'),
    textDim:   read('color-text-dim'),
    border:    read('color-border'),
    glowPrimary:   read('glow-primary'),
    glowSecondary: read('glow-secondary'),
    glowDanger:    read('glow-danger'),
    glowSubtle:    read('glow-subtle'),
  };
}

function zeroPalette(): ColorPalette {
  const z = '';
  return {
    primary: z, secondary: z, danger: z, info: z, warning: z, success: z,
    bg: z, surface: z, surface2: z, text: z, textDim: z, border: z,
    glowPrimary: z, glowSecondary: z, glowDanger: z, glowSubtle: z,
  };
}
