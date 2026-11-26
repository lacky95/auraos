import type { APIRoute } from 'astro';
import { postHomesImport } from '../../../../lib/homesAdmin.ts';

/** The selective copy into an App Home (Q15; lib/homesAdmin.ts): a dry run unless `apply`. */
export const POST: APIRoute = (ctx) => postHomesImport(ctx);
