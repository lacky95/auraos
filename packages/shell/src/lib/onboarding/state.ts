/**
 * Onboarding progress, in the KV under `os/onboarding`:
 *
 *   { setupDoneAt?, welcome: { hidden?, done: { <step>: <ms> } } }
 *
 * `setupDoneAt` — the first-boot setup card finished once; later boots only
 * show it again when the base image has to be built.
 * `welcome.done` — welcome steps ticked off (auto-detected or marked by a
 * route, e.g. a successful admin unlock). Kept even when the detection would
 * now say otherwise: a step done once stays done.
 * `welcome.hidden` — the user hid or dismissed the checklist.
 *
 * An install that existed before onboarding shipped gets a record with both
 * set, so nobody is welcomed to a system they have used for months.
 */

import { defaultKv } from '@aura/kv-store';
import type { WelcomeStepId } from './steps.js';

export interface OnboardingState {
  setupDoneAt?: number;
  welcome: { hidden?: boolean; done: Partial<Record<WelcomeStepId, number>> };
}

const NS = 'os';
const KEY = 'onboarding';

export const emptyState = (): OnboardingState => ({ welcome: { done: {} } });

async function withKv<T>(fn: (kv: ReturnType<typeof defaultKv>) => Promise<T>): Promise<T> {
  const kv = defaultKv();
  try { return await fn(kv); }
  finally { await kv.close().catch(() => undefined); }
}

function normalise(v: unknown): OnboardingState {
  const s = (v && typeof v === 'object' ? v : {}) as Partial<OnboardingState>;
  return {
    ...(typeof s.setupDoneAt === 'number' ? { setupDoneAt: s.setupDoneAt } : {}),
    welcome: {
      ...(s.welcome?.hidden ? { hidden: true } : {}),
      done: { ...(s.welcome?.done ?? {}) },
    },
  };
}

export async function readOnboarding(): Promise<OnboardingState | null> {
  return withKv(async (kv) => {
    const v = await kv.getValue<OnboardingState>(NS, KEY);
    return v ? normalise(v) : null;
  });
}

let chain: Promise<unknown> = Promise.resolve();

/** Read-modify-write, serialised within this process. */
export function updateOnboarding(fn: (s: OnboardingState) => OnboardingState): Promise<OnboardingState> {
  const run = chain.then(() => withKv(async (kv) => {
    const cur = normalise(await kv.getValue<OnboardingState>(NS, KEY));
    const next = normalise(fn(cur));
    await kv.set(NS, KEY, next);
    return next;
  }));
  chain = run.catch(() => undefined);
  return run;
}
