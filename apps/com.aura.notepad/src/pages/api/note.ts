import type { APIRoute } from 'astro';
import { snapshot, setText } from '../../state.js';

export const GET: APIRoute = () => {
  return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const PUT: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as { text?: string };
  if (typeof body.text === 'string') setText(body.text);
  return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
