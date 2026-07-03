/**
 * Nexus source configuration — the set of catalogs/registries the app store
 * aggregates and that `aura nexus app publish` can target.
 *
 * Persisted in the shell KV store at `os/nexus/sources`. Supersedes the older
 * `os/nexus/registries` (RegistryConfig) key, which only modelled OCI pull
 * registries. `loadSourcesConfig` migrates the legacy key on first read so no
 * data is lost. `ociRegistryView` derives the legacy shape on demand for the
 * Resolver (mirror probing) and Publisher (bare-name → URL) which still speak
 * RegistryConfig.
 *
 * A source is exactly ONE strict kind — the store never guesses:
 *   • 'oci'       — an OCI registry. Its catalog is self-describing: apps are
 *                   pushed as annotated artifacts under `aura-apps/<id>` and
 *                   read back via `oras`. Can also be a pull mirror.
 *   • 'git-index' — a git repo (or a direct *.yaml URL) hosting an `index.yaml`
 *                   that lists MANY apps. Contains no app source itself.
 *   • 'git-app'   — a git repo that IS a single app (manifest at its root).
 *
 * Two distribution forms follow from the kinds: OCI artifact (from an 'oci'
 * source or an index entry's `sources.oci`) and direct git repo (a 'git-app'
 * source or an index entry's `sources.git`).
 */
import {
  DEFAULT_REGISTRY_CONFIG, LOCAL_REGISTRY_DEFAULT_URL,
  type RegistryConfig, type RegistryEntry,
} from './RegistryConfig.js';

// ─── Shape ──────────────────────────────────────────────────────────────
export type SourceKind = 'oci' | 'git-index' | 'git-app';

interface SourceCommon {
  /** Unique label across ALL sources (any kind). */
  name:     string;
  /** Lower wins on app-id dedup during aggregation. */
  priority: number;
}

export interface OciSource extends SourceCommon {
  kind: 'oci';
  /** Full URL with scheme: 'http://aura-com.aura.registry:4090'. */
  url:  string;
  /** Probe this registry first for ANY OCI ref (offline LAN mirror). */
  mirror?: boolean;
  /** OCI repo prefix the store lists apps under. Default 'aura-apps'. */
  appRepoPrefix?: string;
}

export interface GitIndexSource extends SourceCommon {
  kind: 'git-index';
  /** Git repo URL, or a direct https URL ending in `.yaml`/`.yml`. */
  url:  string;
  /** Branch/tag/commit for the clone; default remote HEAD. */
  ref?: string;
}

/** Snapshot of a git-app's manifest, captured at registration + refresh so
 *  the catalog can list it without cloning on every aggregation. */
export interface GitAppMeta {
  id:           string;
  name:         string;
  version:      string;
  description?: string;
  icon?:        string;
  category?:    string;
}

export interface GitAppSource extends SourceCommon {
  kind: 'git-app';
  /** Git repo URL whose root holds one app.manifest.json. */
  url:  string;
  ref?: string;
  appMeta?: GitAppMeta;
}

export type SourceEntry = OciSource | GitIndexSource | GitAppSource;

export interface SourcesConfig {
  schema:  1;
  sources: SourceEntry[];
}

// ─── Defaults ───────────────────────────────────────────────────────────
export const DEFAULT_SOURCES_CONFIG: SourcesConfig = {
  schema: 1,
  sources: [
    { kind: 'oci', name: 'local', url: LOCAL_REGISTRY_DEFAULT_URL, priority: 0, mirror: false },
  ],
};

/** Default OCI repo prefix the store lists apps under. */
export const DEFAULT_APP_REPO_PREFIX = 'aura-apps';

// ─── KV I/O ─────────────────────────────────────────────────────────────
const KV_PATH        = '/api/kv/os/nexus/sources';
const LEGACY_KV_PATH = '/api/kv/os/nexus/registries';

/**
 * GET the stored sources config. When the new key is absent, migrate the
 * legacy `os/nexus/registries` value (mapping each entry → an 'oci' source)
 * and persist it under the new key once. Falls back to the default config
 * when nothing is stored anywhere.
 */
