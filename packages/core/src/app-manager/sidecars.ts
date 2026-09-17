import type { ResourceUsage, SidecarInfo, SidecarState } from '../types/instance.js';

/**
 * Container-backend encoding of the OS sidecar concept.
 *
 * A sidecar is a runtime an app brings up next to itself (a database, a
 * headless browser, a model server). The OS model (`SidecarInfo`) is
 * backend-neutral; for the container backend a sidecar is any container
 * labelled `aura.parent=<instanceId>` / `aura.app=<appId>` /
 * `aura.service=<name>` — the labels the app SDK's `createSidecars` stamps.
 *
 * Pure helpers live here so they can be unit-tested without docker.
 */

/** `docker ps` Go template — tab-separated so label values can't break parsing. */
export const SIDECAR_PS_FORMAT =
  '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.CreatedAt}}' +
  '\t{{.Label "aura.parent"}}\t{{.Label "aura.app"}}\t{{.Label "aura.service"}}\t{{.Label "aura.mount"}}';

/** `docker stats` Go template. */
export const USAGE_STATS_FORMAT = '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}';

function mapDockerState(state: string): SidecarState {
  switch (state) {
    case 'running':    return 'running';
    case 'created':
    case 'restarting': return 'starting';
    case 'exited':
    case 'paused':     return 'stopped';
    case 'dead':
    case 'removing':   return 'error';
    default:           return 'unknown';
  }
}

/**
 * Parse `docker ps -a --filter label=aura.parent --format SIDECAR_PS_FORMAT`.
 * Skips MountManager's throwaway helpers (`aura.mount=1`): they share the
 * `aura.parent` label but are OS plumbing, not app sidecars.
 */
export function parseSidecarPs(out: string): SidecarInfo[] {
  const result: SidecarInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [id, name, image, state, createdAt, parent, appId, service, mount] = line.split('\t');
    if (!id || !name || !parent) continue;
    if (mount) continue;
    result.push({
      id: name,
      service: service || name,
      parentInstanceId: parent,
      appId: appId || parent,
      backend: 'container',
      state: mapDockerState(state ?? ''),
      image: image || undefined,
      createdAt: createdAt || undefined,
    });
  }
  return result;
}

/**
 * Sidecars whose parent has been absent from `live` on at least `graceTicks`
 * consecutive checks. `absentSince` carries the per-sidecar miss counter
 * between calls and is updated in place (entries for present or vanished
 * sidecars are dropped). `graceTicks = 1` reaps on the first miss.
 */
export function selectOrphanSidecars(
  sidecars: SidecarInfo[],
  live: ReadonlySet<string>,
  absentSince: Map<string, number>,
  graceTicks: number,
): SidecarInfo[] {
  const orphans: SidecarInfo[] = [];
  const seen = new Set<string>();
  for (const s of sidecars) {
    seen.add(s.id);
    if (live.has(s.parentInstanceId)) { absentSince.delete(s.id); continue; }
    const misses = (absentSince.get(s.id) ?? 0) + 1;
    absentSince.set(s.id, misses);
    if (misses >= graceTicks) orphans.push(s);
  }
  for (const id of Array.from(absentSince.keys())) {
    if (!seen.has(id)) absentSince.delete(id);
  }
  return orphans;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** "172.2MiB" → bytes; null when unparseable. */
export function parseByteSize(text: string): number | null {
  const m = /^\s*([\d.]+)\s*([a-zA-Z]+)\s*$/.exec(text);
  if (!m) return null;
  const unit = SIZE_UNITS[m[2]!.toLowerCase()];
  const n = Number(m[1]);
  return unit && Number.isFinite(n) ? Math.round(n * unit) : null;
}

/** Parse `docker stats --no-stream --format USAGE_STATS_FORMAT` into name → usage. */
export function parseUsageStats(out: string): Map<string, ResourceUsage> {
  const usage = new Map<string, ResourceUsage>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, mem, cpu] = line.split('\t');
    if (!name) continue;
    const cpuPct = Number((cpu ?? '').replace('%', ''));
    usage.set(name, {
      memBytes: parseByteSize((mem ?? '').split('/')[0] ?? ''),
      cpuPct: cpu && Number.isFinite(cpuPct) ? cpuPct : null,
    });
  }
  return usage;
}
