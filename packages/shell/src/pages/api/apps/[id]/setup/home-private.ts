import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../lib/setup/api.ts';

/**
 * GET: the acting user's own Private Home grants to this app. DELETE (`?sidecar=<n>` for one sidecar):
 * revoke them; the app becomes `blocked` (D107), never switched to its App Home.
 * D108 P8 (setup/change.ts `homePrivateGrants`, `revokeHomePrivate`); who may call: lib/setup/api.ts.
 */
export const GET: APIRoute = (ctx) => handleSetup(ctx, 'homePrivate');
export const DELETE: APIRoute = (ctx) => handleSetup(ctx, 'revokeHomePrivate');
