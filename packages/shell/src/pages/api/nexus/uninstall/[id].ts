import type { APIRoute } from 'astro';
import { getAppManager, getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { nexusFailure } from '../../../../lib/nexusErrors.ts';
import { deleteHomeRefusal, deleteHomesAfterRemove, installationBeforeRemove } from '../../../../lib/homesAdmin.ts';

/**
 * Uninstall an app. Stops every running instance first so the runner
 * doesn't get confused by `apps/<id>/` vanishing under it, then moves
 * the dir to trash. Per-app data at `data/apps/<id>/` is preserved by
 * default; `?purge=1` removes it too. The App Homes are kept unless
 * `?deleteHome=1` (D65 §13: explicit keep or delete).
 */
export const POST: APIRoute = async ({ params, url, request, locals }) => {
  const id = params['id'];
  if (!id) return errorResponse('missing app id', 400);
  const mgr   = getAppManager();
  const nexus = getNexusManager();
  if (!mgr.getManifest(id) && !nexus.records.get(id)) {
    return errorResponse(`app '${id}' is not installed`, 404);
  }
  const purge = url.searchParams.get('purge') === '1';
  const deleteHome = url.searchParams.get('deleteHome') === '1';
  const home = deleteHome ? await installationBeforeRemove(id) : null;
  if (home && 'error' in home) return errorResponse(deleteHomeRefusal(id, home.error), 409);

  // Suppress warm-pool refill for this app so the reconciler can't respawn
  // instances while we're killing them, then kill EVERY instance + sweep any
  // stray sibling containers BEFORE removing the files.
  mgr.markUninstalling(id, true);
  try {
    await mgr.killAllForApp(id);
    await nexus.uninstall(id, { purge });   // move files to trash + deregister
    const homeDeleted = home ? await deleteHomesAfterRemove(id, home.installationId) : false;
    return jsonResponse({ ok: true, id, purged: purge, homeDeleted });
  } catch (err) {
    return nexusFailure({ request, locals }, err);
  } finally {
    mgr.markUninstalling(id, false);
  }
};
