import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { ownerAction } from '../../../../lib/approvals/admin.ts';
import { homesPlan } from '../../../../lib/identityReports.ts';

/**
 * The Home Resolver in report mode (Phase 5 stream I; D65, D67, D74):
 *
 *   GET → { version, generatedAt, mode: 'report', rows: [{ instanceId, appId,
 *           installationId, executionContext, current, target, change }], summary }
 *
 * Per running instance, today's `/home/aura` source against the Phase 5
 * target. Mounts nothing; stream H switches the spawn seam over (5-main).
 */
export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'homes-plan' }, level: 'session', title: 'Show the home plan',
  });
  if (actor instanceof Response) return actor;
  return jsonResponse(await homesPlan());
};
