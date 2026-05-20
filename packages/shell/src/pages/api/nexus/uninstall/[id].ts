import type { APIRoute } from 'astro';
import { getAppManager, getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Uninstall an app. Stops every running instance first so the runner
 * doesn't get confused by `apps/<id>/` vanishing under it, then moves
 * the dir to trash. Per-app data at `data/apps/<id>/` is preserved by
 * default; `?purge=1` removes it too.
 */
export const POST: APIRoute = async ({ params, url }) => {
  const id = params['id'];
  if (!id) return errorResponse('missing app id', 400);
  const mgr   = getAppManager();
  const nexus = getNexusManager();
  if (!mgr.getManifest(id) && !nexus.records.get(id)) {
    return errorResponse(`app '${id}' is not installed`, 404);
  }
  const purge = url.searchParams.get('purge') === '1';

  // Stop every instance (graceful → SIGKILL fallback if it lingers).
  for (const inst of mgr.getInstancesByApp(id)) {
    try { await mgr.stop(inst.instanceId); }
    catch (err) { console.warn(`[nexus uninstall] graceful stop failed for ${inst.instanceId}: ${(err as Error).message}`); }
  }
  // Belt-and-braces force-kill for any survivors.
  for (const inst of mgr.getInstancesByApp(id)) {
    try { mgr.forceKill(inst.instanceId); } catch { /* ignore */ }
  }

  try {
    await nexus.uninstall(id, { purge });
    return jsonResponse({ ok: true, id, purged: purge });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
