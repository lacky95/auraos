import type { APIRoute } from 'astro';
import { authRevokeOtherSessions } from '../../../../lib/authSurface.js';

/** Signs out every other session of the owner, from the shell or Settings (D45). */
export const POST: APIRoute = (ctx) => authRevokeOtherSessions(ctx);
