import type { APIRoute } from 'astro';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { DATA_DIR, listingTarget } from '../../../../../../lib/nexusListing.js';

/**
 * GET /api/nexus/assets/<source>/<appId>/<digest> — one image of an app's
 * OCI store listing (core nexus/OciListing.ts).
 *
 * The browser cannot reach the registry itself (internal hostname, login), so
 * the shell fetches the blob with the source's login and serves it. Content-
 * addressed and verified against its digest, so it is cached on disk forever
 * and served `immutable`.
 */
export const GET: APIRoute = async ({ params }) => {
  const digest = params['digest'] ?? '';
  if (!core.isDigest(digest)) return new Response('bad digest', { status: 400 });
  const resolved = await listingTarget(params['source'], params['appId']);
  if (resolved instanceof Response) return resolved;

  const cacheDir = join(DATA_DIR, 'nexus', 'asset-cache');
  const file = join(cacheDir, digest.slice(7));
  let buf: Buffer;
  if (existsSync(file)) {
    buf = readFileSync(file);
  } else {
    try {
      buf = core.fetchListingBlob(resolved.target, digest);
    } catch {
      return new Response('not found', { status: 404 });
    }
    try {
      mkdirSync(cacheDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, file);
    } catch { /* serve uncached */ }
  }
  let mime = 'application/octet-stream';
  try { mime = core.identifyImage(buf).mime; } catch { return new Response('not an image', { status: 415 }); }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(buf.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
