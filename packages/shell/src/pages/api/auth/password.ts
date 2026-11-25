import type { APIRoute } from 'astro';
import { authChangePassword } from '../../../lib/authSurface.js';

/** The owner changes their password from the shell's own dialog: never through an App Host. */
export const POST: APIRoute = (ctx) => authChangePassword(ctx);
