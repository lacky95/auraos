/**
 * Shared bits of the OCI store-listing routes (core nexus/OciListing.ts):
 * resolve a source alias + app id to its registry repo, with the source's
 * login loaded, and refresh the catalog after an edit.
 */
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from './appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
export const DATA_DIR = process.env['AURA_DATA_DIR'] ?? '/data';

const APP_ID_RE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i;

export interface ResolvedListingTarget {
  sourceName: string;
  appId: string;
  target: core.OciAppTarget;
}

/** 400/404 as a Response, else the target. Only `oci` sources have listings. */
export async function listingTarget(sourceName: string | undefined, appId: string | undefined): Promise<ResolvedListingTarget | Response> {
  if (!sourceName || !appId) return jsonResponse({ error: 'missing-param' }, 400);
  if (!APP_ID_RE.test(appId)) return jsonResponse({ error: 'invalid-app-id', detail: appId }, 400);
  const nexus = core.getNexusManager();
  await nexus.ensureSourcesLoaded(OS_API_BASE);
  const cfg = await core.loadSourcesConfig(OS_API_BASE);
  const src = cfg.sources.find((s) => s.name === sourceName);
  if (!src) return jsonResponse({ error: 'not-found', detail: `no source '${sourceName}'` }, 404);
  if (src.kind !== 'oci') {
    return jsonResponse({ error: 'not-oci', detail: `'${sourceName}' is a ${src.kind} source — its listing is edited through the store repo (aura nexus app screenshots / submit)` }, 400);
  }
  // Logins are decrypted asynchronously after a config change; wait for them.
  try {
    const mgr = nexus as unknown as { whenCredentialsReady?: () => Promise<void> };
    await mgr.whenCredentialsReady?.();
  } catch { /* best-effort */ }
  return { sourceName, appId, target: core.ociAppTarget(src.url, appId, src.appRepoPrefix) };
}

/** The store shows the change on the next read. */
export function bustCatalog(sourceName: string): void {
  try { core.getNexusManager().catalog.bustSource(sourceName); } catch { /* no manager yet */ }
}

/** oras / validation errors → a JSON error a user can act on. */
export function listingError(err: unknown): Response {
  if (err instanceof core.OrasAuthError) {
    return jsonResponse({ error: err.reason === 'forbidden' ? 'read-only' : 'login', detail: err.message }, 403);
  }
  const msg = ((err as Error)?.message ?? String(err)).split('\n').filter(Boolean)[0] ?? 'failed';
  return jsonResponse({ error: 'listing-failed', detail: msg }, 400);
}
