import type { APIRoute } from 'astro';
import { getMigration } from '../../../../lib/runtimes.ts';

/** The D75 migration report, read-only (lib/runtimes.ts). */
export const GET: APIRoute = (ctx) => getMigration(ctx);