export async function loadSourcesConfig(osApiBase: string): Promise<SourcesConfig> {
  // 1. New key wins.
  try {
    const r = await fetch(`${osApiBase}${KV_PATH}`);
    if (r.ok) {
      const body = await r.json() as { value?: unknown };
      const v = normaliseConfig(body?.value);
      if (v) return v;
    }
  } catch { /* fall through to migration */ }

  // 2. Migrate the legacy registries key, if present.
  const migrated = await migrateFromLegacy(osApiBase);
  if (migrated) {
    try { await saveSourcesConfig(osApiBase, migrated); } catch { /* best-effort */ }
    return migrated;
  }

  // 3. Nothing stored → default.
  return cloneDefault();
}

/** PUT the whole config. Replaces any existing value. */
export async function saveSourcesConfig(osApiBase: string, cfg: SourcesConfig): Promise<void> {
  const r = await fetch(`${osApiBase}${KV_PATH}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ value: cfg }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`saveSourcesConfig: PUT ${KV_PATH} → HTTP ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Seed the default config IF nothing is stored (and nothing to migrate).
 *  Returns the resulting config. */
export async function seedSourcesConfigIfMissing(osApiBase: string): Promise<SourcesConfig> {
  const cfg = await loadSourcesConfig(osApiBase);
  // loadSourcesConfig already persists on migration; persist the default too
  // so subsequent reads are stable.
  try {
    const r = await fetch(`${osApiBase}${KV_PATH}`);
    const exists = r.ok && normaliseConfig((await r.json() as { value?: unknown })?.value);
    if (!exists) await saveSourcesConfig(osApiBase, cfg);
  } catch { /* best-effort */ }
  return cfg;
}

async function migrateFromLegacy(osApiBase: string): Promise<SourcesConfig | null> {
  try {
    const r = await fetch(`${osApiBase}${LEGACY_KV_PATH}`);
    if (!r.ok) return null;
    const body = await r.json() as { value?: unknown };
    const legacy = body?.value as RegistryConfig | undefined;
    if (!legacy || !Array.isArray(legacy.registries) || legacy.registries.length === 0) return null;
    const sources: SourceEntry[] = legacy.registries.map((e) => ({
      kind:     'oci' as const,
      name:     e.name,
      url:      e.url,
      priority: e.priority,
      mirror:   e.mirror ?? false,
    }));
    return { schema: 1, sources };
  } catch {
    return null;
  }
}

// ─── Validation ─────────────────────────────────────────────────────────
/** Shape-check a single entry (structural; content validation — reachability,
 *  manifest presence — is the shell route's job on POST). */
export function isSourceEntry(x: unknown): x is SourceEntry {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  if (typeof e['name'] !== 'string' || !e['name']) return false;
  if (typeof e['priority'] !== 'number') return false;
  if (e['kind'] === 'oci' || e['kind'] === 'git-index' || e['kind'] === 'git-app') {
    return typeof e['url'] === 'string' && !!e['url'];
  }
  return false;
}

function normaliseConfig(value: unknown): SourcesConfig | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { schema?: unknown; sources?: unknown };
  if (!Array.isArray(v.sources) || v.sources.length === 0) return null;
  const sources = v.sources.filter(isSourceEntry);
  if (sources.length === 0) return null;
  return { schema: 1, sources };
}

// ─── Lookups / views ────────────────────────────────────────────────────
/** Sources sorted by priority (ascending, stable). */
export function sortedSources(cfg: SourcesConfig): SourceEntry[] {
  return [...cfg.sources].sort((a, b) => a.priority - b.priority);
}

/** The 'oci'-kind sources only. */
export function ociSources(cfg: SourcesConfig): OciSource[] {
  return cfg.sources.filter((s): s is OciSource => s.kind === 'oci');
}

/** Find a source by (unique) name. */
export function findSource(cfg: SourcesConfig, name: string): SourceEntry | null {
  return cfg.sources.find((s) => s.name === name) ?? null;
}

/**
 * Derive the legacy RegistryConfig from the 'oci' sources so Resolver +
 * Publisher (which speak RegistryConfig) keep working unchanged. Falls back
 * to DEFAULT_REGISTRY_CONFIG when no oci source exists.
 */
export function ociRegistryView(cfg: SourcesConfig): RegistryConfig {
  const registries: RegistryEntry[] = ociSources(cfg).map((s) => ({
    name:     s.name,
    url:      s.url,
    priority: s.priority,
    mirror:   s.mirror ?? false,
  }));
  if (registries.length === 0) return JSON.parse(JSON.stringify(DEFAULT_REGISTRY_CONFIG));
  return { registries };
}

function cloneDefault(): SourcesConfig {
  return JSON.parse(JSON.stringify(DEFAULT_SOURCES_CONFIG));
}
