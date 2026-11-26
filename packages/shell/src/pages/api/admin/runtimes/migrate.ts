import type { APIRoute } from 'astro';
import { postMigrate } from '../../../../lib/runtimes.ts';

/** The owner's D75 decision for one installation (lib/runtimes.ts). */
export const POST: APIRoute = (ctx) => postMigrate(ctx);
