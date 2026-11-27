import type { APIRoute } from 'astro';
import { deleteOverride, putOverride } from '../../../../../lib/runtimes.ts';

/** Set (ARI-3, capability-checked) or remove one installation's runtime override (lib/runtimes.ts). */
export const PUT: APIRoute = (ctx) => putOverride(ctx, ctx.params['installationId']);
export const DELETE: APIRoute = (ctx) => deleteOverride(ctx, ctx.params['installationId']);
