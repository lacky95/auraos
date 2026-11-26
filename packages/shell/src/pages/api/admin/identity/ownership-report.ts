import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { ownerAction } from '../../../../lib/approvals/admin.ts';
import { ownershipReport } from '../../../../lib/identityReports.ts';

/**
 * The dry-run ownership report (Phase 5 stream I, P5-2, D70):
 *
 *   GET → { version, generatedAt, digest, planned, plannedUserPaths,
 *           plannedAppPaths, reportOnly, refused, findings }
 *
 * Read-only: it walks the candidate paths with lstat and changes nothing.
 * Stream H applies exactly the planned rows of an approved digest (5-main).
 * An owner view, like /api/admin/contract-report (D50).
 */
export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'ownership-report' }, level: 'session', title: 'Show the ownership report (dry run)',
  });
  if (actor instanceof Response) return actor;
  return jsonResponse(await ownershipReport());
};
