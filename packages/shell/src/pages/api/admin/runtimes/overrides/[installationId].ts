import type { APIRoute } from 'astro';
import { deleteOverride } from '../../../../../lib/runtimes.ts';

/** Remove one installation's runtime override (lib/runtimes.ts). */
export const DELETE: APIRoute = (ctx) => deleteOverride(ctx, ctx.params['installationId']);
