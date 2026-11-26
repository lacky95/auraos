import type { APIRoute } from 'astro';
import { postHomesReset } from '../../../../lib/homesAdmin.ts';

/** An App Home reset (D65 §13; lib/homesAdmin.ts): it starts empty at the next start. */
export const POST: APIRoute = (ctx) => postHomesReset(ctx);
