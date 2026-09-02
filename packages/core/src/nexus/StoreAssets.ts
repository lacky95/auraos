/**
 * Screenshots for a store listing — validation, naming, and the URL they end
 * up at.
 *
 * Screenshots do not belong to a release. You add one, swap a stale one, drop
 * a bad one, none of which is a new version of the app — which is why they are
 * managed separately rather than riding along with `publish`.
 *
 * ── On hosting ──────────────────────────────────────────────────────────
 * The store index only ever holds URLs, and until recently the schema said
 * "AuraOS hosts no images", so an author needed somewhere of their own to put
 * them. That is no longer true: the store repo IS the website (GitHub Pages
 * serves it from the repo root), so a file committed to `assets/` is reachable
 * over https immediately. Uploading beats linking out — a listing whose
 * pictures depend on someone else's host staying up is a listing that quietly
 * breaks, and nothing in CI checks a screenshot URL still resolves.
 */

import { createHash } from 'node:crypto';

/** What the store schema allows. */
export const MAX_SCREENSHOTS = 8;

/**
 * Per-image ceiling. The store repo is also the published site, so every
 * committed byte counts against the Pages limit and every clone pays for it —
 * including the clone this tooling makes on each submission. 2 MB is generous
 * for a screenshot and mean enough to stop someone committing a raw capture.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Formats worth accepting, keyed by their magic bytes. */
const SIGNATURES: Array<{ ext: string; mime: string; test: (b: Buffer) => boolean }> = [
  { ext: 'png',  mime: 'image/png',  test: (b) => b.length > 8 && b.subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg',  mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif',  mime: 'image/gif',  test: (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12
      && b.subarray(0, 4).toString('latin1') === 'RIFF'
      && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

export interface ImageInfo { ext: string; mime: string; bytes: number; hash: string }

/**
 * Identify an image by its CONTENT, not its filename.
 *
 * A `.png` extension is a claim, not a fact, and the store serves whatever is
 * committed straight to browsers. Sniffing the magic bytes means a mislabelled
 * or non-image file is refused here rather than shipped as a broken picture —
 * or as something that is not a picture at all.
 */
export function identifyImage(buf: Buffer): ImageInfo {
  const hit = SIGNATURES.find((s) => s.test(buf));
  if (!hit) {
    throw new Error(
      'not a recognised image — expected PNG, JPEG, GIF or WebP '
      + '(checked by content, so renaming the file will not help)',
    );
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `image is ${(buf.length / 1024 / 1024).toFixed(1)} MB, limit is `
      + `${MAX_IMAGE_BYTES / 1024 / 1024} MB — the store repo is also the published site, `
      + 'so every byte is cloned by the tooling and served from the Pages quota',
    );
  }
  return {
    ext: hit.ext,
    mime: hit.mime,
    bytes: buf.length,
    // Content-addressed: re-adding the same picture is a no-op instead of a
    // second copy, and removing one never has to renumber the others.
    hash: createHash('sha256').update(buf).digest('hex').slice(0, 12),
  };
}

/** Where an uploaded screenshot lives inside the store repo. */
export function assetPath(appId: string, info: ImageInfo): string {
  return `assets/${appId}/${info.hash}.${info.ext}`;
}

/**
 * The public URL of an asset, derived from the index URL's origin.
 *
 * The store is served from wherever its index is served from, so the origin of
 * `https://nexus.aura.lakner.io/index.yaml` is also the origin of everything
 * else in the repo. Deriving it means a self-hosted store works without any
 * extra configuration; a store whose index is NOT served over https (a raw git
 * clone source, say) cannot host assets and says so.
 */
export function assetUrl(indexUrl: string, appId: string, info: ImageInfo): string {
  let origin: string;
  try {
    const u = new URL(indexUrl);
    if (u.protocol !== 'https:') throw new Error('not https');
    origin = u.origin;
  } catch {
    throw new Error(
      `cannot host images for this store: its index (${indexUrl}) is not served over https, `
      + 'so there is no public address to serve them from. Pass an https URL instead of a file.',
    );
  }
  return `${origin}/${assetPath(appId, info)}`;
}

/** True when a URL points at this store's own asset area. */
export function isOwnAsset(url: string, indexUrl: string, appId: string): boolean {
  try {
    const origin = new URL(indexUrl).origin;
    return url.startsWith(`${origin}/assets/${appId}/`);
  } catch {
    return false;
  }
}
