/**
 * `buildSpawnSpec()` (5b-2 D, ARI §2.3): the one place a start's `SpawnSpec`
 * is assembled from what the kernel resolved, and the one place the A4 rule
 * is applied (D85): a runtime without `hostFilesystem` never receives a host
 * path. Its `appDir` and `instanceDataDir` are empty and its home has no
 * `hostPath`; everything else (identity, env, Context, the token) is data
 * every runtime gets. A runtime with `hostFilesystem` (every built-in) gets
 * the spec exactly as resolved, so golden argv is unchanged.
 *
 * Plain data in and out (D97): the spec is what a runtime module receives,
 * and what an out-of-process provider would be sent.
 */
import type { AppManifest } from '../types/manifest.js';
import type { SpawnContext } from '../scopes/types.js';
import type { SpawnSpec } from './ari.js';
import type { RuntimeCapabilities } from './types.js';

export interface SpawnSpecInput {
  instanceId: string;
  appId: string;
  port: number;
  manifest: AppManifest;
  /** What the kernel resolved for this start (paths, home, identity, env, Context, token, source mode). */
  context: SpawnContext & { owner?: string };
}

/** The spec of one start, under the runtime's capabilities (A4). */
export function buildSpawnSpec(input: SpawnSpecInput, caps: Pick<RuntimeCapabilities, 'hostFilesystem'>): SpawnSpec {
  const { context } = input;
  const spec: SpawnSpec = { ...context, instanceId: input.instanceId, appId: input.appId, port: input.port, manifest: input.manifest };
  if (caps.hostFilesystem) return spec;
  return {
    ...spec,
    appDir: '',
    instanceDataDir: '',
    ...(spec.home ? { home: { ...spec.home, hostPath: null } } : {}),
  };
}

/** The runner's part of a spec (today's `SandboxRunner.spawn` context): the spec without its addressing fields. */
export function runnerContextOf(spec: SpawnSpec): SpawnContext & { owner?: string } {
  const { instanceId: _i, appId: _a, port: _p, manifest: _m, ...ctx } = spec;
  return ctx;
}
