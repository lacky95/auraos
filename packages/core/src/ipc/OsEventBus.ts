import EventEmitter from 'eventemitter3';
import type { AppLifecycleState } from '../types/lifecycle.js';

/**
 * Compact framework fingerprint carried on theme/mode change events. Apps that
 * care about framework drift (e.g. when we eventually lift the single-framework
 * invariant) can react without an extra fetch.
 */
export interface EventFramework {
  id:      string;
  version: string;
}

export interface OsEvents {
  'app:stateChanged': { instanceId: string; appId: string; state: AppLifecycleState; port: number | null };
  'app:crashed': { instanceId: string; appId: string; error: string };
  'app:installed': { appId: string };
  'app:removed': { appId: string };
  /** A user toggled an app's enable state (Settings → Apps or `aura app enable/disable`). */
  'app:enabledChanged': { appId: string; enabled: boolean };
  /** A user launched an app — dock uses this to re-order its MRU tiles live. */
  'app:mruChanged': { appId: string; at: number };
  'activity:opened': { activityId: string; parentInstanceId: string; appId: string; path: string; title?: string; minimizable?: boolean; stackParentId?: string };
  'activity:closed': { activityId: string; parentInstanceId: string; appId: string };
  /**
   * Emitted by `goBack` after the popped activity is closed: the shell should
   * re-focus the named activity (typically the back-stack parent). Independent
   * event from `activity:opened` because the activity is already open and the
   * shell handles "focus existing view" with a different code path.
   */
  'activity:focus':  { activityId: string; parentInstanceId: string; appId: string };
  /**
   * Activity navigated in place — the iframe URL changed without spawning
   * a new view. Fired by `AppManager.navigateActivity()` (forward step) AND
   * by `AppManager.goBack()` when it pops the history stack instead of
   * closing. The shell updates `view.iframeUrl` + iframe `src` + title in
   * response so the existing slot reflects the new path.
   */
  'activity:navigated': {
    activityId:       string;
    parentInstanceId: string;
    appId:            string;
    path:             string;
    title?:           string;
    /** Full updated history so the shell's breadcrumb trail can rerender in
     *  one event (no second fetch). Empty array means "no prior steps". */
    history:          Array<{ path: string; title?: string }>;
    /** Mirror of `activity.breadcrumb` so the chrome can show/hide the trail. */
    breadcrumb:       'os' | 'off';
    /** True when the navigation is the result of a Back-pop; false on forward navigate. */
    fromHistory:      boolean;
  };
  /** Fired when an app toggles its breadcrumb mode at runtime (SDK setter). */
  'activity:breadcrumbChanged': {
    activityId:       string;
    parentInstanceId: string;
    appId:            string;
    breadcrumb:       'os' | 'off';
  };
  'theme:changed': {
    themeId:       string;                     // the ACTIVE (resolved) theme id
    themeName:     string;
    themeIdDark:   string;                     // user's dark slot pick
    themeIdLight:  string;                     // user's light slot pick
    colorMode:     'light' | 'dark' | 'auto';
    resolvedMode:  'light' | 'dark';
    activeTone:    'light' | 'dark';           // === resolvedMode but semantic
    framework:     EventFramework;
  };
  'mode:changed': {
    themeId:       string;                     // the ACTIVE (resolved) theme id
    themeIdDark:   string;
    themeIdLight:  string;
    colorMode:     'light' | 'dark' | 'auto';
    resolvedMode:  'light' | 'dark';
    activeTone:    'light' | 'dark';
    framework:     EventFramework;
  };
  'notification': { appId: string; title: string; body: string };
  /**
   * Workspace list or contents changed. Payload contains lightweight
   * summaries (no full member arrays) so the SSE wire stays small. The
   * shell fetches the full state from the Settings provider when it needs
   * to re-render layouts.
   */
  'workspaces:changed': {
    workspaces:        Array<{ id: string; name: string; layoutId: string; memberCount: number }>;
    activeWorkspaceId: string;
  };
  /** Active workspace changed (subset of `workspaces:changed`). */
  'workspace:activated': { workspaceId: string };
  /**
   * KV write or delete. `value: null` means a delete. Namespace + key
   * together form the KV address (`os:theme`, `app/com.aura.notepad:foo`).
   * SSE subscribers can topic-filter `kv:*` to get every change, or read
   * the namespace from the payload to narrow further.
   */
  'kv:changed': { namespace: 'os' | `app/${string}`; key: string; value: unknown | null };
  /**
   * Aura Context value changed (env var / secret). `deleted` distinguishes a
   * removal from an upsert. Values are never included in the payload. `scope`
   * is `'system'` for the v1 global context (`app:<id>` reserved for later).
   */
  'context:changed': { scope: string; key: string; deleted: boolean };
  /**
   * Aura Context VOLUME added/removed (OS-managed shared volume). No values,
   * just the name + whether it was a removal. `scope` is implicitly system in
   * phase 1 (global, mounted into every app).
   */
  'context:volumes:changed': { name: string; deleted: boolean };
  /** Nexus install completed. `record` is the persisted install metadata. */
  'nexus:install.complete':   { id: string; record: unknown };
  /** Nexus update completed (or no-op'd when up-to-date). */
  'nexus:update.complete':    { id: string; record: unknown | null };
  /** Nexus uninstall completed. */
  'nexus:uninstall.complete': { id: string };
  /** Nexus publish completed. `ref` is the printable install command. */
  'nexus:publish.complete':   { id?: string; ref: string };
}

class TypedEventBus extends EventEmitter<OsEvents> {}

/**
 * Singleton pinned on globalThis so emitters and SSE subscribers always hit
 * the same bus instance even when Vite/Astro loads `@aura/core` into multiple
 * module graphs in dev (SSR route handlers vs. plugin context vs. page SSR
 * each get their own copy of module-scoped state otherwise).
 */
const GLOBAL_KEY = '__aura_os_event_bus__';
type GlobalWithBus = typeof globalThis & { [GLOBAL_KEY]?: TypedEventBus };
const existing = (globalThis as GlobalWithBus)[GLOBAL_KEY];
export const OsEventBus: TypedEventBus = existing ?? new TypedEventBus();
if (!existing) (globalThis as GlobalWithBus)[GLOBAL_KEY] = OsEventBus;
