import type { APIRoute } from 'astro';
import { changeUserGrant } from '../../../../../lib/usersAdmin.ts';

/** `aura admin user grant|revoke <user> use|jump <app>` (D82, C7; lib/usersAdmin.ts): host operator only. */
export const POST: APIRoute = (ctx) => changeUserGrant(ctx);
