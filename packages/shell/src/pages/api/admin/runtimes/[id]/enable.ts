import type { APIRoute } from 'astro';
import { postEnabled } from '../../../../../lib/runtimes.ts';

/** Enable one runtime (lib/runtimes.ts). */
export const POST: APIRoute = (ctx) => postEnabled(ctx, ctx.params['id'], true);
