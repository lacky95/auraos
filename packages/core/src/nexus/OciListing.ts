/**
 * Store listing of an app in an OCI registry — its screenshots and store
 * texts, kept apart from its releases and editable without a new version.
 *
 * Releases are `<host>/aura-apps/<id>:<version>` (+ `:latest`, channels): one
 * bundle layer, store metadata in annotations (ociMetadata.ts). A release is
 * immutable, but pictures change on their own schedule — the same reason the
 * git store keeps them out of `publish` (StoreSubmitter.manageScreenshots).
 * So screenshots live in a second artifact in the same repo:
 *
 *   <host>/aura-apps/<id>:listing
 *     artifactType  application/vnd.aura.app.listing.v1+json
 *     layers        one per uploaded image (image/png|jpeg|gif|webp), the
 *                   layer digest = sha256 of the file
 *     annotation    app.aura.listing.screenshots = JSON order of the list:
 *                   [{ "digest": "sha256:…" } | { "url": "https://…" }]
 *     annotation    app.aura.listing.meta = JSON store texts that override the
 *                   release's: { description, longDescription, tags,
 *                   homepage, publisher } (each optional)
 *
 * The images are hosted by the registry itself, so a private or internal
 * store needs no web host. Browsers cannot reach such a registry (internal
 * hostname, login), so the shell serves them:
 *   GET /api/nexus/assets/<source>/<appId>/<digest>   (listingAssetPath)
 * Content-addressed: the same picture twice is the same digest.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { artifactTypeOf, orasPushArtifact, orasSync } from './RegistryAuth.js';
import { orasFlagsForUrl, orasHostFromUrl } from './RegistryConfig.js';
import { APP_REPO_PREFIX } from './ociMetadata.js';
import { identifyImage, MAX_SCREENSHOTS, type ImageInfo } from './StoreAssets.js';

export const LISTING_TAG = 'listing';
export const LISTING_ARTIFACT_TYPE = 'application/vnd.aura.app.listing.v1+json';
export const LISTING_ORDER_ANNOTATION = 'app.aura.listing.screenshots';
export const LISTING_META_ANNOTATION = 'app.aura.listing.meta';

const ORAS_TIMEOUT_MS = 30_000;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export type ListingShot =
  | { digest: string; mime: string; bytes?: number }
  | { url: string };

/** Store texts a listing can override (limits as in the manifest schema). */
export interface ListingMeta {
  description?:     string;
  longDescription?: string;
  tags?:            string[];
  homepage?:        string;
  publisher?:       string;
}

export interface Listing { screenshots: ListingShot[]; meta: ListingMeta }

