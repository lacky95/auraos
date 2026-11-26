import type { APIRoute } from 'astro';
import { postRunAs } from '../../../../lib/appRunAs.ts';

/** The owner's runAs flip of one installation (P5-3, lib/appRunAs.ts). */
export const POST: APIRoute = (ctx) => postRunAs(ctx);
