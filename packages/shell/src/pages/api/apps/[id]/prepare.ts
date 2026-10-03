import type { APIRoute } from 'astro';
import { getAppManager, PreparationError } from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { withPreparationProgress } from '../../../../lib/preparationProgress.js';

export const POST: APIRoute = ({ request, params }) => withPreparationProgress(request, async onLine => {
  const appId = params['id'];
  const mgr = getAppManager();
  if (!appId || !mgr.getManifest(appId)) return jsonResponse({ ok: false, error: 'App not found' }, 404);
  try {
    const preparation = await mgr.prepareApp(appId, onLine);
    return jsonResponse({ ok: true, appId, preparation });
  } catch (error) {
    return jsonResponse({ ok: false, appId, error: String(error), preparation: mgr.getPreparationStatus(appId),
      ...(error instanceof PreparationError ? { logPath: error.logPath } : {}) }, 500);
  }
});
