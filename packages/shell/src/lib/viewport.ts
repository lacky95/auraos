/**
 * Viewport profiles — pure, isomorphic data model + helpers.
 *
 * A "viewport profile" is a named bundle of the viewport knobs the user tunes
 * from the ⚙ dialog: the three zoom factors (main / shell / app) and the
 * screen-edge margins. Profiles let a user keep e.g. a "TV" preset (big
 * everything) next to a "Mobile" preset and switch between them in one click.
 *
 * Persisted in device localStorage under `aura.os.viewport` — viewport is a
 * per-device setting (your monitor, your zoom), not user-account state. This
 * module deliberately has NO browser or Node imports so it can be used from
 * SSR AND the browser. The browser-only glue (localStorage I/O, the
 * `window.auraSet*` apply primitives, cross-tab `storage` sync) lives in
 * lib/viewportClient.ts.
 */

// Narrow subpath import — NOT the '@aura/core' barrel. The barrel re-exports
// the app-manager (ProotRunner/PortAllocator/AppManager) which pull in
// node:child_process / node:fs / node:net; bundling those into a browser
// script throws at load and takes the whole StatusBar client script (clock,
// zoom, locale, workspace switching) down with it. '@aura/core/theme' is a
// self-contained, import-free module — keeps this file truly isomorphic as
// the header promises.
import { ThemeManager } from '@aura/core/theme';

export interface ViewportMargins {
  top:    number;
  right:  number;
  bottom: number;
  left:   number;
}

export interface ViewportProfile {
  id:           string;
  name:         string;
  zoom:         number; // main — scales everything (chrome + app content)
  shellZoom:    number; // OS chrome only (bars, window frames + buttons)
  appZoom:      number; // app content (iframes) only
  margins:      ViewportMargins;
  themeIdLight: string; // chosen when colorMode resolves to 'light'
  themeIdDark:  string; // chosen when colorMode resolves to 'dark'
}

export interface ViewportState {
  activeProfileId: string;
  profiles:        ViewportProfile[];
  /**
   * Dev-only, device-wide: when true (default) the shell full-reloads on
   * Vite source changes (the normal behaviour). When false, lib/devReload
   * suppresses the reload so OS state survives edits. Lives at the top level
   * — it's a developer preference, independent of the zoom/theme profiles.
   */
  autoReload:      boolean;
}

// Shared limits — same range the zoom sliders + StatusBar clamp use.
export const ZOOM_MIN   = 0.5;
export const ZOOM_MAX   = 4.0;
export const MARGIN_MAX = 400;

export const DEFAULT_PROFILE_ID = 'default';

export function defaultProfile(): ViewportProfile {
  return {
    id:           DEFAULT_PROFILE_ID,
    name:         'Default',
    zoom:         1,
    shellZoom:    1,
    appZoom:      1,
    margins:      { top: 0, right: 0, bottom: 0, left: 0 },
    themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
    themeIdDark:  ThemeManager.DEFAULT_THEME_ID_DARK,
  };
}

function coerceThemeId(raw: unknown, tone: 'light' | 'dark'): string {
  if (typeof raw === 'string' && ThemeManager.getTheme(raw)) return raw;
  return ThemeManager.getDefaultForTone(tone);
}

/** Default state when localStorage is empty — exactly one profile. */
export const DEFAULT_VIEWPORT_STATE: ViewportState = {
  activeProfileId: DEFAULT_PROFILE_ID,
  profiles:        [defaultProfile()],
  autoReload:      true,
};

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
}

export function clampMargin(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MARGIN_MAX, Math.round(v)));
}

export function clampMargins(m: Partial<ViewportMargins>): Partial<ViewportMargins> {
  const out: Partial<ViewportMargins> = {};
  for (const k of ['top', 'right', 'bottom', 'left'] as const) {
    if (m[k] !== undefined) out[k] = clampMargin(m[k]!);
  }
  return out;
}

function normalizeProfile(raw: unknown): ViewportProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<ViewportProfile>;
  if (typeof p.id !== 'string' || !p.id) return null;
  const m = (p.margins && typeof p.margins === 'object') ? p.margins as Partial<ViewportMargins> : {};
  return {
    id:           p.id,
    name:         typeof p.name === 'string' && p.name ? p.name : p.id,
    zoom:         clampZoom(Number(p.zoom      ?? 1)),
    shellZoom:    clampZoom(Number(p.shellZoom ?? 1)),
    appZoom:      clampZoom(Number(p.appZoom   ?? 1)),
    margins: {
      top:    clampMargin(Number(m.top    ?? 0)),
      right:  clampMargin(Number(m.right  ?? 0)),
      bottom: clampMargin(Number(m.bottom ?? 0)),
      left:   clampMargin(Number(m.left   ?? 0)),
    },
    themeIdLight: coerceThemeId(p.themeIdLight, 'light'),
    themeIdDark:  coerceThemeId(p.themeIdDark,  'dark'),
  };
}

/**
 * Coerce arbitrary JSON (from KV, an older schema, or another tab) into a
 * valid ViewportState. Always returns at least one profile and an
 * activeProfileId that points at a real profile.
 */
export function normalizeState(raw: unknown): ViewportState {
  const r = (raw && typeof raw === 'object') ? raw as Partial<ViewportState> : {};
  const profiles = (Array.isArray(r.profiles) ? r.profiles : [])
    .map(normalizeProfile)
    .filter((p): p is ViewportProfile => p !== null);
  if (profiles.length === 0) profiles.push(defaultProfile());
  let activeProfileId = typeof r.activeProfileId === 'string' ? r.activeProfileId : profiles[0]!.id;
  if (!profiles.some((p) => p.id === activeProfileId)) activeProfileId = profiles[0]!.id;
  // Default ON so blobs saved before this field existed keep today's reload
  // behaviour; only an explicit `false` opts out.
  const autoReload = typeof r.autoReload === 'boolean' ? r.autoReload : true;
  return { activeProfileId, profiles, autoReload };
}

export function resolveActiveProfile(state: ViewportState): ViewportProfile {
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0]!;
}

export function cloneState(s: ViewportState): ViewportState {
  return {
    activeProfileId: s.activeProfileId,
    profiles:        s.profiles.map((p) => ({ ...p, margins: { ...p.margins } })),
    autoReload:      s.autoReload,
  };
}
