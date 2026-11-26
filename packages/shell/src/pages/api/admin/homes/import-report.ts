import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { ownerAction } from '../../../../lib/approvals/admin.ts';
import { importReport } from '../../../../lib/identityReports.ts';

/**
 * The home import report (Q15; Phase 5 stream I):
 *
 *   GET → { version, generatedAt, home, installations: [{ installationId, appId,
 *           candidates: [{ path, source, tool?, type, files, bytes, personal?, note? }] }] }
 *
 * What each app may want from today's shared home once App Homes start empty.
 * Paths and sizes only: no file is opened. The selective copy is stream H's
 * `POST /api/admin/homes/import` (5-main).
 */
export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'homes-import-report' }, level: 'session', title: 'Show the home import report',
  });
  if (actor instanceof Response) return actor;
  return jsonResponse(await importReport());
};
