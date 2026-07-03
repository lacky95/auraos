/**
 * OCI artifact metadata scheme for published Aura apps.
 *
 * When `aura nexus app publish` pushes an app to an OCI registry, it stamps
 * the image manifest with annotations — OCI standard keys (`org.opencontainers
 * .image.*`) for interop with generic tooling, plus custom `app.aura.*` keys
 * that carry Aura-specific storefront metadata. The catalog aggregator reads
 * these back with a single `oras manifest fetch` per repo — no bundle pull —
 * so the store can list an app with rich metadata cheaply.
 *
 * We deliberately keep everything in annotations rather than a second
 * metadata layer: a few KB of annotations is well within what registries
 * accept, and it's one round-trip to read.
 */
import type { AppManifest } from '../types/manifest.js';

/**
 * OCI repo path prefix for published apps: `<host>/aura-apps/<app-id>`.
 * Keeps the app store cleanly separated from the `aura/<pkg>` npm-package
 * artifacts that `os/publish-aura-packages.mjs` pushes into the same zot —
 * the catalog listing filters on this prefix so SDK packages never appear
 * as installable apps.
 */
export const APP_REPO_PREFIX = 'aura-apps';

/** artifactType stamped on the app-bundle image manifest (see Publisher). */
export const APP_ARTIFACT_TYPE = 'application/vnd.aura.app.manifest.v1+json';

/** Full app manifest is inlined into this annotation when it fits, letting
 *  the resolver build a permission-diff preview without pulling the bundle.
 *  Skipped when the serialized manifest exceeds this size. */
const MANIFEST_ANNOTATION_MAX = 32 * 1024;

/** Annotation keys — single source of truth for writer + reader. */
export const ANNOTATION_KEYS = {
  // OCI standard (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
  title:       'org.opencontainers.image.title',
  description: 'org.opencontainers.image.description',
  version:     'org.opencontainers.image.version',
  url:         'org.opencontainers.image.url',
  vendor:      'org.opencontainers.image.vendor',
  licenses:    'org.opencontainers.image.licenses',
  created:     'org.opencontainers.image.created',
  // Aura custom
  id:          'app.aura.id',
  icon:        'app.aura.icon',
  category:    'app.aura.category',
  tags:        'app.aura.tags',          // comma-joined
  screenshots: 'app.aura.screenshots',   // comma-joined
  longDesc:    'app.aura.long-description',
  manifest:    'app.aura.manifest',      // full manifest JSON (may be omitted)
} as const;

/**
 * Store metadata parsed back out of an OCI manifest's annotations. Every
 * field is optional because a registry may hold artifacts pushed by older
 * publishers (or non-Aura tooling) with a partial annotation set.
 */
export interface StoreMetadata {
  id?:              string;
  name?:            string;
  description?:     string;
  longDescription?: string;
  version?:         string;
  icon?:            string;
  category?:        string;
  publisher?:       string;
  homepage?:        string;
  license?:         string;
  tags?:            string[];
  screenshots?:     string[];
  createdAt?:       string;
  /** Full manifest when it was small enough to inline. */
  manifest?:        AppManifest;
}

/** ISO timestamp for the `created` annotation. Passed in (not read from the
 *  clock) so callers control it and tests stay deterministic. */
export function buildStoreAnnotations(
  manifest: AppManifest,
  opts: { createdAt?: string } = {},
): Record<string, string> {
  const a: Record<string, string> = {};
  const put = (k: string, v: string | undefined | null) => {
    if (v != null && v !== '') a[k] = v;
  };

  put(ANNOTATION_KEYS.title,       manifest.name);
  put(ANNOTATION_KEYS.description, manifest.description);
  put(ANNOTATION_KEYS.version,     manifest.version);
  put(ANNOTATION_KEYS.created,     opts.createdAt);
  put(ANNOTATION_KEYS.id,          manifest.id);
  put(ANNOTATION_KEYS.icon,        manifest.icon);
  put(ANNOTATION_KEYS.category,    manifest.category);

  const store = manifest.store;
  if (store) {
    put(ANNOTATION_KEYS.url,      store.homepage);
    put(ANNOTATION_KEYS.vendor,   store.publisher);
    put(ANNOTATION_KEYS.licenses, store.license);
    put(ANNOTATION_KEYS.longDesc, store.longDescription);
    if (store.tags?.length)        a[ANNOTATION_KEYS.tags]        = store.tags.join(',');
    if (store.screenshots?.length) a[ANNOTATION_KEYS.screenshots] = store.screenshots.join(',');
  }

  // Inline the full manifest when it's small enough — lets the resolver run
  // a permission diff without pulling the bundle.
  try {
    const json = JSON.stringify(manifest);
    if (json.length <= MANIFEST_ANNOTATION_MAX) a[ANNOTATION_KEYS.manifest] = json;
  } catch { /* non-serialisable manifest — skip the annotation */ }

  return a;
}

/** Parse store metadata out of an OCI manifest's annotation map. */
export function parseStoreAnnotations(
  annotations: Record<string, string> | undefined | null,
): StoreMetadata {
  const ann = annotations ?? {};
  const get = (k: string): string | undefined => {
    const v = ann[k];
    return v != null && v !== '' ? v : undefined;
  };
  const splitList = (k: string): string[] | undefined => {
    const v = get(k);
    if (!v) return undefined;
    const items = v.split(',').map((s) => s.trim()).filter(Boolean);
    return items.length ? items : undefined;
  };

  let manifest: AppManifest | undefined;
  const rawManifest = get(ANNOTATION_KEYS.manifest);
  if (rawManifest) {
    try { manifest = JSON.parse(rawManifest) as AppManifest; }
    catch { /* corrupt inline manifest — ignore */ }
  }

  return {
    id:              get(ANNOTATION_KEYS.id) ?? manifest?.id,
    name:            get(ANNOTATION_KEYS.title) ?? manifest?.name,
    description:     get(ANNOTATION_KEYS.description) ?? manifest?.description,
    longDescription: get(ANNOTATION_KEYS.longDesc),
    version:         get(ANNOTATION_KEYS.version) ?? manifest?.version,
    icon:            get(ANNOTATION_KEYS.icon) ?? manifest?.icon,
    category:        get(ANNOTATION_KEYS.category) ?? manifest?.category,
    publisher:       get(ANNOTATION_KEYS.vendor),
    homepage:        get(ANNOTATION_KEYS.url),
    license:         get(ANNOTATION_KEYS.licenses),
    tags:            splitList(ANNOTATION_KEYS.tags),
    screenshots:     splitList(ANNOTATION_KEYS.screenshots),
    createdAt:       get(ANNOTATION_KEYS.created),
    manifest,
  };
}
