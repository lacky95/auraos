import type { APIRoute } from 'astro';
import { state } from '../../../../state.js';

export const POST: APIRoute = ({ params }) => {
  const raw = params['activityId'];
  const id  = raw ? decodeURIComponent(raw) : undefined;
  if (id && state.activities.delete(id)) {
    console.log(`[notepad] onActivityDestroy ${id} (remaining: ${state.activities.size})`);
    for (const cb of state.listeners) { try { cb(); } catch {} }
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
