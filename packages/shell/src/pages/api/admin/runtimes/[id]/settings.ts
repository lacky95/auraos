import type { APIRoute } from 'astro';
import { putSettings } from '../../../../../lib/runtimes.ts';

/** One runtime's settings, validated against its schema (lib/runtimes.ts). */
export const PUT: APIRoute = (ctx) => putSettings(ctx, ctx.params['id']);
