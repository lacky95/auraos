/**
 * The theme and keymap state an app document starts from. Read by the proxy's
 * HTML injection and by `/_aura/runtime.js`.
 */
import { ThemeManager, readUserPrefValue } from '@aura/core';
import type { ColorMode, KeyAction, OsKeymapState } from '@aura/core';
import { sharedKv } from './sharedKv.js';

/**
 * Read the user's current `{ themeIdDark, themeIdLight, colorMode }`.
 * Mirrors OSLayout's SSR lookup. Falls back to defaults silently when nothing
 * is stored — every value has a sane default in ThemeManager.
 */
export async function readShellThemeSelection(userId: string): Promise<{ themeIdDark: string; themeIdLight: string; colorMode: ColorMode } | null> {
  // Read directly from the KV — no app dependency. The user's own value
  // (D46), else the shared `os/theme` the bootstrap step populates.
  const kv = sharedKv();
  try {
    const stored = await readUserPrefValue<{ themeIdDark?: string; themeIdLight?: string; colorMode?: ColorMode }>(kv, userId, 'theme');
    if (!stored) return null;
    return {
      themeIdDark:  stored.themeIdDark  ?? ThemeManager.DEFAULT_THEME_ID_DARK,
      themeIdLight: stored.themeIdLight ?? ThemeManager.DEFAULT_THEME_ID_LIGHT,
      colorMode:    stored.colorMode    ?? ThemeManager.DEFAULT_COLOR_MODE,
    };
  } catch { return null; }
}

/**
 * Read the user's persisted keymap overlay (D46: their own, else the shared
 * `os/keymap`). Returns the empty state on cold boot / missing key — that
 * means "use registry defaults", which is what `resolveBindings` does anyway.
 */
export async function readShellKeymapState(userId: string): Promise<OsKeymapState> {
  const kv = sharedKv();
  try {
    const stored = await readUserPrefValue<OsKeymapState>(kv, userId, 'keymap');
    if (!stored) return { bindings: {}, appOverlays: {} };
    return {
      bindings:    stored.bindings    ?? {},
      appOverlays: stored.appOverlays ?? {},
    };
  } catch { return { bindings: {}, appOverlays: {} }; }
}

/**
 * Resolve the currently-effective combo for each of the given actions,
 * applying the user's KV overlay on top of the registry defaults. The map
 * is { actionId → combo|null } — null means "explicitly unbound".
 *
 * Apps consume this via `<meta name="aura-keymap-bindings">` injected into
 * their HTML; the SDK's `getBinding()` reads it synchronously.
 */
export function resolveBindings(actions: readonly KeyAction[], appId: string, state: OsKeymapState): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const overlay = state.appOverlays[appId] ?? {};
  for (const a of actions) {
    if (a.id.startsWith(`app.${appId}.`)) {
      out[a.id] = a.id in overlay ? (overlay[a.id] ?? null) : a.defaultCombo;
    } else {
      out[a.id] = a.id in state.bindings ? (state.bindings[a.id] ?? null) : a.defaultCombo;
    }
  }
  return out;
}
