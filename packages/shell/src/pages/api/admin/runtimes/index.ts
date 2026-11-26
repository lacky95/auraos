import type { APIRoute } from 'astro';
import { getRuntimes } from '../../../../lib/runtimes.ts';

/** The runtimes, their settings and every installation's resolution (lib/runtimes.ts). */
export const GET: APIRoute = (ctx) => getRuntimes(ctx);
