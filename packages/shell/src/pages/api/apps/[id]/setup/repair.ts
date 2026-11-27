import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * POST: repair a repair-required or setup-failed setup.
 * D108 (setup/contracts.ts); who may call, the body and the answers: lib/setup/api.ts.
 */
export const POST: APIRoute = (ctx) => handleSetup(ctx, 'repair');
