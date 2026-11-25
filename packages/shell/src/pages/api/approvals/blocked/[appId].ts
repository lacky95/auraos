import type { APIRoute } from 'astro';
import { unblockApp } from '../../../../lib/approvals/routes.ts';
import { liveRouteDeps } from '../../../../lib/approvals/live.ts';

/** Lift "Deny and block requests from this app" (lib/approvals/routes.ts). */
export const DELETE: APIRoute = (ctx) => unblockApp(ctx, ctx.params['appId'], liveRouteDeps());
