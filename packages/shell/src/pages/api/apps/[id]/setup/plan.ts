import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * GET/POST: the dynamic steps for the current (GET) or a proposed (POST, SetupProposal) desired state (SetupPlan). POST changes nothing.
 * D108 (setup/contracts.ts); who may call, the body and the answers: lib/setup/api.ts.
 */
export const GET: APIRoute = (ctx) => handleSetup(ctx, 'plan');
export const POST: APIRoute = (ctx) => handleSetup(ctx, 'plan');
