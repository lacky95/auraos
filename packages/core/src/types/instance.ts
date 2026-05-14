import type { AppLifecycleState } from './lifecycle.js';

/**
 * A running (or transitioning) instance of an app.
 *
 * For apps with manifest.instanceMode='single', instanceId === appId.
 * For apps with manifest.instanceMode='multi', instanceId === `${appId}-${counter}` (counter starts at 1).
 */
export interface AppInstance {
  instanceId: string;
  appId: string;
  state: AppLifecycleState;
  pid: number | null;
  port: number | null;
  startedAt: Date | null;
  lastTransitionAt: Date;
  restartCount: number;
  error?: string;
}
