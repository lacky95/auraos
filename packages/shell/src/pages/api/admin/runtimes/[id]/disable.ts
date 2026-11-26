import type { APIRoute } from 'astro';
import { postEnabled } from '../../../../../lib/runtimes.ts';

/** Disable one runtime; refused while instances run unless `{stopInstances: true}` (lib/runtimes.ts). */
export const POST: APIRoute = (ctx) => postEnabled(ctx, ctx.params['id'], false);
