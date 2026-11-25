import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../lib/appResponse.js';
import { ownerAction } from '../../../lib/approvals/admin.ts';
import { contractReport, liveContractReportDeps } from '../../../lib/appContract.ts';

/**
 * The app contract report (D48, Phase 3b), per installed app:
 *
 *   GET [?datadir=1] → { contract, apps: [{ appId, contract, declares, findings,
 *                        source, signals, readsRawContext, dataDir? }], summary }
 *
 * Report only. `datadir=1` adds the writes outside each app's dataDir
 * (install folder, container layer via `docker diff`, the home mount). An
 * owner view, like /api/admin/access-report (D50, lib/approvals/admin.ts).
 */
export const GET: APIRoute = async (ctx) => {
  const dataDir = ctx.url.searchParams.get('datadir') === '1';
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'contract-report', dataDir }, level: 'session', title: 'Show the app contract report',
    details: dataDir ? ['Includes the writes outside each app\'s data directory'] : [],
  });
  if (actor instanceof Response) return actor;
  return jsonResponse(await contractReport(liveContractReportDeps(), { dataDir }));
};
