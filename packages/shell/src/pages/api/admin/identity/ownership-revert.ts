import type { APIRoute } from 'astro';
import { postOwnershipRevert } from '../../../../lib/homesAdmin.ts';

/** Stream T, the deploy's recovery: restore one ownership-apply journal exactly (lib/homesAdmin.ts). */
export const POST: APIRoute = (ctx) => postOwnershipRevert(ctx);
