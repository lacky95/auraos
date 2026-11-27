// Resource limits of the release builder's throwaway containers (D106): the
// dependency-free twin of core `runtimes/container/limits.ts`. The builder runs
// without a built core (install.sh, the runner image), so it cannot import it;
// same names, same mapping, same validation, and packages/core/test/
// builder-limits.test.mjs compares both on one table. Change them together.
//
//   cpus         → --cpus=<n>
//   memoryBytes  → --memory=<bytes> --memory-swap=<bytes>   (no swap beyond memory)
//   pids         → --pids-limit=<n>
//
// The shape is ARI's `resources.limits` ({ cpus?, memoryBytes?, pids? }, plain
// data); there is no second, Docker-specific limits mechanism.

const GiB = 1024 * 1024 * 1024;

/** The stable code of an invalid limits record. */
export const INVALID_RESOURCE_LIMITS = 'invalid-resource-limits';

export class ResourceLimitsError extends Error {
  constructor(message) { super(message); this.name = 'ResourceLimitsError'; this.code = INVALID_RESOURCE_LIMITS; }
}

/** = core DEFAULT_BUILD_LIMITS: an app build or dependency install (2 CPUs, 3 GiB, 512 pids). */
export const DEFAULT_BUILD_LIMITS = Object.freeze({ cpus: 2, memoryBytes: 3 * GiB, pids: 512 });

/** The check mode (D106 item 1): package suites, typechecks, lint and builds of a worktree. */
export const DEFAULT_CHECK_LIMITS = Object.freeze({ cpus: 4, memoryBytes: 6 * GiB, pids: 2048 });

/** The release build's deps/build/check containers: the caps they always had (2 CPUs, 6 GiB, 2048 pids), now without swap beyond memory. */
export const RELEASE_BUILD_LIMITS = Object.freeze({ cpus: 2, memoryBytes: 6 * GiB, pids: 2048 });

const KEYS = new Set(['cpus', 'memoryBytes', 'pids']);

/** Throws ResourceLimitsError unless `l` is a valid limits record (positive, finite; integer bytes and pids). */
export function validateLimits(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) throw new ResourceLimitsError('resource limits must be an object {cpus?, memoryBytes?, pids?}');
  for (const [k, v] of Object.entries(l)) {
    if (!KEYS.has(k)) throw new ResourceLimitsError(`unknown resource limit '${k}' (cpus, memoryBytes, pids)`);
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new ResourceLimitsError(`${k} must be a positive finite number`);
    if (k !== 'cpus' && !Number.isInteger(v)) throw new ResourceLimitsError(`${k} must be a positive integer`);
  }
}

/** The Docker flags of `l` (validated; an absent limit adds nothing). */
export function limitArgs(l) {
  validateLimits(l);
  const out = [];
  if (l.cpus !== undefined) out.push(`--cpus=${l.cpus}`);
  if (l.memoryBytes !== undefined) out.push(`--memory=${l.memoryBytes}`, `--memory-swap=${l.memoryBytes}`);
  if (l.pids !== undefined) out.push(`--pids-limit=${l.pids}`);
  return out;
}

/** CLI sizes: bytes, or a k/m/g suffix in binary units (`6g` = 6 GiB). Returns NaN when unreadable (validateLimits refuses it). */
export function parseBytes(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])?i?b?$/i.exec(String(s).trim());
  if (!m) return NaN;
  const mul = { k: 1024, m: 1024 ** 2, g: GiB }[m[2]?.toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mul);
}
