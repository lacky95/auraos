/**
 * Onboarding for a new AuraOS — the shell side of a first start:
 *
 *   1. "Setting up AuraOS" (setupCard.ts): the first-boot background work,
 *      step by step. On later boots only when the app image must be rebuilt.
 *   2. "Welcome to AuraOS" (welcome.ts): the getting-started checklist,
 *      once setup is finished, until it is done or hidden.
 *
 * (Before the shell runs at all, os/boot-splash.mjs serves the "AuraOS is
 * starting" page on :3000.)
 *
 * Boot order (middleware.ts): `startOnboarding()` before AppManager.init(),
 * because the app image gates every container spawn; `afterInit()` after it,
 * because the registry and docs are apps init() starts. Never throws.
 */

import { SetupCard } from './setupCard.js';
import { Welcome, currentWelcome } from './welcome.js';
import { emptyState, readOnboarding, updateOnboarding } from './state.js';
import { ensureSdkPublished } from '../sdkBootstrap.js';
import type { WelcomeStepId } from './steps.js';

export { noteClientConnected } from './card.js';

export interface OnboardingOpts {
  dataDir: string;
  shellPort: number;
  toolchainDir: string;
  /** No OS state existed before this boot (bootstrapKv seeded the defaults). */
  freshInstall: boolean;
}

export interface OnboardingHandle {
  afterInit(): void;
}

const KEY = Symbol.for('aura.onboarding.started');
type G = typeof globalThis & { [KEY]?: true };

export async function startOnboarding(opts: OnboardingOpts): Promise<OnboardingHandle> {
  const g = globalThis as G;
  // A soft restart re-runs the boot: the cards and listeners from the first
  // run are still alive — only the per-boot SDK seed runs again.
  if (g[KEY]) return { afterInit: () => { void ensureSdkPublished(); } };
  g[KEY] = true;

  let state = await readOnboarding();
  if (!state) {
    // An install from before onboarding existed: don't welcome a long-time
    // user. `POST /api/admin/onboarding/reset` brings both cards back.
    state = await updateOnboarding(() => (opts.freshInstall
      ? emptyState()
      : { setupDoneAt: Date.now(), welcome: { hidden: true, done: {} } }));
  }
  const firstBoot = !state.setupDoneAt;

  const welcome = new Welcome({ dataDir: opts.dataDir, toolchainDir: opts.toolchainDir });
  const setup = new SetupCard({
    dataDir: opts.dataDir,
    shellPort: opts.shellPort,
    firstBoot,
    onReady: () => {
      void updateOnboarding((s) => ({ ...s, setupDoneAt: s.setupDoneAt ?? Date.now() }))
        .then(() => welcome.start())
        .catch((err: unknown) => console.warn(`[onboarding] ${(err as Error).message}`));
    },
  });
  setup.start();

  return {
    afterInit() {
      setup.afterInit();
      if (!firstBoot) void welcome.start().catch((err: unknown) => console.warn(`[onboarding] ${(err as Error).message}`));
    },
  };
}

/** Tick off a welcome step from outside (e.g. a successful admin unlock). */
export async function markWelcomeStep(id: WelcomeStepId): Promise<void> {
  const w = currentWelcome();
  if (w) { await w.markDone(id); return; }
  // No record yet: this shell hasn't run startOnboarding (an install from
  // before onboarding, mid-update). Writing one now would make the next boot
  // look like a first boot.
  if (!(await readOnboarding())) return;
  await updateOnboarding((cur) => (cur.welcome.done[id]
    ? cur
    : { ...cur, welcome: { ...cur.welcome, done: { ...cur.welcome.done, [id]: Date.now() } } }));
}

/**
 * Start over: the welcome checklist comes back at once; with `setup` the
 * first-boot setup card also runs again — on the next shell boot.
 */
export async function resetOnboarding(opts: { setup?: boolean } = {}): Promise<void> {
  await updateOnboarding((s) => ({
    ...emptyState(),
    ...(opts.setup ? {} : { setupDoneAt: s.setupDoneAt ?? Date.now() }),
  }));
  if (!opts.setup) await currentWelcome()?.start();
}
