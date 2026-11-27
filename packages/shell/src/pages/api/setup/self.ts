import type { APIRoute } from 'astro';

/**
 * GET (instance token): the calling app's own effective setup values (SetupConfigView); secrets as handles.
 * D108 P0 stub: the contract and the access row exist; P4 implements it (setup/contracts.ts).
 */
export const GET: APIRoute = () => new Response(JSON.stringify({ error: 'not-implemented', message: 'app setup is not implemented yet (P4)' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
