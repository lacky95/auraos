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

export interface SettingsState {
  themeId: string;
  clockFormat: '12h' | '24h';
  locale: string;
}

const DEFAULT_STATE: SettingsState = {
  themeId:     'scificn',
  clockFormat: '24h',
  locale:      'en-US',
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
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    return { ...DEFAULT_STATE, ...parsed };
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
