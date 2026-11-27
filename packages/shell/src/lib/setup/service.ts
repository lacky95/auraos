/**
 * The one way the server layer reaches the setup engine (D108,
 * core setup/contracts.ts `SetupServiceContract`). The engine is a kernel
 * module (P3, core `setup/service.ts`), built by the composition root over
 * the AppManager (`createSetupEngine`); the routes under
 * `/api/apps/<id>/setup/**`, the app list and `/api/setup/self` call it only
 * through `liveSetupService()`.
 *
 * A kernel composed without the engine answers null: every setup route
 * answers 503 `unavailable` (never a made-up success, never a fallback
 * configuration), and an app that declares setup is refused at its start
 * (contract/types.ts `setupEngineMissing`).
 */
import * as core from '@aura/core';
import type { OperationalState, SetupServiceContract } from '@aura/core';

/** The setup engine of the running kernel, or null when it has none. */
export function liveSetupService(): SetupServiceContract | null {
  try { return core.getAppManager().setup ?? null; } catch { return null; }
}

/** The answer of every setup route while there is no engine: a D105-shaped body, 503. */
export const SETUP_UNAVAILABLE = Object.freeze({
  error: 'unavailable',
  category: 'unavailable',
  message: 'the app setup engine is not available on this AuraOS',
  hint: 'update AuraOS to a release with app setup (D108); an app that declares setup or profiles is not started meanwhile',
});

/** An app's operational state for the app list: the engine's, or `unknown` when it can't be read. */
export type ListedSetupState = OperationalState | 'unknown';

/**
 * The operational state of each app that declares `setup` or `profiles`
 * (the `setupState` of `/api/apps`). Apps without either block are not in
 * the map: they are `ready` by derivation and their entry stays unchanged.
 */
export async function setupStates(
  manifests: ReadonlyArray<{ id: string; setup?: unknown; profiles?: unknown }>,
  service: SetupServiceContract | null = liveSetupService(),
): Promise<Map<string, ListedSetupState>> {
  const out = new Map<string, ListedSetupState>();
  await Promise.all(manifests.filter((m) => core.declaresSetup(m)).map(async (m) => {
    if (!service) { out.set(m.id, 'unknown'); return; }
    try {
      out.set(m.id, (await service.state(m.id)).state);
    } catch {
      out.set(m.id, 'unknown');
    }
  }));
  return out;
}
