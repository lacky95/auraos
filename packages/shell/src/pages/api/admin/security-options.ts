import type { APIRoute } from 'astro';
import { getSecurityOptions, putSecurityOption } from '../../../lib/securityOptions.ts';

/** The security options registry (D64): GET every option; PUT `{id, value}` a writable one (lib/securityOptions.ts). */
export const GET: APIRoute = (ctx) => getSecurityOptions(ctx);
export const PUT: APIRoute = (ctx) => putSecurityOption(ctx);
