import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * GET: the operating profiles with availability and reasons (ProfileOption[]).
 * D108 (setup/contracts.ts); who may call, the body and the answers: lib/setup/api.ts.
 */
export const GET: APIRoute = (ctx) => handleSetup(ctx, 'profiles');
