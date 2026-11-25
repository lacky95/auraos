/**
 * `osClient.theme`: the OS theme: the selection (both tone slots and the
 * colour mode), the theme inventory, the live palette, and change events.
 * Most apps need none of it: `var(--aura-color-*)` in CSS follows the theme.
 *
 * Reads come from the runtime bootstrap (`AuraRuntimeBootstrap`, set by
 * `/_aura/runtime.js` before any app script runs) where it has them, else
 * from the OS. The flat `OsClient` theme methods (`getThemeSelection`,
 * `onThemeChange`, …) are deprecated aliases of these.
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
import { appHostRuntime, osAuthHeaders } from './os-auth.js';
import { isFromShell } from './channel.js';
import { OsError, statusCode } from './errors.js';

/** Full theme selection persisted in Settings. */
export interface ThemeSelection {
  themeIdDark:  string;
  themeIdLight: string;
  colorMode:    ColorMode;
}

/** How an app participates in OS theming (manifest `themeStrategy`). */
export type ThemeStrategy = 'inherit' | 'themed' | 'override';

export class ThemeApi {
  /** `base`: the OS base of the client (the gateway in a page, OS_API_BASE on a server). */
  constructor(private readonly base: () => string) {}

  // -------- Theme (v3) — selection + inventory --------

  /**
   * Current selection from the OS KV: both slot ids plus colorMode. The
   * value lives at `/api/kv/os/theme` (shell-served); writes require the
   * `system.kv.os.theme.write` permission, reads are public.
   */
  async getSelection(): Promise<ThemeSelection> {
    const url = `${this.base()}/api/kv/os/theme`;
    const res = await fetch(url, { headers: osAuthHeaders(url) });
    if (!res.ok) throw new OsError(res.status, statusCode(res.status), `getThemeSelection → HTTP ${res.status}`);
    const body = await res.json() as { value: ThemeSelection };
    return body.value;
  }

  /** Lightweight inventory of every theme the OS ships (no palettes). */
  async list(): Promise<ThemeSummary[]> {
    const url = `${this.base()}/api/os/themes`;
    const res = await fetch(url, { headers: osAuthHeaders(url) });
    if (!res.ok) throw new OsError(res.status, statusCode(res.status), `listThemes → HTTP ${res.status}`);
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
  async setForTone(tone: ThemeTone, themeId: string): Promise<void> {
    const previous = await this.getSelection().catch(() => null);
    const next = { ...(previous ?? {}), [tone === 'dark' ? 'themeIdDark' : 'themeIdLight']: themeId };
    await this.kvPut('os', 'theme', next);
  }

  private async kvPut(namespace: string, key: string, value: unknown): Promise<void> {
    const segs = `${namespace}/${key}`.split('/').map(encodeURIComponent).join('/');
    const url = `${this.base()}/api/kv/${segs}`;
    const res = await fetch(url, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', ...osAuthHeaders(url) },
      body:    JSON.stringify({ value }),
    });
    if (!res.ok) throw new OsError(res.status, statusCode(res.status), `kv PUT ${namespace}/${key} → HTTP ${res.status}: ${await res.text()}`);
  }

  /**
   * The OS theme active when this page loaded, from the runtime bootstrap
   * (synchronous). Null on the server or outside AuraOS. `onThemeChange`
   * reports later changes.
   */
  getActiveId(): string | null {
    return appHostRuntime()?.theme.themeId ?? null;
  }

  // -------- Theme (v2) — mode (light / dark / auto) --------

  /** User pref including `'auto'`. */
  async getModePreference(): Promise<ColorMode> {
    const { colorMode } = await this.getSelection();
    return colorMode;
  }

  /** Resolved mode — turns `'auto'` into `'light'` or `'dark'` via the browser media query. */
  async getMode(): Promise<ResolvedMode> {
    const pref = await this.getModePreference();
    return resolveMode(pref);
  }

  /** Persist a colorMode preference. Broadcasts on the OS bus. */
  async setMode(mode: ColorMode): Promise<void> {
    const previous = await this.getSelection().catch(() => null);
    const next = { ...(previous ?? {}), colorMode: mode };
    await this.kvPut('os', 'theme', next);
  }

  // -------- Theme (v3) — palette + framework --------

  /**
   * Active palette read off `--aura-color-*` CSS vars (`/_aura/runtime.js`
   * links /api/os/theme.css for `inherit`-strategy apps). Most apps don't need this —
   * `var(--aura-color-*)` works directly in CSS. Use this for things like an
   * in-app theme preview swatch or canvas painting.
   */
  getPalette(): ColorPalette {
    return readPaletteFromCss('current');
  }

  /**
   * Returns design-framework metadata. Reads the runtime bootstrap
   * synchronously when available, else looks up the active theme's framework
   * in the theme inventory.
   */
  async getDesignFramework(): Promise<DesignFramework> {
    const fw = appHostRuntime()?.theme.framework;
    if (fw) {
      // `source` isn't in the bootstrap: the framework registry is static
      // for now (scificn only). Hardcode here; if we ever ship multiple
      // frameworks we'll add it there too.
      return { id: fw.id, name: fw.id, source: 'https://www.scificn.dev', version: fw.version };
    }
    const themes  = await this.list();
    const activeId = this.getActiveId() ?? themes[0]?.id ?? '';
    const meta    = themes.find((t) => t.id === activeId);
    if (!meta) throw new OsError(0, 'unknown-theme', `getDesignFramework: unknown active themeId '${activeId}'`);
    return meta.framework;
  }

  /**
   * Full active theme object — single palette + tone + framework + tags.
   * Useful for theme-picker UIs that want all the metadata in one call.
   * The palette is reconstructed from the live CSS vars.
   */
  async get(): Promise<OsTheme> {
    const themes = await this.list();
    const id     = this.getActiveId() ?? themes[0]?.id ?? '';
    const meta   = themes.find((t) => t.id === id);
    if (!meta) throw new OsError(0, 'unknown-theme', `theme.get: unknown active themeId '${id}'`);
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

  /** This app's theme strategy, from the runtime bootstrap. Defaults to `'inherit'`. */
  getStrategy(): ThemeStrategy {
    return appHostRuntime()?.theme.strategy ?? 'inherit';
  }

  // -------- Theme (v2) — subscriptions --------

  /**
   * Subscribe to theme-id changes (NOT mode changes; see `onModeChange`).
   * Browser-only — no-op on the server. Returns an unsubscribe function.
   * Callback receives the FULL new selection so apps can react without an
   * extra `getSelection()` round-trip.
   */
  onChange(cb: (info: ThemeSelection & {
    themeId:      string;            // active (resolved) theme id
    resolvedMode: ResolvedMode;
    framework?:   DesignFramework;
  }) => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const handler = (ev: MessageEvent) => {
      if (!isFromShell(ev)) return;
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
      if (!isFromShell(ev)) return;
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
    this.getSelection()
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
