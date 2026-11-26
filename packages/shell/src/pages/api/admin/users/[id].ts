import type { APIRoute } from 'astro';
import { setUserStatus } from '../../../../lib/usersAdmin.ts';

/** `aura admin user disable|enable <user>` (D82; lib/usersAdmin.ts): host operator only; nothing is deleted. */
export const POST: APIRoute = (ctx) => setUserStatus(ctx);
