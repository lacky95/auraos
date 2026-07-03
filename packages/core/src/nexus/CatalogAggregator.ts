/**
 * CatalogAggregator — merges every registered Nexus source into one browsable
 * catalog for the app store. Supersedes the single-URL IndexClient: instead of
 * one curated index.yaml, it fans out over the sources config and combines:
 *
 *   • 'oci'       → `oras repo ls` + `oras manifest fetch :latest` per repo,
 *                   reading storefront metadata from the artifact annotations
 *                   (self-describing registry — no separate index needed).
 *   • 'git-index' → fetch/clone the repo's `index.yaml` (IndexDocument shape).
 *   • 'git-app'   → the manifest snapshot captured at registration.
 *
 * Resilience mirrors IndexClient: every source is fetched independently, never
 * throws, and falls back to its last good disk cache on failure. A per-source
 * `ok`/`error` line is reported in the result so the UI can show which sources
 * are degraded. The bundled seed (category taxonomy) is merged last.
 *
 * Merge rule: sources are visited in ascending `priority`; the FIRST source to
 * provide a given app id wins (lower priority number = higher precedence).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import type { IndexDocument, IndexEntry } from './types.js';
import { seedIndex } from './defaultIndex.js';
import { parseStoreAnnotations } from './ociMetadata.js';
import { orasFlagsForUrl, orasHostFromUrl } from './RegistryConfig.js';
import {
  DEFAULT_APP_REPO_PREFIX, sortedSources,
  type GitIndexSource, type OciSource, type SourceEntry, type SourcesConfig,
} from './SourcesConfig.js';

const CACHE_TTL_MS      = 10 * 60 * 1000;   // 10 min
const FETCH_TIMEOUT_MS  = 10_000;
const ORAS_TIMEOUT_MS   = 15_000;
const MAX_REPOS_PER_OCI = 200;              // defensive cap on N+1 fetches

/** One aggregated app, with attribution back to the source that provided it. */
export interface CatalogEntry extends IndexEntry {
  /** Name of the source (config entry) this came from. */
  sourceName: string;
  sourceKind: SourceEntry['kind'] | 'seed';
  /** Latest known version (OCI: from the artifact's version annotation). */
  version?: string;
}

/** Per-source fetch outcome, surfaced so the UI can flag degraded sources. */
export interface SourceStatus {
  name:  string;
  kind:  SourceEntry['kind'];
  ok:    boolean;
  apps:  number;
  error?: string;
}

/** The merged, browsable catalog. Additive superset of IndexDocument. */
export interface Catalog {
  schema:     number;
  apps:       CatalogEntry[];
  featured:   string[];
  categories: IndexDocument['categories'];
  sources:    SourceStatus[];
}

export interface CatalogAggregatorOpts {
  rootDataDir: string;
  /** Live getter so config changes (add/remove source) take effect without
   *  reconstructing the aggregator. */
  getSources: () => SourcesConfig;
}

export class CatalogAggregator {
  private readonly cacheDir: string;
  private readonly getSources: () => SourcesConfig;
  /** In-memory memo of the last full aggregation. */
  private memo: Catalog | null = null;

  constructor(opts: CatalogAggregatorOpts) {
    this.cacheDir   = join(opts.rootDataDir, 'nexus', 'sources');
    this.getSources = opts.getSources;
  }

  /** Aggregated catalog, using per-source disk caches when fresh. */
  async get(): Promise<Catalog> {
    if (this.memo) return this.memo;
    this.memo = await this.aggregate(false);
    return this.memo;
  }

  /** Force every source to re-fetch, bypassing caches. */
  async refresh(): Promise<Catalog> {
    this.memo = await this.aggregate(true);
    return this.memo;
  }

  /** Drop the in-memory memo (keeps disk caches) so the next `get()`
   *  re-aggregates against the current sources config. Cheap — no I/O. */
  invalidate(): void {
    this.memo = null;
  }

  /** Drop the memo + one source's disk cache so the next read re-fetches it.
   *  Called after a publish so the store reflects the new app immediately. */
  bustSource(name: string): void {
    this.memo = null;
    try {
      const p = this.cachePath(name);
      if (existsSync(p)) writeFileSync(p, JSON.stringify({ ts: 0, entries: [] }));
    } catch { /* best-effort */ }
  }

  async lookup(id: string): Promise<CatalogEntry | null> {
    const cat = await this.get();
    return cat.apps.find((a) => a.id === id) ?? null;
  }

