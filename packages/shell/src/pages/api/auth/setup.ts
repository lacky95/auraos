import type { APIRoute } from 'astro';
import { authSetup } from '../../../lib/authSurface.js';

/** Creates the owner with a one-time code, or resets its password with `purpose: 'reset'`. */
export const POST: APIRoute = (ctx) => authSetup(ctx);
