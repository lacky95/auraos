import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * POST: continue an interrupted setup at its recorded step (after an approval, a restart).
 * D108 (setup/contracts.ts); who may call, the body and the answers: lib/setup/api.ts.
 */
export const POST: APIRoute = (ctx) => handleSetup(ctx, 'resume');
