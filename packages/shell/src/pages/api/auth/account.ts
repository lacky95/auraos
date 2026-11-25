import type { APIRoute } from 'astro';
import { authAccount } from '../../../lib/authSurface.js';

/** The owner's account and sessions, for Settings → Users & Identities (D45). */
export const GET: APIRoute = (ctx) => authAccount(ctx);
