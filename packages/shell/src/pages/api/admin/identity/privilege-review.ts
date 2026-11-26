import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { ownerAction } from '../../../../lib/approvals/admin.ts';
import { privilegeReview } from '../../../../lib/identityReports.ts';

/**
 * The privilege review (Phase 5 stream A, P5-3):
 *
 *   GET → { version, generatedAt, rows: [{ appId, scope, installationId, runAs,
 *           identity, verdict, elevated, mismatched, migration, lastAppStart, … }], summary }
 *
 * Read-only: per installation, how it runs and every "needs elevated
 * privileges" reason, for the owner's review. An owner view.
 */
export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'privilege-review' }, level: 'session', title: 'Show the app privilege review',
  });
  if (actor instanceof Response) return actor;
  return jsonResponse(await privilegeReview());
};
