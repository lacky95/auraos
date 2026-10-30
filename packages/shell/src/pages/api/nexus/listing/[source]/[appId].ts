import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../../../lib/appResponse.js';
import { bustCatalog, DATA_DIR, listingError, listingTarget } from '../../../../../lib/nexusListing.js';

/**
 * The store listing of an app in an OCI source (core nexus/OciListing.ts):
 * screenshots + store texts, editable without publishing a new version.
 *
 *   GET → { listing: { screenshots: [url…], meta }, release: {…from :latest},
 *           canWrite }   canWrite = this login may push to the app's repo
 *   PUT { description?, longDescription?, tags?, homepage?, publisher? }
 *       → replace the listing texts ('' / [] clears one; the release's
 *         value shows again). 403 read-only for a login without push rights.
 *
 * Screenshots: ./[appId]/screenshots.ts.
 */
export const GET: APIRoute = async ({ params }) => {
  const r = await listingTarget(params['source'], params['appId']);
  if (r instanceof Response) return r;
  try {
    core.assertPublished(r.target, r.appId, r.sourceName);
    const listing = core.readListing(r.target);
    let release: core.StoreMetadata = {};
    try {
      const raw = core.orasSync(['manifest', 'fetch', `${r.target.host}/${r.target.repo}:latest`, ...r.target.flags], { timeout: 30_000 }).toString();
      release = core.parseStoreAnnotations((JSON.parse(raw) as { annotations?: Record<string, string> }).annotations);
      delete release.manifest;
    } catch { /* release texts unavailable */ }
    return jsonResponse({
      source: r.sourceName,
      appId: r.appId,
      ref: `${r.target.host}/${r.target.repo}`,
      listing: {
        exists: !!listing,
        screenshots: listing ? core.listingScreenshotUrls(listing, r.sourceName, r.appId) : [],
        meta: listing?.meta ?? {},
      },
      release,
      canWrite: core.canWriteListing(r.target),
      maxScreenshots: core.MAX_SCREENSHOTS,
      maxImageBytes: core.MAX_IMAGE_BYTES,
    });
  } catch (err) {
    return listingError(err);
  }
};

export const PUT: APIRoute = async ({ params, request }) => {
  const r = await listingTarget(params['source'], params['appId']);
  if (r instanceof Response) return r;
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  try {
    const next = core.updateListingMeta(r.target, r.appId, r.sourceName, body, DATA_DIR);
    bustCatalog(r.sourceName);
    return jsonResponse({ ok: true, meta: next.meta });
  } catch (err) {
    return listingError(err);
  }
};
