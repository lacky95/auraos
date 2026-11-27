/**
 * D101: when the last window of an app's instance closes and the app keeps a
 * background process (`backgroundService: true`, the `activity-bg` shape),
 * the desktop asks the user whether to stop the process or keep it running.
 * This module is the pure half: the user's preference and the decision. The
 * dialog and the flow are lib/lastWindowDialog.ts.
 *
 * The preference is per user (D46): `os/lastWindow` through /api/kv, stored
 * at `user/<userId>/prefs:lastWindow` (core USER_PREF_KEYS). Settings → Apps
 * → Activities & processes shows and edits the same document.
 *
 *   {
 *     ask:  boolean,                       // the prompt is on (default: on)
 *     apps: { <key>: { choice: 'keep' | 'stop', appId, name?, at } }
 *   }
 *
 * `<key>` is the app's installation id when it has one (a reinstall asks
 * afresh), else its app id. A remembered choice applies whether or not the
 * prompt is on; with the prompt off, an app without one keeps running, as
 * every background app did before D101.
 *
 * Who is never asked (unchanged behaviour): an app without a background
 * process (its last window closing stops it, core AppManager.closeActivity),
 * a service or headless app (D73: its lifecycle never depends on a window),
 * and a close that is not the last activity of that instance. Moving a window
 * between workspaces and a flight takeoff or landing are not closes at all.
 */

export const LAST_WINDOW_PREF = 'lastWindow';
/** Same-tab notice after the desktop wrote the preference (detail: LastWindowPrefs). */
export const LAST_WINDOW_EVENT = 'aura:last-window-prefs';

export type LastWindowChoice = 'keep' | 'stop';

export interface RememberedChoice {
  choice: LastWindowChoice;
  appId: string;
  /** The app's name when it was remembered (Settings shows it if the app is gone). */
  name?: string;
  /** When it was remembered (ms). */
  at: number;
}

export interface LastWindowPrefs {
  ask: boolean;
  apps: Record<string, RememberedChoice>;
}

export const LAST_WINDOW_DEFAULTS: LastWindowPrefs = Object.freeze({ ask: true, apps: Object.freeze({}) }) as LastWindowPrefs;

const MAX_REMEMBERED = 200;
const KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** Unknown or broken values fall back to the defaults, entry by entry. */
export function normalizeLastWindowPrefs(raw: unknown): LastWindowPrefs {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const apps: Record<string, RememberedChoice> = {};
  const src = r['apps'] && typeof r['apps'] === 'object' && !Array.isArray(r['apps']) ? r['apps'] as Record<string, unknown> : {};
  for (const [key, v] of Object.entries(src).slice(0, MAX_REMEMBERED)) {
    if (!KEY_RE.test(key) || !v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    if (e['choice'] !== 'keep' && e['choice'] !== 'stop') continue;
    if (typeof e['appId'] !== 'string' || !e['appId']) continue;
    apps[key] = {
      choice: e['choice'], appId: e['appId'],
      ...(typeof e['name'] === 'string' && e['name'] ? { name: e['name'].slice(0, 120) } : {}),
      at: typeof e['at'] === 'number' && Number.isFinite(e['at']) ? e['at'] : 0,
    };
  }
  return { ask: typeof r['ask'] === 'boolean' ? r['ask'] : LAST_WINDOW_DEFAULTS.ask, apps };
}

/** Where an app's remembered choice lives: its installation, else its id. */
export function choiceKey(appId: string, installationId?: string | null): string {
  return installationId && KEY_RE.test(installationId) ? installationId : appId;
}

/** The prefs with one app's choice remembered (the newest wins). */
export function rememberChoice(
  prefs: LastWindowPrefs, key: string, entry: { choice: LastWindowChoice; appId: string; name?: string }, now = Date.now(),
): LastWindowPrefs {
  return normalizeLastWindowPrefs({ ...prefs, apps: { ...prefs.apps, [key]: { ...entry, at: now } } });
}

/** The prefs without one remembered choice (`null`: all of them). */
export function forgetChoice(prefs: LastWindowPrefs, key: string | null): LastWindowPrefs {
  if (key === null) return { ...prefs, apps: {} };
  const apps = { ...prefs.apps };
  delete apps[key];
  return { ...prefs, apps };
}

/** What a close did, as the shell answers it (lib/activityClose.ts). */
export interface CloseFacts {
  closed: boolean;
  lastOfInstance: boolean;
  instanceStopped: boolean;
  instanceRunning: boolean;
  appId: string | null;
  installationId?: string;
}

/** The manifest fields that decide whether an app keeps a background process. */
export interface ProcessShape {
  componentType?: string;
  backgroundService?: boolean;
}

/** An app whose last window may close while its process keeps running. */
export function keepsBackgroundProcess(m: ProcessShape | null | undefined): boolean {
  return !!m && m.componentType !== 'service' && m.backgroundService === true;
}

/**
 * What to do after a user closed a window:
 *   'none'  nothing (not the last window, not a background app, already stopped);
 *   'ask'   show the dialog;
 *   'keep' / 'stop'  the remembered choice for this app.
 */
export function decideLastWindow(
  close: CloseFacts | null | undefined, manifest: ProcessShape | null | undefined, prefs: LastWindowPrefs,
): 'none' | 'ask' | LastWindowChoice {
  if (!close?.closed || !close.lastOfInstance || close.instanceStopped || !close.instanceRunning || !close.appId) return 'none';
  if (!keepsBackgroundProcess(manifest)) return 'none';
  const remembered = prefs.apps[choiceKey(close.appId, close.installationId)] ?? prefs.apps[close.appId];
  if (remembered) return remembered.choice;
  return prefs.ask ? 'ask' : 'none';
}
