import type { APIRoute } from 'astro';
import { getInfra, putInfra } from '../../../../lib/infraAdmin.ts';

/** The infrastructure configuration (D94 IC-1): GET the stored config; PUT apply one (fresh). lib/infraAdmin.ts. */
export const GET: APIRoute = (ctx) => getInfra(ctx);
export const PUT: APIRoute = (ctx) => putInfra(ctx);
