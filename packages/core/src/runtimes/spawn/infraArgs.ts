/**
 * The D94 infrastructure defaults reaching a workload (H5-1 seam, IC-5): the non-secret render
 * (CA bundle, npmrc, pip/uv/git config) read-only at /etc/aura/infra, and its env (proxy without
 * credentials, NO_PROXY, the CA and config pointers). What a start gets is decided by the kernel
 * (`SpawnContext.infra`, AppManager: the rendered config and D64 `infra-inherit`); the runtimes
 * only turn it into argv. No config (or `infra-inherit=none`): nothing at all, the argv is
 * byte-identical to today's (golden spawn args; D94 acceptance 6). Never a credential (O4).
 */
import { join } from 'node:path';
import type { InfraSpawnView } from '../../infra/types.js';
import { INFRA_ROOT } from '../../infra/types.js';

/** NO_PROXY/no_proxy with this workload's own internal names (its container, its sidecars). */
export function infraEnvFor(infra: InfraSpawnView | null | undefined, noProxyExtra: readonly string[] = []): Record<string, string> {
  if (!infra) return {};
  const env = { ...infra.env };
  for (const k of ['NO_PROXY', 'no_proxy']) {
    if (env[k] === undefined || !noProxyExtra.length) continue;
    env[k] = [...new Set([...env[k]!.split(',').filter(Boolean), ...noProxyExtra])].join(',');
  }
  return env;
}

/** Container: the read-only render at /etc/aura/infra (a subpath of the app-data volume) and its env. */
export function containerInfraArgs(o: { infra?: InfraSpawnView | null; appDataVolume: string; noProxyExtra?: readonly string[] }): string[] {
  if (!o.infra) return [];
  return [
    '--mount', `type=volume,source=${o.appDataVolume},target=${INFRA_ROOT},volume-subpath=${o.infra.subpath},readonly`,
    ...Object.entries(infraEnvFor(o.infra, o.noProxyExtra)).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  ];
}

/** PRoot: the render bound at /etc/aura/infra (the master's data dir). */
export function prootInfraBinds(o: { infra?: InfraSpawnView | null; dataDir: string }): string[] {
  return o.infra ? [`--bind=${join(o.dataDir, o.infra.subpath)}:${INFRA_ROOT}`] : [];
}

/** A sidecar (a foreign image, no render mounted): the proxy env only, never a file pointer. */
export function sidecarInfraEnv(infra: InfraSpawnView | null | undefined, noProxyExtra: readonly string[] = []): Record<string, string> {
  const env = infraEnvFor(infra, noProxyExtra);
  return Object.fromEntries(Object.entries(env).filter(([k]) => /^(https?_proxy|no_proxy)$/i.test(k)));
}
