/**
 * Resource limits on the container runtime (D106): the ONE mapping from the
 * runtime-independent `ResourceLimits` (ari.ts, `resources.limits`) to Docker
 * flags, for build and check workloads. App instances stay `unsupported`
 * until BT-M2 quotas.
 *
 *   cpus         → --cpus=<n>
 *   memoryBytes  → --memory=<bytes> --memory-swap=<bytes>   (no swap beyond memory)
 *   pids         → --pids-limit=<n>
 *
 * Pure and dependency-free on purpose: the Phase 6 release builder's check
 * mode (os/release, a .mjs that cannot import core) keeps a twin of
 * `limitArgs`, and a test compares both over one table. Keep this name, this
 * file and this mapping stable.
 */
import type { ResourceLimits } from '../ari.js';

/** The stable code of an invalid limits record. */
export const INVALID_RESOURCE_LIMITS = 'invalid-resource-limits';

export class ResourceLimitsError extends Error {
  override readonly name = 'ResourceLimitsError';
  readonly code = INVALID_RESOURCE_LIMITS;
}

/**
 * The limits profile of an app build or dependency install when the caller
 * names none (the caps those builder containers always had: 2 CPUs, 3 GiB
 * with no swap beyond it, 512 processes).
 */
export const DEFAULT_BUILD_LIMITS: Readonly<Required<ResourceLimits>> = Object.freeze({
  cpus: 2,
  memoryBytes: 3 * 1024 * 1024 * 1024,
  pids: 512,
});

const KEYS = new Set(['cpus', 'memoryBytes', 'pids']);

/** Throws `ResourceLimitsError` unless `l` is a valid limits record (positive, finite; integer bytes and pids). */
export function validateLimits(l: unknown): asserts l is ResourceLimits {
  if (!l || typeof l !== 'object' || Array.isArray(l)) throw new ResourceLimitsError('resource limits must be an object {cpus?, memoryBytes?, pids?}');
  for (const [k, v] of Object.entries(l)) {
    if (!KEYS.has(k)) throw new ResourceLimitsError(`unknown resource limit '${k}' (cpus, memoryBytes, pids)`);
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new ResourceLimitsError(`${k} must be a positive finite number`);
    if (k !== 'cpus' && !Number.isInteger(v)) throw new ResourceLimitsError(`${k} must be a positive integer`);
  }
}

/** The Docker flags of `l` (validated; an absent limit adds nothing). */
export function limitArgs(l: ResourceLimits): string[] {
  validateLimits(l);
  const out: string[] = [];
  if (l.cpus !== undefined) out.push(`--cpus=${l.cpus}`);
  if (l.memoryBytes !== undefined) out.push(`--memory=${l.memoryBytes}`, `--memory-swap=${l.memoryBytes}`);
  if (l.pids !== undefined) out.push(`--pids-limit=${l.pids}`);
  return out;
}
