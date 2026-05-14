export type AppLifecycleState =
  | 'installed'
  | 'creating'
  | 'created'
  | 'starting'
  | 'started'
  | 'resuming'
  | 'resumed'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'destroying'
  | 'destroyed'
  | 'error';

// Valid state transitions enforced by LifecycleStateMachine
export const VALID_TRANSITIONS: Record<AppLifecycleState, AppLifecycleState[]> = {
  installed:  ['creating'],
  creating:   ['created', 'error'],
  created:    ['starting'],
  starting:   ['started'],
  started:    ['resuming', 'stopping'],
  resuming:   ['resumed'],
  resumed:    ['pausing'],
  pausing:    ['paused'],
  paused:     ['resuming', 'stopping'],
  stopping:   ['stopped'],
  stopped:    ['starting', 'destroying'],
  destroying: ['destroyed'],
  destroyed:  ['installed'],
  error:      ['creating', 'destroying', 'installed'],
};

/** @deprecated Use `AppInstance` from './instance.js'. Retained for backward-compat type imports. */
export interface AppLifecycleRecord {
  appId: string;
  state: AppLifecycleState;
  pid: number | null;
  port: number | null;
  startedAt: Date | null;
  lastTransitionAt: Date;
  restartCount: number;
  error?: string;
}
