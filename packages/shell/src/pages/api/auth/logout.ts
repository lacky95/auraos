import type { APIRoute } from 'astro';
import { authLogout } from '../../../lib/authSurface.js';

/** Revokes this browser's session and clears its cookie. */
export const POST: APIRoute = (ctx) => authLogout(ctx);
