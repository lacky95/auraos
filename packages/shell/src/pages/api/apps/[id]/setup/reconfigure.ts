import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * POST: reconfigure or change the profile of a ready app (a grown privilege needs a new approval; data stays where it is).
 * D108 (setup/contracts.ts); who may call, the body and the answers: lib/setup/api.ts.
 */
export const POST: APIRoute = (ctx) => handleSetup(ctx, 'reconfigure');
