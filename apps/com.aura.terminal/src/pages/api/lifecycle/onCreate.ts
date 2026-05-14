import type { APIRoute } from 'astro';

export const POST: APIRoute = () => {
  console.log('[terminal] onCreate');
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
