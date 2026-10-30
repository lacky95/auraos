import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * GET /api/apps/serve — how each app starts next time: `prod` (from its
 * build) or `dev` (astro dev) and why (changed / no build / dev-only /
 * own entrypoint). Running instances keep the mode they started with until
 * they restart. Core app-manager/appBuild.ts.
 */
export const GET: APIRoute = () => {
  const mgr = core.getAppManager();
  const apps = mgr.getManifests().map((m) => {
    const s = mgr.serveStateOf(m.id);
    return { appId: m.id, ...(s ?? { mode: 'dev', reason: 'unknown' }), label: s ? core.serveLabel(s) : '?' };
  });
  return jsonResponse({ apps });
};
