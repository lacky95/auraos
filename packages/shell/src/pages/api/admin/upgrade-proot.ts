import type { APIRoute } from 'astro';
import { postProotUpgrade } from '../../../lib/prootUpgrade.ts';

/**
 * Build a newer PRoot from source into the running master
 * (lib/prootUpgrade.ts): argv only, the owner's password, audited.
 * Idempotent: reports the installed build unless `?force=1`.
 */
export const POST: APIRoute = (ctx) => postProotUpgrade(ctx);
