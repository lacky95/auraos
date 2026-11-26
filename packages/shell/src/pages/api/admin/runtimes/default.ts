import type { APIRoute } from 'astro';
import { putDefault } from '../../../../lib/runtimes.ts';

/** The default runtime for apps that name none (lib/runtimes.ts). */
export const PUT: APIRoute = (ctx) => putDefault(ctx);
