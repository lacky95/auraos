import type { APIRoute } from 'astro';
import { addUser, listUsers } from '../../../lib/usersAdmin.ts';

/** Member accounts, host operator only (D82; lib/usersAdmin.ts): `aura admin user ls|add`. */
export const GET: APIRoute = (ctx) => listUsers(ctx);
export const POST: APIRoute = (ctx) => addUser(ctx);
