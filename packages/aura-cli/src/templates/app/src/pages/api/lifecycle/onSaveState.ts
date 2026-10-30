import type { APIRoute } from 'astro';

/**
 * Called by the OS just before a planned restart (`aura restart os`, About →
 * Restart), with the ids of this instance's activities: `{ activityIds }`.
 * Return each activity's state as `{ ok: true, states: { [activityId]: json } }`
 * (≤ 64 KB each); after the restart the OS recreates the activity and hands it
 * back in `onActivityCreate` as `restore.state`.
 *
 * Optional: the better way is to save an activity's state whenever it changes —
 * `osClient.activity.saveState(state)` in the page, or PUT
 * /api/activities/<id>/state — which also survives a crash. This hook is the
 * catch-up for state that is too expensive to push on every change. It gets
 * about 2 seconds.
 */
export const POST: APIRoute = async ({ request }) => {
  const { activityIds = [] } = await request.json().catch(() => ({})) as { activityIds?: string[] };
  const states: Record<string, unknown> = {};
  for (const id of activityIds) {
    // states[id] = { … what this activity needs to come back … };
    void id;
  }
  return new Response(JSON.stringify({ ok: true, states }), { headers: { 'Content-Type': 'application/json' } });
};
