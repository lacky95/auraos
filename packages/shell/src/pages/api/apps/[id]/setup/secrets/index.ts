import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../../lib/setup/api.ts';

/**
 * GET: the vault handles the app already holds for the acting user (the `source: vault` picker; never a value).
 * D108 (setup/contracts.ts `secretHandles`); who may call and the answers: lib/setup/api.ts.
 */
export const GET: APIRoute = (ctx) => handleSetup(ctx, 'secrets');