/** Validate + normalise listing texts. Empty strings / lists clear a field. */
export function normaliseListingMeta(raw: unknown): ListingMeta {
  const m: ListingMeta = {};
  if (!raw || typeof raw !== 'object') return m;
  const r = raw as Record<string, unknown>;
  const text = (k: keyof ListingMeta, max: number) => {
    const v = r[k];
    if (v === undefined || v === null) return;
    if (typeof v !== 'string') throw new Error(`${k} must be text`);
    const t = v.trim();
    if (t.length > max) throw new Error(`${k} is longer than ${max} characters`);
    if (t) (m as Record<string, unknown>)[k] = t;
  };
  text('description', 280);
  text('longDescription', 4096);
  text('publisher', 64);
  text('homepage', 2048);
  if (m.homepage && !/^https?:\/\//i.test(m.homepage)) throw new Error('homepage must be an http(s) URL');
  if (r['tags'] !== undefined && r['tags'] !== null) {
    if (!Array.isArray(r['tags'])) throw new Error('tags must be a list');
    const tags = [...new Set(r['tags'].map((t) => String(t).trim()).filter(Boolean))];
    if (tags.length > 16) throw new Error('at most 16 tags');
    if (tags.some((t) => t.length > 24)) throw new Error('a tag is longer than 24 characters');
    if (tags.length) m.tags = tags;
  }
  return m;
}

/** Where an app's artifacts live in one OCI source. */
export interface OciAppTarget { host: string; repo: string; flags: string[] }

export function ociAppTarget(url: string, appId: string, appRepoPrefix = APP_REPO_PREFIX): OciAppTarget {
  return {
    host: orasHostFromUrl(url),
    repo: `${appRepoPrefix.replace(/\/+$/, '')}/${appId}`,
    flags: orasFlagsForUrl(url),
  };
}

export function isDigest(s: string): boolean { return DIGEST_RE.test(s); }

/** The shell path that serves one listing image (see the file header). */
export function listingAssetPath(sourceName: string, appId: string, digest: string): string {
  return `/api/nexus/assets/${encodeURIComponent(sourceName)}/${encodeURIComponent(appId)}/${digest}`;
}

/** Screenshot URLs of a listing as the catalog shows them. */
export function listingScreenshotUrls(listing: Listing, sourceName: string, appId: string): string[] {
  return listing.screenshots.map((s) => ('url' in s ? s.url : listingAssetPath(sourceName, appId, s.digest)));
}

const isNotFound = (err: unknown) =>
  /\bnot found\b|\b404\b|MANIFEST_UNKNOWN|NAME_UNKNOWN/i.test((err as Error)?.message ?? '');

/** Read the listing, or null when the app has none yet. Throws on login /
 *  network errors so a caller can tell "no pictures" from "can't look". */
export function readListing(t: OciAppTarget): Listing | null {
  let raw: string;
  try {
    raw = orasSync(['manifest', 'fetch', `${t.host}/${t.repo}:${LISTING_TAG}`, ...t.flags],
      { timeout: ORAS_TIMEOUT_MS }).toString();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const m = JSON.parse(raw) as {
    artifactType?: string;
    annotations?: Record<string, string>;
    config?: { mediaType?: string };
    layers?: Array<{ digest: string; mediaType: string; size?: number }>;
  };
  const type = artifactTypeOf(m);
  if (type && type !== LISTING_ARTIFACT_TYPE) return null;
  const layers = new Map((m.layers ?? []).map((l) => [l.digest, l]));
  let order: unknown = [];
  try { order = JSON.parse(m.annotations?.[LISTING_ORDER_ANNOTATION] ?? '[]'); } catch { /* corrupt: fall back to layers */ }
  let meta: ListingMeta = {};
  try { meta = normaliseListingMeta(JSON.parse(m.annotations?.[LISTING_META_ANNOTATION] ?? '{}')); } catch { /* corrupt: ignore */ }
  const shots: ListingShot[] = [];
  if (Array.isArray(order) && order.length) {
    for (const o of order as Array<Record<string, unknown>>) {
      if (typeof o?.['url'] === 'string' && /^https:\/\//i.test(o['url'])) shots.push({ url: o['url'] });
      else if (typeof o?.['digest'] === 'string' && layers.has(o['digest'])) {
        const l = layers.get(o['digest'])!;
        shots.push({ digest: l.digest, mime: l.mediaType, bytes: l.size });
      }
    }
  } else {
    for (const l of layers.values()) shots.push({ digest: l.digest, mime: l.mediaType, bytes: l.size });
  }
  return { screenshots: shots, meta };
}

/** Download one listing image. Verifies the content against its digest. */
export function fetchListingBlob(t: OciAppTarget, digest: string): Buffer {
  if (!isDigest(digest)) throw new Error(`not a sha256 digest: ${digest}`);
  const buf = orasSync(['blob', 'fetch', `${t.host}/${t.repo}@${digest}`, '--output', '-', ...t.flags],
    { timeout: ORAS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (sha256(buf) !== digest) throw new Error(`blob ${digest} does not match its digest`);
  return buf;
}

/** One screenshot to write: an image's bytes, or an https URL. */
export type ListingInput = { buf: Buffer; info: ImageInfo } | { url: string };

/** Replace the listing with exactly `items`, in order, and `meta`. Kept
 *  images must be passed with their bytes (`fetchListingBlob`) — a push
 *  names every layer. */
export function writeListing(t: OciAppTarget, items: ListingInput[], meta: ListingMeta, dataDir: string): Listing {
  if (items.length > MAX_SCREENSHOTS) throw new Error(`at most ${MAX_SCREENSHOTS} screenshots per app`);
  const stage = join(dataDir, 'nexus', 'listing-staging', `${t.repo.replace(/[^a-z0-9.-]+/gi, '_')}-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  try {
    const order: Array<{ digest: string } | { url: string }> = [];
    const files: string[] = [];
    const shots: ListingShot[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      if ('url' in it) { order.push({ url: it.url }); shots.push({ url: it.url }); continue; }
      const digest = sha256(it.buf);
      order.push({ digest });
      shots.push({ digest, mime: it.info.mime, bytes: it.info.bytes });
      if (seen.has(digest)) continue;
      seen.add(digest);
      const name = `${digest.slice(7, 19)}.${it.info.ext}`;
      writeFileSync(join(stage, name), it.buf);
      // Relative names: oras rejects absolute paths (see Publisher).
      files.push(`${name}:${it.info.mime}`);
    }
    orasPushArtifact(`${t.host}/${t.repo}:${LISTING_TAG}`, files, LISTING_ARTIFACT_TYPE, [
      '--annotation', `${LISTING_ORDER_ANNOTATION}=${JSON.stringify(order)}`,
      '--annotation', `${LISTING_META_ANNOTATION}=${JSON.stringify(meta)}`,
      ...t.flags,
    ], { timeout: 120_000, cwd: stage });
    return { screenshots: shots, meta };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Current listing as write inputs (downloads kept images). */
export function listingInputs(t: OciAppTarget, listing: Listing | null): ListingInput[] {
  return (listing?.screenshots ?? []).map((s) => {
    if ('url' in s) return { url: s.url };
    const buf = fetchListingBlob(t, s.digest);
    return { buf, info: identifyImage(buf) };
  });
}

/**
 * Resolve one manifest / command screenshot reference to a write input:
 * an https URL as-is, else an image file. `baseDir` confines relative paths
 * (a manifest's `store.screenshots` entry must stay inside the app).
 */
export function screenshotInput(ref: string, baseDir?: string): ListingInput {
  const src = ref.trim();
  if (/^https:\/\//i.test(src)) return { url: src };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) throw new Error(`${src}: only https:// URLs or image files`);
  let path = src;
  if (baseDir) {
    const base = resolve(baseDir);
    path = resolve(base, src);
    if (path !== base && !path.startsWith(base + sep)) throw new Error(`${src}: screenshot paths must stay inside the app`);
  }
  if (!existsSync(path)) throw new Error(`no such file: ${src}`);
  const buf = readFileSync(path);
  return { buf, info: identifyImage(buf) };   // throws on non-images and oversize
}

export interface OciScreenshotOpts {
  target:  OciAppTarget;
  appId:   string;
  /** Source alias — for the asset URLs in the result. */
  sourceName: string;
  action:  'list' | 'add' | 'remove' | 'replace';
  /** add / replace: a local file path, or an https URL … */
  source?: string;
  /** … or the image itself (browser upload). */
  input?:  ListingInput;
  /** remove / replace: 1-based position, as printed by `list`. */
  index?:  number;
  dataDir: string;
  dryRun?: boolean;
  onMessage?: (m: string) => void;
}

export interface OciScreenshotResult {
  appId:       string;
  screenshots: string[];
  uploaded?:   { digest: string; bytes: number; url: string };
  unchanged?:  boolean;
}

/** list / add / replace / remove on an OCI listing — the registry twin of
 *  StoreSubmitter.manageScreenshots (no pull request: the push is the change). */
export function manageOciScreenshots(o: OciScreenshotOpts): OciScreenshotResult {
  const log = (m: string) => o.onMessage?.(m);
  assertPublished(o.target, o.appId, o.sourceName);
  const current = readListing(o.target);
  const urls = (l: Listing | null) => listingScreenshotUrls(l ?? { screenshots: [], meta: {} }, o.sourceName, o.appId);
  if (o.action === 'list') return { appId: o.appId, screenshots: urls(current) };

  const shots = current?.screenshots ?? [];
  const at = (o.index ?? 0) - 1;
  if ((o.action === 'remove' || o.action === 'replace') && (at < 0 || at >= shots.length)) {
    throw new Error(`there is no screenshot ${o.index} — the listing has ${shots.length}`);
  }
  if (o.action === 'add' && shots.length >= MAX_SCREENSHOTS) {
    throw new Error(`the listing already has ${shots.length} screenshots, the store allows ${MAX_SCREENSHOTS}`);
  }

  let incoming: ListingInput | null = null;
  if (o.action !== 'remove') {
    if (o.input) incoming = o.input;
    else if (o.source) incoming = screenshotInput(o.source);
    else throw new Error('no image given — pass a file path or an https:// URL');
    const key = 'url' in incoming ? incoming.url : sha256(incoming.buf);
    if (shots.some((s) => ('url' in s ? s.url : s.digest) === key)) {
      log('  that image is already listed — nothing to do');
      return { appId: o.appId, screenshots: urls(current), unchanged: true };
    }
  }

  const items = listingInputs(o.target, current);
  if (o.action === 'add') items.push(incoming!);
  else if (o.action === 'remove') items.splice(at, 1);
  else items.splice(at, 1, incoming!);

  let uploaded: OciScreenshotResult['uploaded'];
  if (incoming && 'buf' in incoming) {
    const digest = sha256(incoming.buf);
    uploaded = { digest, bytes: incoming.info.bytes, url: listingAssetPath(o.sourceName, o.appId, digest) };
    log(`  image ${digest.slice(0, 19)}… (${(incoming.info.bytes / 1024).toFixed(0)} kB) → ${o.target.host}/${o.target.repo}:${LISTING_TAG}`);
  }
  if (o.dryRun) {
    const preview: Listing = {
      screenshots: items.map((it) => ('url' in it ? { url: it.url } : { digest: sha256(it.buf), mime: it.info.mime })),
      meta: current?.meta ?? {},
    };
    return { appId: o.appId, screenshots: urls(preview), uploaded };
  }
  const next = writeListing(o.target, items, current?.meta ?? {}, o.dataDir);
  return { appId: o.appId, screenshots: urls(next), uploaded };
}

/** Reorder the listing's screenshots: `order` is the new 1-based sequence. */
export function reorderOciScreenshots(t: OciAppTarget, order: number[], dataDir: string): Listing {
  const current = readListing(t);
  const n = current?.screenshots.length ?? 0;
  if (order.length !== n || new Set(order).size !== n || order.some((i) => !Number.isInteger(i) || i < 1 || i > n)) {
    throw new Error(`order must name each of the ${n} screenshots once (1…${n})`);
  }
  const items = listingInputs(t, current);
  return writeListing(t, order.map((i) => items[i - 1]!), current?.meta ?? {}, dataDir);
}

/** Replace the listing texts; screenshots stay. */
export function updateListingMeta(t: OciAppTarget, appId: string, sourceName: string, meta: unknown, dataDir: string): Listing {
  assertPublished(t, appId, sourceName);
  const clean = normaliseListingMeta(meta);
  const current = readListing(t);
  return writeListing(t, listingInputs(t, current), clean, dataDir);
}

/** The app must have a release in this registry before it can have a listing. */
export function assertPublished(t: OciAppTarget, appId: string, sourceName: string): void {
  try {
    orasSync(['manifest', 'fetch', `${t.host}/${t.repo}:latest`, ...t.flags], { timeout: ORAS_TIMEOUT_MS });
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(`${appId} is not published to ${t.host} — publish it there first (aura nexus app publish --to ${sourceName})`);
    }
    throw err;
  }
}

/**
 * May this login write to the app's repo? Re-tags `:latest` with itself —
 * a manifest PUT that changes nothing but needs push rights, so a read-only
 * (customer) login is refused exactly like a real edit would be. Cached
 * briefly per repo: the Nexus app asks on every detail page.
 */
const writeCache = new Map<string, { ok: boolean; at: number }>();
const WRITE_CACHE_MS = 5 * 60_000;
export function canWriteListing(t: OciAppTarget): boolean {
  const key = `${t.host}/${t.repo}`;
  const hit = writeCache.get(key);
  if (hit && Date.now() - hit.at < WRITE_CACHE_MS) return hit.ok;
  let ok = false;
  try {
    orasSync(['tag', `${t.host}/${t.repo}:latest`, 'latest', ...t.flags], { timeout: ORAS_TIMEOUT_MS });
    ok = true;
  } catch { ok = false; }
  writeCache.set(key, { ok, at: Date.now() });
  return ok;
}

function sha256(buf: Buffer): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}
