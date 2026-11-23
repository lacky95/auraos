import type { APIRoute } from 'astro';
import { authSession } from '../../../lib/authSurface.js';

/** Whether this browser holds a live login session. */
export const GET: APIRoute = (ctx) => authSession(ctx);
