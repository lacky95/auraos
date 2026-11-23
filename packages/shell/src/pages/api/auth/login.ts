import type { APIRoute } from 'astro';
import { authLogin } from '../../../lib/authSurface.js';

/** Password login. Sets the session cookie, which grants no authority in Phase 1. */
export const POST: APIRoute = (ctx) => authLogin(ctx);