  async search(query: string): Promise<CatalogEntry[]> {
    const cat = await this.get();
    const q = query.toLowerCase().trim();
    if (!q) return cat.apps;
    return cat.apps.filter((a) => {
      const hay = [a.id, a.name, a.description ?? '', ...(a.tags ?? [])]
        .join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  async featured(): Promise<CatalogEntry[]> {
    const cat = await this.get();
    const ids = new Set(cat.featured);
    return cat.apps.filter((a) => ids.has(a.id));
  }

  // ─── Aggregation ────────────────────────────────────────────────────────
  private async aggregate(force: boolean): Promise<Catalog> {
    const cfg = this.getSources();
    const ordered = sortedSources(cfg);

    const byId = new Map<string, CatalogEntry>();
    const featured: string[] = [];
    const statuses: SourceStatus[] = [];

    for (const src of ordered) {
      const res = await this.fetchSource(src, force);
      statuses.push({ name: src.name, kind: src.kind, ok: res.ok, apps: res.entries.length, error: res.error });
      for (const e of res.entries) {
        if (!byId.has(e.id)) byId.set(e.id, e);   // first (highest-priority) wins
      }
      for (const f of res.featured ?? []) {
        if (!featured.includes(f)) featured.push(f);
      }
    }

    // Merge the bundled seed LAST: only its categories (always) and any apps/
    // featured it declares that no live source already provided.
    const seed = seedIndex();
    for (const e of seed.apps) {
      if (!byId.has(e.id)) byId.set(e.id, { ...e, sourceName: 'seed', sourceKind: 'seed' });
    }
    for (const f of seed.featured) if (!featured.includes(f)) featured.push(f);

    // Union categories: seed taxonomy + any category slugs surfaced by apps.
    const categories = [...seed.categories];
    const catSlugs = new Set(categories.map((c) => c.slug));
    for (const e of byId.values()) {
      for (const c of e.categories ?? []) {
        if (!catSlugs.has(c)) { categories.push({ slug: c, label: titleCase(c) }); catSlugs.add(c); }
      }
    }

    return {
      schema:   1,
      apps:     [...byId.values()],
      featured: featured.filter((id) => byId.has(id)),
      categories,
      sources:  statuses,
    };
  }

  /** Fetch one source, with disk-cache fallback. Never throws. */
  private async fetchSource(
    src: SourceEntry, force: boolean,
  ): Promise<{ ok: boolean; entries: CatalogEntry[]; featured?: string[]; error?: string }> {
    if (!force) {
      const cached = this.readCache(src.name);
      if (cached) return { ok: true, entries: cached };
    }
    try {
      let entries: CatalogEntry[];
      let featured: string[] | undefined;
      switch (src.kind) {
        case 'oci':       entries = this.fetchOciCatalog(src); break;
        case 'git-index': ({ entries, featured } = await this.fetchGitIndexCatalog(src)); break;
        case 'git-app':   entries = this.fetchGitAppEntry(src); break;
      }
      this.writeCache(src.name, entries);
      return { ok: true, entries, featured };
    } catch (err) {
      const msg = (err as Error).message;
      // Degrade to stale cache when available, otherwise report empty+error.
      const stale = this.readCache(src.name, /* ignoreTtl */ true);
      if (stale) return { ok: false, entries: stale, error: `${msg} (using stale cache)` };
      return { ok: false, entries: [], error: msg };
    }
  }

  // ─── OCI source ─────────────────────────────────────────────────────────
  private fetchOciCatalog(src: OciSource): CatalogEntry[] {
    const host = orasHostFromUrl(src.url);
    const flags = orasFlagsForUrl(src.url);
    const prefix = (src.appRepoPrefix ?? DEFAULT_APP_REPO_PREFIX).replace(/\/+$/, '');

    // List repos. `oras repo ls <host>` prints one repo path per line.
    const listOut = execFileSync('oras', ['repo', 'ls', host, ...flags],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: ORAS_TIMEOUT_MS }).toString();
    const repos = listOut.split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((r) => r === prefix || r.startsWith(`${prefix}/`))
      .slice(0, MAX_REPOS_PER_OCI);

    const entries: CatalogEntry[] = [];
    for (const repo of repos) {
      try {
        const raw = execFileSync('oras', ['manifest', 'fetch', `${host}/${repo}:latest`, ...flags],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: ORAS_TIMEOUT_MS }).toString();
        const manifest = JSON.parse(raw) as { artifactType?: string; annotations?: Record<string, string> };
        // Only surface artifacts published as Aura apps.
        if (manifest.artifactType && !manifest.artifactType.startsWith('application/vnd.aura.app')) continue;
        const meta = parseStoreAnnotations(manifest.annotations);
        const id = meta.id ?? repo.slice(prefix.length + 1);
        if (!id) continue;
        entries.push({
          id,
          name:        meta.name ?? id,
          description: meta.description,
          icon:        meta.icon,
          publisher:   meta.publisher,
          homepage:    meta.homepage,
          categories:  meta.category ? [meta.category] : [],
          tags:        meta.tags ?? [],
          screenshots: meta.screenshots ?? [],
          sources:     { oci: { ref: `${host}/${repo}` } },
          sourceName:  src.name,
          sourceKind:  'oci',
          version:     meta.version,
        });
      } catch { /* skip repos that don't resolve a :latest manifest */ }
    }
    return entries;
  }

  // ─── git-index source ───────────────────────────────────────────────────
  private async fetchGitIndexCatalog(
    src: GitIndexSource,
  ): Promise<{ entries: CatalogEntry[]; featured: string[] }> {
    const doc = await loadGitIndexDoc(src);
    const entries: CatalogEntry[] = doc.apps.map((e) => ({
      ...e,
      sourceName: src.name,
      sourceKind: 'git-index' as const,
    }));
    return { entries, featured: doc.featured };
  }

  // ─── git-app source ─────────────────────────────────────────────────────
  private fetchGitAppEntry(src: import('./SourcesConfig.js').GitAppSource): CatalogEntry[] {
    const m = src.appMeta;
    if (!m) return [];
    return [{
      id:          m.id,
      name:        m.name,
      description: m.description,
      icon:        m.icon,
      categories:  m.category ? [m.category] : [],
      tags:        [],
      sources:     { git: { ref: normaliseGitRef(src.url), 'default-branch': src.ref } },
      sourceName:  src.name,
      sourceKind:  'git-app',
      version:     m.version,
    }];
  }

  // ─── Disk cache ─────────────────────────────────────────────────────────
  private cachePath(name: string): string {
    return join(this.cacheDir, `${sanitize(name)}.json`);
  }

  private readCache(name: string, ignoreTtl = false): CatalogEntry[] | null {
    const p = this.cachePath(name);
    if (!existsSync(p)) return null;
    try {
      if (!ignoreTtl) {
        const age = Date.now() - statSync(p).mtimeMs;
        if (age >= CACHE_TTL_MS) return null;
      }
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { entries?: CatalogEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : null;
    } catch {
      return null;
    }
  }

  private writeCache(name: string, entries: CatalogEntry[]): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(this.cachePath(name), JSON.stringify({ ts: Date.now(), entries }));
    } catch { /* best-effort */ }
  }
}

