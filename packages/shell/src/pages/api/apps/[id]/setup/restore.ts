import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * GET: the last applied configuration (decision 13; names of secrets only). POST: restore it explicitly,
 * revalidated like any change (a revoked grant asks again, never `ready`); app data is not rolled back.
 * D108 P8 (setup/change.ts `lastApplied`, `restoreLast`); who may call and the answers: lib/setup/api.ts.
 */
export const GET: APIRoute = (ctx) => handleSetup(ctx, 'lastApplied');
export const POST: APIRoute = (ctx) => handleSetup(ctx, 'restore');
