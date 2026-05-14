import type { APIRoute } from 'astro';
import { applyAction, snapshot } from '../../state.js';

export const GET: APIRoute = () => {
  return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as { action?: 'inc' | 'dec' | 'reset' };
  if (body.action === 'inc' || body.action === 'dec' || body.action === 'reset') {
    applyAction(body.action);
  }
  return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
