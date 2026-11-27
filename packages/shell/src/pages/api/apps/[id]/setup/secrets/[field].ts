import type { APIRoute } from 'astro';
import { handleSetup } from '../../../../../../lib/setup/api.ts';

/**
 * POST: `source: ask` from the owner's side: the D56 `credential.store` request for this app's secret field
 * (202 `{approvalId}`; the owner types the value into the shell's own dialog, the request carries none).
 * D108 (setup/contracts.ts `askSecret`); who may call and the answers: lib/setup/api.ts.
 */
export const POST: APIRoute = (ctx) => handleSetup(ctx, 'askSecret');
