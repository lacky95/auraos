import type { APIRoute } from 'astro';
import { state } from '../../../state.js';
export const POST: APIRoute = () => {
  state.activities.clear();
  console.log('[notepad] onDestroy — cleared activity set');
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
