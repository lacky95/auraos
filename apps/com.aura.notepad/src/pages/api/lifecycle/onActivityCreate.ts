import type { APIRoute } from 'astro';
import { state } from '../../../state.js';

/**
 * Called by the OS when a new activity is opened on this app instance.
 * Body: `{ activityId, data? }`. We may return `{ path, title, metadata }`.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    activityId?: string;
    data?: Record<string, unknown>;
  };
  if (body.activityId) {
    state.activities.add(body.activityId);
    console.log(`[notepad] onActivityCreate ${body.activityId} (total: ${state.activities.size})`);
    for (const cb of state.listeners) { try { cb(); } catch {} }
  }
  // Notepad is one shared buffer — all activities land on '/'.
  // (Demonstration: return a friendly title that includes the activity number.)
  const shortId = body.activityId?.split('#').pop() ?? '';
  return new Response(JSON.stringify({
    path: '/',
    title: `Notepad ${shortId}`,
    metadata: { count: state.activities.size },
  }), { status: 200 });
};
