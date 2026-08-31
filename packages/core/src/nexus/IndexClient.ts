/**
 * Curated Nexus index client. Fetches `index.yaml` from a configurable
 * repo URL (defaults to `github.com/aura-os/nexus-index`), caches the
 * deserialised result on disk, refreshes on demand + every 6 hours.
 *
 * The index is OPTIONAL — when the repo is unreachable, the cache is
 * empty, or the schema is wrong, all methods fall back to the bundled
 * seed (`defaultIndex.ts`: category taxonomy, no apps) instead of
 * throwing. URL install + Git install still work without it.
 *
 * YAML over JSON to match the existing tools-registry pattern at
 * `packages/aura-cli/src/registry-defaults.yaml`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as YAML from 'yaml';
import type { IndexDocument, IndexEntry } from './types.js';
import { seedIndex } from './defaultIndex.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 6h
const FETCH_TIMEOUT_MS = 10_000;

// NOTE: this class is exported but never constructed — bare-id resolution goes
// through CatalogAggregator.lookup(), not here. The URL used to point at
// aura-os/nexus-index, a repository that never existed; it now names the real
// store so reviving this does not send anyone to a dead host.
const DEFAULT_INDEX_URL = 'https://nexus.aura.lakner.io/index.yaml';

export interface IndexClientOpts {
  /** Override the upstream URL (env: `AURA_NEXUS_INDEX_URL`). */
  url?:      string;
  /** Where to cache. Defaults to `<dataDir>/nexus/index.yaml`. */
  cachePath: string;
}

export class IndexClient {
  private readonly url: string;
  private readonly cachePath: string;
  /** In-memory cache so repeated reads inside one request don't re-parse. */
  private memo: IndexDocument | null = null;

  constructor(opts: IndexClientOpts) {
    this.url = opts.url
      ?? process.env['AURA_NEXUS_INDEX_URL']
      ?? DEFAULT_INDEX_URL;
    this.cachePath = opts.cachePath;
  }

  /** Read the cached index, refreshing if stale. Never throws. */
  async get(): Promise<IndexDocument> {
    if (this.memo) return this.memo;
    if (this.cacheFresh()) {
      try {
        const text = readFileSync(this.cachePath, 'utf-8');
        this.memo = parseIndex(text);
        return this.memo;
      } catch { /* fall through to refresh */ }
    }
    return this.refresh();
  }

  /** Force a refresh from the upstream URL, regardless of cache age. */
  async refresh(): Promise<IndexDocument> {
    let text: string;
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      console.warn(`[NexusIndex] refresh failed (${(err as Error).message}); using stale cache or seed index`);
      // Fall back to whatever's cached, otherwise the bundled seed.
      if (existsSync(this.cachePath)) {
        try {
          const cached = readFileSync(this.cachePath, 'utf-8');
          this.memo = parseIndex(cached);
          return this.memo;
        } catch { /* corrupt cache */ }
      }
      this.memo = seedIndex();
      return this.memo;
    }
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, text);
    this.memo = parseIndex(text);
    return this.memo;
  }

  /** Lookup a single app entry by id; null when absent. */
  async lookup(id: string): Promise<IndexEntry | null> {
    const doc = await this.get();
    return doc.apps.find((a) => a.id === id) ?? null;
  }

  /** Simple substring search across id + name + description + tags. */
  async search(query: string): Promise<IndexEntry[]> {
    const doc = await this.get();
    const q = query.toLowerCase().trim();
    if (!q) return doc.apps;
    return doc.apps.filter((a) => {
      const hay = [a.id, a.name, a.description ?? '', ...(a.tags ?? [])]
        .join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  /** Featured entries for the Nexus app's home page. */
  async featured(): Promise<IndexEntry[]> {
    const doc = await this.get();
    const ids = new Set(doc.featured);
    return doc.apps.filter((a) => ids.has(a.id));
  }

  private cacheFresh(): boolean {
    if (!existsSync(this.cachePath)) return false;
    try {
      const age = Date.now() - statSync(this.cachePath).mtimeMs;
      return age < CACHE_TTL_MS;
    } catch {
      return false;
    }
  }
}

function parseIndex(text: string): IndexDocument {
  try {
    const raw = YAML.parse(text) as Partial<IndexDocument> | null;
    if (!raw || typeof raw !== 'object') return seedIndex();
    return {
      schema:     raw.schema ?? 1,
      apps:       Array.isArray(raw.apps)       ? raw.apps       : [],
      featured:   Array.isArray(raw.featured)   ? raw.featured   : [],
      categories: Array.isArray(raw.categories) ? raw.categories : [],
    };
  } catch (err) {
    console.warn(`[NexusIndex] parse failed: ${(err as Error).message}; falling back to seed`);
    return seedIndex();
  }
}
