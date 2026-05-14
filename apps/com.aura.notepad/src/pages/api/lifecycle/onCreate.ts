import type { APIRoute } from 'astro';
export const POST: APIRoute = () => {
  console.log('[notepad] onCreate');
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
