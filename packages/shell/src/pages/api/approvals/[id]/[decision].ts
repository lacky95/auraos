import type { APIRoute } from 'astro';
import { decideApproval } from '../../../../lib/approvals/routes.ts';
import { liveRouteDeps } from '../../../../lib/approvals/live.ts';

/** approve | deny (the owner in the shell, or the host operator) and consume (the requester). See lib/approvals/routes.ts. */
export const POST: APIRoute = (ctx) => decideApproval(ctx, ctx.params['id'], ctx.params['decision'], liveRouteDeps());
