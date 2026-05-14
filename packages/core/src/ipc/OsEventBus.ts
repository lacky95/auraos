import EventEmitter from 'eventemitter3';
import type { AppLifecycleState } from '../types/lifecycle.js';

export interface OsEvents {
  'app:stateChanged': { instanceId: string; appId: string; state: AppLifecycleState; port: number | null };
  'app:crashed': { instanceId: string; appId: string; error: string };
  'app:installed': { appId: string };
  'app:removed': { appId: string };
  'activity:opened': { activityId: string; parentInstanceId: string; appId: string; path: string; title?: string };
  'activity:closed': { activityId: string; parentInstanceId: string; appId: string };
  'theme:changed':   { themeId: string; themeName: string };
  'notification': { appId: string; title: string; body: string };
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
