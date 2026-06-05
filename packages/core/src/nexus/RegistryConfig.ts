/**
 * Multi-registry configuration for Nexus OCI sources.
 *
 * Loaded from the shell's KV store at `os/nexus/registries`. AppManager seeds
 * a default `local` entry on first boot pointing at the in-container
 * `com.aura.registry` (zot) service. Additional registries — public mirrors,
 * customer-private registries, etc. — can be added at runtime via the
 * `/api/nexus/registries` shell route or `aura nexus registries add`.
 *
 * URL convention: store full URLs with scheme (`http://host:port`). The OCI
 * CLI (`oras`) doesn't take schemes in its refs — `orasHostFromUrl()` and
 * `orasFlagsForUrl()` strip + flag-translate before passing through.
 */
// ─── Shape ──────────────────────────────────────────────────────────────
export interface RegistryEntry {
  /** Human-readable label. Unique within the config. */
  name:     string;
  /** Full URL with scheme: 'http://aura-com.aura.registry:4001'. */
  url:      string;
  /** Lower wins. Tied priorities fall back to insertion order. */
  priority: number;
  /**
   * When true: probe this registry FIRST for ANY OCI ref before the
   * canonical host in the ref. Useful for offline LAN environments where
   * the local registry pulls-through (future) public refs.
   */
  mirror?:  boolean;
}

export interface RegistryConfig {
  registries: RegistryEntry[];
}

// ─── Defaults ───────────────────────────────────────────────────────────
/** Container-DNS hostname of the registry app. Matches the convention
 *  `aura-<sanitized-instanceId>` ContainerRunner uses. */
export const LOCAL_REGISTRY_HOST = 'aura-com.aura.registry';

/** Port the registry app's wrapper listens on. Pinned via the registry
 *  manifest's `serverPort: 4090` so AppManager always allocates the same
 *  port — without that pin, the AppManager port allocator hands out a
 *  fresh number per boot, breaking the URL we hard-code in the seeded
 *  RegistryConfig + the synth entrypoint's `aura sdk install` calls. The
 *  wrapper enforces identity headers + forwards everything to the internal
 *  zot on :5000. */
export const LOCAL_REGISTRY_DEFAULT_URL = `http://${LOCAL_REGISTRY_HOST}:4090`;

export const DEFAULT_REGISTRY_CONFIG: RegistryConfig = {
  registries: [
    { name: 'local', url: LOCAL_REGISTRY_DEFAULT_URL, priority: 0, mirror: false },
  ],
};

// ─── KV I/O ─────────────────────────────────────────────────────────────
const KV_PATH = '/api/kv/os/nexus/registries';

/** GET the stored config; returns a deep copy of DEFAULT_REGISTRY_CONFIG
 *  when the KV entry doesn't exist or the fetch fails. */
export async function loadRegistryConfig(osApiBase: string): Promise<RegistryConfig> {
  try {
    const r = await fetch(`${osApiBase}${KV_PATH}`);
    if (!r.ok) return cloneDefault();
    const body = await r.json() as { value?: unknown };
    const v = body?.value as RegistryConfig | undefined;
    if (!v || !Array.isArray(v.registries) || v.registries.length === 0) {
      return cloneDefault();
    }
    return v;
  } catch {
    return cloneDefault();
  }
}

/** PUT the whole config. Replaces any existing value. */
export async function saveRegistryConfig(osApiBase: string, cfg: RegistryConfig): Promise<void> {
  const r = await fetch(`${osApiBase}${KV_PATH}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ value: cfg }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`saveRegistryConfig: PUT ${KV_PATH} → HTTP ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Seed the default config IF nothing's stored yet. No-op when a non-empty
 *  config already exists. Returns the resulting (post-seed) config. */
export async function seedRegistryConfigIfMissing(osApiBase: string): Promise<RegistryConfig> {
  try {
    const r = await fetch(`${osApiBase}${KV_PATH}`);
    if (r.ok) {
      const body = await r.json() as { value?: unknown };
      const v = body?.value as RegistryConfig | undefined;
      if (v && Array.isArray(v.registries) && v.registries.length > 0) return v;
    }
  } catch {
    // fall through to seed
  }
  const seed = cloneDefault();
  await saveRegistryConfig(osApiBase, seed);
  return seed;
}

// ─── Lookups ────────────────────────────────────────────────────────────
/** First mirror in the config, sorted by priority. Null when none configured. */
export function pickMirror(cfg: RegistryConfig): RegistryEntry | null {
  const mirrors = cfg.registries
    .filter((e) => e.mirror)
    .sort((a, b) => a.priority - b.priority);
  return mirrors[0] ?? null;
}

/** Resolve a bare name (e.g. 'local') to its full URL. Returns null when
 *  no entry matches. Used by Publisher.publishOci to let callers write
 *  `--registry local` instead of the full URL. */
export function resolveByName(cfg: RegistryConfig, bareName: string): string | null {
  const entry = cfg.registries.find((e) => e.name === bareName);
  return entry?.url ?? null;
}

/** Sort by priority (ascending). Stable for equal priorities. */
export function sorted(cfg: RegistryConfig): RegistryEntry[] {
  return [...cfg.registries].sort((a, b) => a.priority - b.priority);
}

// ─── URL ↔ oras CLI helpers ─────────────────────────────────────────────
/** Strip scheme + trailing slash so the result is a valid `oras` host
 *  prefix: 'http://aura-com.aura.registry:4001' → 'aura-com.aura.registry:4001'. */
export function orasHostFromUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Flags `oras` needs based on the URL scheme. HTTPS hosts get nothing
 *  extra; plain-HTTP hosts need --plain-http to disable HTTPS upgrade. */
export function orasFlagsForUrl(url: string): string[] {
  return url.startsWith('http://') ? ['--plain-http'] : [];
}

function cloneDefault(): RegistryConfig {
  return JSON.parse(JSON.stringify(DEFAULT_REGISTRY_CONFIG));
}
