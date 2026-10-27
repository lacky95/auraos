import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';

/**
 * Add a store by its address (flatpak-remote-add style).
 *
 *   POST {address: "apps.acme.com"} → the store's /.well-known/aura-store.json,
 *        validated: { name, title?, kind: 'oci', url, auth: 'basic'|'none' }
 *        422 {error:'discovery-failed', detail} when there is none / it is invalid
 *
 * Nothing is saved — the caller then POSTs /api/nexus/sources with the
 * descriptor (plus username + password when `auth` is "basic").
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { address?: unknown };
  try { body = await request.json() as { address?: unknown }; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (typeof body?.address !== 'string') return jsonResponse({ error: 'missing-address' }, 400);
  try {
    return jsonResponse({ ok: true, store: await core.discoverStore(body.address) });
  } catch (err) {
    return jsonResponse({ error: 'discovery-failed', detail: (err as Error).message }, 422);
  }
};
