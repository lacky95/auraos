import type { APIRoute } from 'astro';
import { getApproval } from '../../../lib/approvals/routes.ts';
import { liveRouteDeps } from '../../../lib/approvals/live.ts';

/** One approval, for its requester's poll or the owner's dialog (lib/approvals/routes.ts). */
export const GET: APIRoute = (ctx) => getApproval(ctx, ctx.params['id'], liveRouteDeps());
