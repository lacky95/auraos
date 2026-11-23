import type { APIRoute } from 'astro';
import { authStatus } from '../../../lib/authSurface.js';

/** Public and minimal: whether login is on, and whether setup is still open. */
export const GET: APIRoute = (ctx) => authStatus(ctx);
