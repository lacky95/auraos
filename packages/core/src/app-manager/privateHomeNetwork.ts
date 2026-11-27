/**
 * D107 / owner confirmation D9: a Private Home only where network isolation
 * is guaranteed. An instance that runs with a user's Private Home (today the
 * System Terminal's session context, D69; D107-a's `home.private` grant
 * later) holds that user's logins, so nothing of it may listen where an
 * unrelated app can call it. It is refused (D105 shape, fail closed) when
 *   - any of its sidecars would listen on the shared app network
 *     (`services[].network` resolving to `shared`), or
 *   - its runtime does not isolate associated workloads per instance
 *     (`network.isolation` `workloadIsolation: instance`).
 * The authenticated App Host / gateway routes to the app itself are
 * explicitly authorized and are never counted as shared listeners.
 *
 * Pure: the start gate (`AppManager.spawnContext`) and the sidecar spawn
 * (`SidecarManager`) both ask it.
 */
import type { AppManifest } from '../types/manifest.js';
import { requireNetworkIsolation, type RuntimeModule } from '../runtimes/ari.js';
import { RuntimeFeatureError } from '../runtimes/types.js';

/** The network a `services[]` template's sidecars get (the default of sidecar-spec.ts `resolveSidecarSpec`). */
export function templateNetwork(t: { network?: 'instance' | 'shared'; inheritHome?: boolean }): 'instance' | 'shared' {
  return t.network ?? (t.inheritHome ? 'instance' : 'shared');
}

/**
 * Throws `RuntimeFeatureError` (`feature-unsupported`; `missing` names the
 * offending `services[<name>].network` or `network.isolation.instance`;
 * `hint`) unless an instance of `manifest` with a Private Home keeps every
 * sidecar off the shared network on `module`.
 */
export function requirePrivateHomeIsolation(
  appId: string, manifest: Pick<AppManifest, 'services'>,
  module: Pick<RuntimeModule, 'descriptor' | 'capabilities' | 'featureOverrides'>,
  others: ReadonlyArray<Pick<RuntimeModule, 'descriptor' | 'capabilities' | 'featureOverrides' | 'workloads'>> = [],
): void {
  const shared = (manifest.services ?? []).filter((s) => templateNetwork(s) === 'shared').map((s) => s.name);
  if (shared.length) {
    throw new RuntimeFeatureError(module.descriptor.id, shared.map((n) => `services[${n}].network`),
      `${appId} runs with a Private Home, and its sidecar${shared.length > 1 ? 's' : ''} ${shared.join(', ')} would listen on the shared app network: `
        + 'not started (a Private Home only where network isolation is guaranteed, D107)',
      [],
      `declare "network": "instance" for ${shared.map((n) => `services[${n}]`).join(', ')} in app.manifest.json; its own App Host / gateway routes stay as they are`);
  }
  requireNetworkIsolation(module, {}, 'instance', others);
}

/** At a sidecar spawn: the parent runs with a Private Home and the sidecar would be shared. */
export function privateHomeSidecarRefusal(runtime: string, appId: string, sidecar: string, network: 'instance' | 'shared'): RuntimeFeatureError | null {
  if (network === 'instance') return null;
  return new RuntimeFeatureError(runtime, [`services[${sidecar}].network`],
    `${appId} runs with a Private Home, so its sidecar ${sidecar} can't listen on the shared app network: not created (D107)`,
    [], `declare "network": "instance" for services[${sidecar}] in app.manifest.json`);
}
