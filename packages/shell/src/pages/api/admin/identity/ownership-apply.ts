import type { APIRoute } from 'astro';
import { postOwnershipApply } from '../../../../lib/homesAdmin.ts';

/** The targeted chown of the reviewed dry-run ownership report (P5-2, D70; lib/homesAdmin.ts). */
export const POST: APIRoute = (ctx) => postOwnershipApply(ctx);
