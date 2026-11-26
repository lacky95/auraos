import type { APIRoute } from 'astro';
import { postCheck } from '../../../../lib/runtimes.ts';

/** A read-only capability dry run (lib/runtimes.ts). */
export const POST: APIRoute = (ctx) => postCheck(ctx);
