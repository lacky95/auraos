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
import type { SourceAuth } from './RegistryAuth.js';
import { readOsKey, writeOsKey } from './osKv.js';
import { DEFAULT_ENDPOINTS, infraEndpoints } from '../infra/endpoints.js';

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
  /**
   * Login for a private registry. Only the username and the Aura Context key
   * of the password — this config is readable by every app, the password is
   * sealed as an OS-only secret (RegistryAuth.ts).
   */
  auth?: SourceAuth;
}

export interface GitIndexSource extends SourceCommon {
  kind: 'git-index';
  /** Git repo URL, or a direct https URL ending in `.yaml`/`.yml`. */
  url:  string;
  /** Branch/tag/commit for the clone; default remote HEAD. */
  ref?: string;
  /**
   * The REPOSITORY behind the index, as `owner/repo`, when submissions are
   * accepted by pull request. `url` names the artifact a client fetches; this
   * names the place a new entry is proposed, which is a different thing — the
   * official index is served from a static host, not from the repo that
   * generates it. Optional: an index can be published with no submission path.
   */
  repo?: string;
}

/** Snapshot of a git-app's manifest, captured at registration + refresh so
 *  the catalog can list it without cloning on every aggregation. */
export interface GitAppMeta {
  id:           string;
  originId?:    string;
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

/** The official AuraOS store — a curated index, published from
 *  github.com/lacky95/auraos-store and served as static files. The built-in
 *  default (infra/endpoints.ts, the one place); the effective one is
 *  `officialStore()`: an infrastructure config's `endpoints.nexusIndex` replaces
 *  it (philosophy audit #7, D94). */
export const OFFICIAL_INDEX_URL = DEFAULT_ENDPOINTS.nexusIndex;

/** The repository behind that index — where `aura nexus app submit` opens its
 *  pull request. Separate constant because the index URL is a static host and
 *  says nothing about where submissions go (`endpoints.nexusStoreRepo`). */
export const OFFICIAL_STORE_REPO = DEFAULT_ENDPOINTS.nexusStoreRepo;

/** The official store as this system is configured: the infrastructure config's endpoints, else the built-in ones. */
export function officialStore(dataDir?: string): { indexUrl: string; repo: string; isPublicDefault: boolean } {
  const e = infraEndpoints(dataDir);
  return { indexUrl: e.nexusIndex, repo: e.nexusStoreRepo, isPublicDefault: !e.configured.includes('nexusIndex') };
}

/** The `official` source of a config through `officialStore()` (a stored entry keeps the built-in URL). */
function withOfficialStore(cfg: SourcesConfig): SourcesConfig {
  const off = officialStore();
  if (off.isPublicDefault && off.repo === OFFICIAL_STORE_REPO) return cfg;
  return {
    ...cfg,
    sources: cfg.sources.map((s) => (s.kind === 'git-index' && s.name === 'official' && s.url === OFFICIAL_INDEX_URL
      ? { ...s, url: off.indexUrl, ...(s.repo === OFFICIAL_STORE_REPO || s.repo === undefined ? { repo: off.repo } : {}) }
      : s)),
  };
}
export const DEFAULT_SOURCES_CONFIG: SourcesConfig = {
  schema: 1,
  sources: [
    { kind: 'oci', name: 'local', url: LOCAL_REGISTRY_DEFAULT_URL, priority: 0, mirror: false },
    // The official curated store. Priority 10 keeps `local` (0) ahead of it, so
    // an app you are building locally still shadows the published one.
    //
    // The URL ends in .yaml deliberately: CatalogAggregator.loadGitIndexDoc
    // matches /\.ya?ml$/i and fetches it directly, instead of cloning the repo
    // behind it on every aggregation.
    { kind: 'git-index', name: 'official', url: OFFICIAL_INDEX_URL, repo: OFFICIAL_STORE_REPO, priority: 10 },
  ],
};

/** Default OCI repo prefix the store lists apps under. */
export const DEFAULT_APP_REPO_PREFIX = 'aura-apps';

// ─── KV I/O ─────────────────────────────────────────────────────────────
const KV_KEY        = 'nexus/sources';
const LEGACY_KV_KEY = 'nexus/registries';

/**
 * Read the stored sources config (in process, osKv.ts). When the new key is
 * absent, migrate the legacy `os/nexus/registries` value (mapping each
 * entry → an 'oci' source) and persist it under the new key once. Falls back
 * to the default config when nothing is stored anywhere.
 */
export async function loadSourcesConfig(): Promise<SourcesConfig> {
  // 1. New key wins.
  try {
    const v = normaliseConfig(await readOsKey(KV_KEY));
    if (v) return withOfficialStore(v);
  } catch { /* fall through to migration */ }

  // 2. Migrate the legacy registries key, if present.
  const migrated = await migrateFromLegacy();
  if (migrated) {
    try { await saveSourcesConfig(migrated); } catch { /* best-effort */ }
    return migrated;
  }

  // 3. Nothing stored → default.
  return withOfficialStore(cloneDefault());
}

/** Write the whole config. Replaces any existing value. */
export async function saveSourcesConfig(cfg: SourcesConfig): Promise<void> {
  // The stored entry keeps the built-in URL: the infrastructure config maps it on every read.
  const off = officialStore();
  if (!off.isPublicDefault) {
    cfg = { ...cfg, sources: cfg.sources.map((s) => (s.kind === 'git-index' && s.name === 'official' && s.url === off.indexUrl
      ? { ...s, url: OFFICIAL_INDEX_URL, ...(s.repo === off.repo ? { repo: OFFICIAL_STORE_REPO } : {}) } : s)) };
  }
  try {
    await writeOsKey(KV_KEY, cfg);
  } catch (err) {
    throw new Error(`saveSourcesConfig: os/${KV_KEY} — ${(err as Error).message}`);
  }
}

/** Seed the default config IF nothing is stored (and nothing to migrate).
 *  Returns the resulting config. */
export async function seedSourcesConfigIfMissing(): Promise<SourcesConfig> {
  const cfg = await loadSourcesConfig();
  // loadSourcesConfig already persists on migration; persist the default too
  // so subsequent reads are stable.
  try {
    if (!normaliseConfig(await readOsKey(KV_KEY))) await saveSourcesConfig(cfg);
  } catch { /* best-effort */ }
  return cfg;
}

async function migrateFromLegacy(): Promise<SourcesConfig | null> {
  try {
    const legacy = await readOsKey(LEGACY_KV_KEY) as RegistryConfig | undefined;
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
    if (typeof e['url'] !== 'string' || !e['url']) return false;
    return e['auth'] === undefined || (e['kind'] === 'oci' && isSourceAuth(e['auth']));
  }
  return false;
}

/** `{type:'basic', username, secret}` and nothing that could be a password. */
export function isSourceAuth(x: unknown): x is SourceAuth {
  if (!x || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  return a['type'] === 'basic' && typeof a['username'] === 'string' && !!a['username']
    && typeof a['secret'] === 'string' && /^NEXUS_SRC_[A-Z0-9_]+_PASSWORD$/.test(a['secret'])
    && Object.keys(a).every((k) => k === 'type' || k === 'username' || k === 'secret');
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
