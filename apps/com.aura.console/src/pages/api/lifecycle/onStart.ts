import type { APIRoute } from 'astro';
export const POST: APIRoute = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
