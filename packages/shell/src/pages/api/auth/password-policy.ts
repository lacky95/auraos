import type { APIRoute } from 'astro';
import { authPasswordPolicy, authSetPasswordPolicy } from '../../../lib/authSurface.js';

/** The rules for new passwords. Public: the setup page shows them. */
export const GET: APIRoute = (ctx) => authPasswordPolicy(ctx);
/** Owner only, from the shell's own dialog with the password: never through an App Host. */
export const PUT: APIRoute = (ctx) => authSetPasswordPolicy(ctx);
