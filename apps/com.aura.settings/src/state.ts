/**
 * Settings state — persisted to `/data/com.aura.settings/settings.json`.
 *
 * The OS mounts `/data/apps/<appId>/<instanceId>/` as the data dir, but since
 * Settings is single-instance we resolve to `/data/com.aura.settings/<instanceId>/settings.json`.
 * For simplicity we use `process.env.APP_DATA_DIR` if the OS sets it, else fall
 * back to a sibling of the entrypoint.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ColorMode = 'light' | 'dark' | 'auto';

export interface SettingsState {
  /**
   * User-selected dark theme (e.g. 'sci-fi'). Active when `colorMode === 'dark'`
   * or `colorMode === 'auto'` and `prefers-color-scheme` is dark.
   */
  themeIdDark:  string;
  /**
   * User-selected light theme (e.g. 'paper'). Active when `colorMode === 'light'`
   * or `colorMode === 'auto'` and `prefers-color-scheme` is light.
   */
  themeIdLight: string;
  /**
   * User pref for OS-wide light/dark.
   *   'dark'  — always use `themeIdDark`
   *   'light' — always use `themeIdLight`
   *   'auto'  — defer to OS `prefers-color-scheme` via media query
   */
  colorMode:    ColorMode;
  clockFormat:  '12h' | '24h';
  locale:       string;
}

const DEFAULT_STATE: SettingsState = {
  themeIdDark:  'sci-fi',
  themeIdLight: 'paper',
  colorMode:    'dark',
  clockFormat:  '24h',
  locale:       'en-US',
};

/**
 * Migrate legacy single-`themeId` state files to the two-slot model. Each
 * legacy id is mapped to its new identity (often a rename) and routed to the
 * dark slot if it's a dark theme, light if light. Unknown ids are dropped to
 * defaults so the user never sees an "Unknown theme" error after upgrade.
 */
const LEGACY_THEME_MIGRATIONS: Record<string, { slot: 'dark' | 'light'; id: string }> = {
  scificn:     { slot: 'dark', id: 'sci-fi'    },
  amber:       { slot: 'dark', id: 'amber'     },
  'red-alert': { slot: 'dark', id: 'red-alert' },
  blue:        { slot: 'dark', id: 'cyan'      },
};

const KEY = '__aura_settings_state__';
const g = globalThis as typeof globalThis & {
  [KEY]?: {
    state: SettingsState;
    file: string;
    listeners: Set<() => void>;
  };
};

function dataFilePath(): string {
  // /data is bind-mounted in OS-managed apps. We picked a stable filename.
  const root = process.env['APP_DATA_DIR'] ?? '/data';
  return `${root}/settings.json`;
}

function loadState(file: string): SettingsState {
  if (!existsSync(file)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SettingsState> & { themeId?: string };
    const out: SettingsState = { ...DEFAULT_STATE, ...parsed };
    // Legacy single-themeId → split into the two slots. The migration table
    // above decides which slot receives the upgraded id. Only applies when
    // BOTH new fields are absent (a freshly-upgraded file).
    if (parsed.themeId && !parsed.themeIdDark && !parsed.themeIdLight) {
      const mig = LEGACY_THEME_MIGRATIONS[parsed.themeId];
      if (mig) {
        if (mig.slot === 'dark')  out.themeIdDark  = mig.id;
        if (mig.slot === 'light') out.themeIdLight = mig.id;
      }
    }
    // Drop the legacy field so the next persist() writes a clean file.
    delete (out as Partial<SettingsState> & { themeId?: string }).themeId;
    return out;
  } catch (err) {
    console.warn('[settings] failed to read state file, using defaults:', err);
    return { ...DEFAULT_STATE };
  }
}

function persist(file: string, state: SettingsState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[settings] persist failed:', err);
  }
}

if (!g[KEY]) {
  const file = dataFilePath();
  g[KEY] = {
    state: loadState(file),
    file,
    listeners: new Set(),
  };
  console.log(`[settings] state loaded from ${file}: ${JSON.stringify(g[KEY].state)}`);
}

export const store = g[KEY]!;

export function getState(): SettingsState {
  return { ...store.state };
}

export function patchState(patch: Partial<SettingsState>): SettingsState {
  store.state = { ...store.state, ...patch };
  persist(store.file, store.state);
  for (const cb of store.listeners) {
    try { cb(); } catch {}
  }
  return getState();
}
