import EventEmitter from 'eventemitter3';
import type { AppLifecycleState } from '../types/lifecycle.js';

export interface OsEvents {
  'app:stateChanged': { instanceId: string; appId: string; state: AppLifecycleState; port: number | null };
  'app:crashed': { instanceId: string; appId: string; error: string };
  'app:installed': { appId: string };
  'app:removed': { appId: string };
  'activity:opened': { activityId: string; parentInstanceId: string; appId: string; path: string };
  'activity:closed': { activityId: string; parentInstanceId: string; appId: string };
  'theme:changed':   { themeId: string; themeName: string };
  'notification': { appId: string; title: string; body: string };
}

class TypedEventBus extends EventEmitter<OsEvents> {}

export const OsEventBus = new TypedEventBus();
