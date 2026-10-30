/**
 * Weak-validator helpers for small JSON / CSS responses that change rarely but
 * are fetched on every desktop load and by every app iframe (theme.css is
 * linked into each proxied app page). `Cache-Control: no-cache` + an ETag
 * turns those repeats into 304s without risking a stale copy.
 */
import { createHash } from 'node:crypto';

export function etagOf(body: string): string {
  return `"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`;
}

/** True when the request already holds this version (If-None-Match). */
export function isFresh(request: Request, etag: string): boolean {
  const inm = request.headers.get('if-none-match');
  if (!inm) return false;
  return inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

/** 304 when fresh, else `body` with the ETag and `no-cache`. */
export function withEtag(request: Request, body: string, contentType: string, status = 200): Response {
  const etag = etagOf(body);
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-cache', ETag: etag };
  if (status === 200 && isFresh(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status, headers });
}
