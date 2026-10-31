/**
 * The app list of an OCI source, kept IN the registry — for registries that
 * don't answer `/v2/_catalog` (GitLab, GHCR, Harbor for non-admins, ECR …).
 *
 *   <host>/<appRepoPrefix>/catalog:latest
 *     artifactType  application/vnd.aura.catalog.v1+json
 *     layer         catalog.json = { schema: 1, apps: [{ id, repo, version, updatedAt }] }
 *
 * `publishOci` upserts the app it just pushed; the CatalogAggregator reads it
 * and merges it with `oras repo ls` where that works. The list only names
 * repos: each app is still read with the viewer's own login, so a customer
 * who may pull three of ten apps sees three. Nothing secret is in it.
 *
 * `catalog` can't collide with an app: app ids are reverse-domain (`a.b.c`).
 * On GitLab the repo is a project of its own (`<group>/catalog`) — create it
 * once, like every app project.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactTypeOf, orasPushArtifact, orasSync, type RegistryLogin } from './RegistryAuth.js';

export const CATALOG_REPO          = 'catalog';
export const CATALOG_TAG           = 'latest';
export const CATALOG_ARTIFACT_TYPE = 'application/vnd.aura.catalog.v1+json';
const CATALOG_LAYER_TYPE           = 'application/vnd.aura.catalog.v1+json';
const ORAS_TIMEOUT_MS              = 20_000;
const MAX_APPS                     = 1000;
const APP_ID                       = /^[a-z0-9][a-z0-9._-]*$/i;

export interface CatalogApp {
  id:         string;
  /** Repo path on the host, always `<appRepoPrefix>/<something>`. */
  repo:       string;
  version?:   string;
  updatedAt?: string;
}

export interface CatalogDoc { schema: 1; apps: CatalogApp[] }

/** Where a source's catalog lives. */
export interface CatalogTarget { host: string; prefix: string; flags: string[] }

export function catalogRepo(prefix: string): string {
  return `${prefix.replace(/\/+$/, '')}/${CATALOG_REPO}`;
}

/** Validate a catalog document; drops entries outside the prefix. */
export function parseCatalog(raw: unknown, prefix: string): CatalogDoc {
  const p = prefix.replace(/\/+$/, '');
  const apps: CatalogApp[] = [];
  const list = raw && typeof raw === 'object' ? (raw as { apps?: unknown }).apps : undefined;
  if (Array.isArray(list)) {
    const seen = new Set<string>();
    for (const a of list.slice(0, MAX_APPS)) {
      if (!a || typeof a !== 'object') continue;
      const { id, repo, version, updatedAt } = a as Record<string, unknown>;
      if (typeof id !== 'string' || !APP_ID.test(id) || seen.has(id)) continue;
      if (typeof repo !== 'string' || !repo.startsWith(`${p}/`) || repo === catalogRepo(p) || repo.includes('..')) continue;
      seen.add(id);
      apps.push({
        id, repo,
        ...(typeof version === 'string' ? { version } : {}),
        ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
      });
    }
  }
  return { schema: 1, apps };
}

/**
 * The source's catalog, or null when it has none / can't be read with this
 * login. Never throws — a missing catalog is the normal case for registries
 * that list themselves.
 */
export function readOciCatalog(t: CatalogTarget, login?: RegistryLogin): CatalogDoc | null {
  const ref = `${t.host}/${catalogRepo(t.prefix)}`;
  try {
    const manifest = JSON.parse(orasSync(['manifest', 'fetch', `${ref}:${CATALOG_TAG}`, ...t.flags],
      { timeout: ORAS_TIMEOUT_MS }, login).toString()) as {
        artifactType?: string; annotations?: Record<string, string>; config?: { mediaType?: string };
        layers?: Array<{ digest?: string; mediaType?: string }>;
      };
    if (artifactTypeOf(manifest) !== CATALOG_ARTIFACT_TYPE) return null;
    const digest = manifest.layers?.find((l) => l.mediaType === CATALOG_LAYER_TYPE)?.digest ?? manifest.layers?.[0]?.digest;
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) return null;
    const blob = orasSync(['blob', 'fetch', `${ref}@${digest}`, '--output', '-', ...t.flags],
      { timeout: ORAS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, login).toString();
    return parseCatalog(JSON.parse(blob), t.prefix);
  } catch { return null; }
}

/** Put (or refresh) one app in the catalog. Throws when the push fails. */
export function upsertOciCatalog(t: CatalogTarget, app: CatalogApp, dataDir: string): CatalogDoc {
  const cur = readOciCatalog(t) ?? { schema: 1 as const, apps: [] };
  const next = parseCatalog({ apps: [...cur.apps.filter((a) => a.id !== app.id), app] }, t.prefix);
  next.apps.sort((a, b) => a.id.localeCompare(b.id));
  const stage = join(dataDir, 'nexus', 'catalog-staging', `${t.host.replace(/[^a-z0-9.-]+/gi, '_')}-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  try {
    writeFileSync(join(stage, 'catalog.json'), JSON.stringify(next, null, 2));
    // Relative file name: oras rejects absolute paths (see Publisher).
    orasPushArtifact(`${t.host}/${catalogRepo(t.prefix)}:${CATALOG_TAG}`, [`catalog.json:${CATALOG_LAYER_TYPE}`],
      CATALOG_ARTIFACT_TYPE, t.flags, { timeout: 60_000, cwd: stage });
    return next;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
