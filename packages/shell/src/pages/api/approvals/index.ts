import type { APIRoute } from 'astro';
import { createApproval, listApprovals } from '../../../lib/approvals/routes.ts';
import { liveRouteDeps } from '../../../lib/approvals/live.ts';

/** GET: the owner's pending approvals (long poll with `?seen=<version>`). POST: a requester asks (lib/approvals/routes.ts). */
export const GET: APIRoute = (ctx) => listApprovals(ctx, liveRouteDeps());
export const POST: APIRoute = (ctx) => createApproval(ctx, liveRouteDeps());
