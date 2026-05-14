import type { APIRoute } from 'astro';
import { state } from '../../../state.js';

/**
 * Called when a new activity is opened on this instance.
 * The Counter app demonstrates **dynamic path**:
 *   - First activity → path '/' (full counter UI with +/-/RESET).
 *   - Additional activities → path '/compact' (read-only view of the shared counter).
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as { activityId?: string };
  if (!body.activityId) {
    return new Response(JSON.stringify({}), { status: 200 });
  }

  const isFirst = state.activities.size === 0;
  state.activities.add(body.activityId);
  console.log(`[counter] onActivityCreate ${body.activityId} (total: ${state.activities.size}, first=${isFirst})`);
  for (const cb of state.listeners) { try { cb(); } catch {} }

  const shortId = body.activityId.split('#').pop() ?? '';
  return new Response(JSON.stringify({
    path:  isFirst ? '/' : '/compact',
    title: isFirst ? 'Counter (main)' : `Counter (${shortId})`,
    metadata: { count: state.activities.size },
  }), { status: 200 });
};