// ─── git-index document loading (reused by the shell validation route) ─────
/** Fetch + parse a git-index source's index.yaml. Throws on unreachable /
 *  unparseable — the aggregator catches and degrades; the POST validator
 *  surfaces the error to reject a bad registration. */
export async function loadGitIndexDoc(src: GitIndexSource): Promise<IndexDocument> {
  const text = /\.ya?ml$/i.test(src.url)
    ? await fetchYamlUrl(src.url)
    : cloneAndReadIndex(src.url, src.ref);
  return parseIndexDoc(text);
}

async function fetchYamlUrl(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function cloneAndReadIndex(url: string, ref?: string): string {
  const tmp = join('/tmp', `aura-gitindex-${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`);
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(url, tmp);
  try {
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    const p = join(tmp, 'index.yaml');
    if (!existsSync(p)) throw new Error(`no index.yaml at repo root of ${url}`);
    return readFileSync(p, 'utf-8');
  } finally {
    try { execFileSync('rm', ['-rf', tmp]); } catch { /* best-effort */ }
  }
}

function parseIndexDoc(text: string): IndexDocument {
  const raw = YAML.parse(text) as Partial<IndexDocument> | null;
  if (!raw || typeof raw !== 'object') throw new Error('index.yaml is empty or not an object');
  return {
    schema:     raw.schema ?? 1,
    apps:       Array.isArray(raw.apps)       ? raw.apps       : [],
    featured:   Array.isArray(raw.featured)   ? raw.featured   : [],
    categories: Array.isArray(raw.categories) ? raw.categories : [],
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────
function normaliseGitRef(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
