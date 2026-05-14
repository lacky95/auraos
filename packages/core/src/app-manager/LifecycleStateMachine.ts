import type { AppLifecycleState } from '../types/lifecycle.js';
import { VALID_TRANSITIONS } from '../types/lifecycle.js';

export class LifecycleTransitionError extends Error {
  constructor(appId: string, from: AppLifecycleState, to: AppLifecycleState) {
    super(`[${appId}] Invalid lifecycle transition: ${from} → ${to}`);
  }
}

export class LifecycleStateMachine {
  private states = new Map<string, AppLifecycleState>();

  get(appId: string): AppLifecycleState {
    return this.states.get(appId) ?? 'installed';
  }

  transition(appId: string, to: AppLifecycleState): void {
    const from = this.get(appId);
    const valid = VALID_TRANSITIONS[from];
    if (!valid.includes(to)) {
      throw new LifecycleTransitionError(appId, from, to);
    }
    this.states.set(appId, to);
  }

  set(appId: string, state: AppLifecycleState): void {
    this.states.set(appId, state);
  }

  delete(appId: string): void {
    this.states.delete(appId);
  }
}
