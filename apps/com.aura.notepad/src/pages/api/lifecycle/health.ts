import type { APIRoute } from 'astro';
export const GET: APIRoute = () => new Response(JSON.stringify({
  ok: true,
  appId:      process.env['APP_ID']          ?? null,
  instanceId: process.env['APP_INSTANCE_ID'] ?? null,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
