import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * POST: what a proposed change would do, before anything is written: the privilege diff (grantDigest),
 * the approval it would ask for, §5.5 compatibility, the data that stays behind (never copied).
 * D108 P8 (setup/change.ts `changePlan`); who may call, the body and the answers: lib/setup/api.ts.
 */
export const POST: APIRoute = (ctx) => handleSetup(ctx, 'changePlan');
