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

export class OsClient {
  private base: string;

  constructor() {
    this.base = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
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

  /** Current selection from Settings: both slot ids plus colorMode. */
  async getThemeSelection(): Promise<ThemeSelection> {
    return this.queryProvider<ThemeSelection>('com.aura.settings', 'theme');
  }

  /** Lightweight inventory of every theme the OS ships (no palettes). */
  async listThemes(): Promise<ThemeSummary[]> {
    const res = await this.queryProvider<{ themes: ThemeSummary[] }>(
      'com.aura.settings', 'themes',
    );
    return res.themes;
  }

  /**
   * Persist a theme pick for a specific tone slot. Slots are independent:
   * setting the dark slot doesn't disturb the light slot, and vice versa.
   * `colorMode` decides which slot is currently rendered.
   */
  async setOsThemeForTone(tone: ThemeTone, themeId: string): Promise<void> {
    const field = tone === 'dark' ? 'themeIdDark' : 'themeIdLight';
    await this.writeProvider('com.aura.settings', 'theme', { [field]: themeId });
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
    await this.writeProvider('com.aura.settings', 'theme', { colorMode: mode });
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
