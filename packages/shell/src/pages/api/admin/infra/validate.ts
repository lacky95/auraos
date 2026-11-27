import type { APIRoute } from 'astro';
import { postValidate } from '../../../../lib/infraAdmin.ts';

/** Check an infrastructure configuration and diff it against the stored one; nothing is written (lib/infraAdmin.ts). */
export const POST: APIRoute = (ctx) => postValidate(ctx);
