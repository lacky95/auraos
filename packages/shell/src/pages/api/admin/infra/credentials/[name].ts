import type { APIRoute } from 'astro';
import { deleteCredential, putCredential } from '../../../../../lib/infraAdmin.ts';

/** Set or remove the credential behind `system:INFRA_<NAME>` (fresh; never readable). lib/infraAdmin.ts. */
export const PUT: APIRoute = (ctx) => putCredential(ctx, String(ctx.params['name'] ?? ''));
export const DELETE: APIRoute = (ctx) => deleteCredential(ctx, String(ctx.params['name'] ?? ''));
