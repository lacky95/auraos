import type { APIRoute } from 'astro';

/**
 * GET: where the app stands (SetupStateView).
 * D108 P0 stub: the contract and the access row exist; P5 implements it (setup/contracts.ts).
 */
export const GET: APIRoute = () => new Response(JSON.stringify({ error: 'not-implemented', message: 'app setup is not implemented yet (P5)' }), { status: 501, headers: { 'Content-Type': 'application/json' } });
