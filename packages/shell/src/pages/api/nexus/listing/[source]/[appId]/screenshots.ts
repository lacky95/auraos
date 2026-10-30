import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../../../../lib/appResponse.js';
import { bustCatalog, DATA_DIR, listingError, listingTarget } from '../../../../../../lib/nexusListing.js';

/**
 * Screenshots of an app's OCI store listing, from the Nexus app.
 *
 *   POST { action: 'add',     data: <base64 image> | url: 'https://…' }
 *        { action: 'replace', index: n, data | url }
 *        { action: 'remove',  index: n }
 *        { action: 'reorder', order: [n…] }      (1-based, as listed)
 *   → { ok, screenshots: [url…] }
 *
 * The image bytes travel in the body (a browser has no path the shell can
 * read); they are checked by content and size like any store image.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const r = await listingTarget(params['source'], params['appId']);
  if (r instanceof Response) return r;
  let body: { action?: string; index?: unknown; order?: unknown; data?: unknown; url?: unknown };
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }

  try {
    if (body.action === 'reorder') {
      if (!Array.isArray(body.order)) return jsonResponse({ error: 'invalid-order' }, 400);
      core.assertPublished(r.target, r.appId, r.sourceName);
      const next = core.reorderOciScreenshots(r.target, body.order.map(Number), DATA_DIR);
      bustCatalog(r.sourceName);
      return jsonResponse({ ok: true, screenshots: core.listingScreenshotUrls(next, r.sourceName, r.appId) });
    }
    if (body.action !== 'add' && body.action !== 'replace' && body.action !== 'remove') {
      return jsonResponse({ error: 'invalid-action', detail: String(body.action) }, 400);
    }
    let input: core.ListingInput | undefined;
    if (body.action !== 'remove') {
      if (typeof body.url === 'string' && body.url.trim()) {
        input = core.screenshotInput(body.url);          // https only
        if (!('url' in input)) return jsonResponse({ error: 'invalid-url', detail: 'only https:// URLs' }, 400);
      } else if (typeof body.data === 'string' && body.data) {
        const b64 = body.data.replace(/^data:[^;]+;base64,/, '');
        if (b64.length > Math.ceil(core.MAX_IMAGE_BYTES / 3) * 4 + 8) {
          return jsonResponse({ error: 'too-large', detail: `images are limited to ${core.MAX_IMAGE_BYTES / 1024 / 1024} MB` }, 413);
        }
        const buf = Buffer.from(b64, 'base64');
        input = { buf, info: core.identifyImage(buf) };
      } else {
        return jsonResponse({ error: 'missing-image', detail: 'send data (base64) or an https url' }, 400);
      }
    }
    const res = core.manageOciScreenshots({
      target: r.target, appId: r.appId, sourceName: r.sourceName,
      action: body.action, input, index: typeof body.index === 'number' ? body.index : Number(body.index),
      dataDir: DATA_DIR,
    });
    if (!res.unchanged) bustCatalog(r.sourceName);
    return jsonResponse({ ok: true, screenshots: res.screenshots, unchanged: !!res.unchanged });
  } catch (err) {
    return listingError(err);
  }
};
