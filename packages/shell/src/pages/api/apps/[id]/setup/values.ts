import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * GET: the desired and effective values (secrets as handles only). PUT: a plain-value change (no approval; a privilege-bearing change is refused, use apply).
 * D108 (setup/contracts.ts); who may call, the body and the answers: lib/setup/api.ts.
 */
export const GET: APIRoute = (ctx) => handleSetup(ctx, 'values');
export const PUT: APIRoute = (ctx) => handleSetup(ctx, 'setValues');
