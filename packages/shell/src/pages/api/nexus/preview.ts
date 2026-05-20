import type { APIRoute } from 'astro';
import { getNexusManager, computePermissionDiff, validateStagedDir } from '@aura/core';
import { join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';
import { getAppManager } from '@aura/core';

/**
 * Read-only preview of what installing `ref` would do — resolves the ref,
 * fetches into a throw-away staging dir, validates the manifest, computes
 * the permission diff against the current install (if any), then deletes
 * the staging dir before returning.
 *
 * Used by the Nexus GUI app's detail page + the CLI's `aura nexus info`.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as { ref?: string };
  if (!body.ref) return errorResponse('missing `ref`', 400);

  const nexus = getNexusManager();
  const mgr   = getAppManager();
  const stagingDir = join(mgr.getDataDir(), 'nexus', 'preview-staging', `preview-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });

  try {
    const resolved = await nexus.resolveRef(body.ref);
    // Fetch into a throwaway dir — skip the install pipeline so we
    // never touch apps/<id>/.
    await nexus.fetchInto(resolved, stagingDir);
    const manifest = validateStagedDir(stagingDir);

    const current = nexus.records.get(manifest.id);
    let currentManifest = null;
    if (current && existsSync(join(mgr.getAppsDir(), manifest.id))) {
      try { currentManifest = validateStagedDir(join(mgr.getAppsDir(), manifest.id)); }
      catch { /* leave null */ }
    }
    const diff = computePermissionDiff(currentManifest, manifest);

    return jsonResponse({ ok: true, resolved, manifest, diff });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  } finally {
    try { rmSync(stagingDir, { recursive: true, force: true }); }
    catch { /* best-effort */ }
  }
};
