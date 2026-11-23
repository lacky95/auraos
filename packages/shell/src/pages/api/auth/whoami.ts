import type { APIRoute } from 'astro';
import { authWhoami } from '../../../lib/authSurface.js';

/** The server-verified login principal. Never a credential. */
export const GET: APIRoute = (ctx) => authWhoami(ctx);
