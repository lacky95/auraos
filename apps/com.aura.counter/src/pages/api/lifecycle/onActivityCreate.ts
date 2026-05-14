import { createActivityCreateHandler } from '@aura/app-sdk';
import { state } from '../../../state.js';

/**
 * Counter demonstrates *dynamic path*:
 *   - first activity on this instance → '/' (full UI with +/-/RESET)
 *   - additional activities           → '/compact' (read-only view of the shared counter)
 */
export const POST = createActivityCreateHandler(({ activityId }) => {
  const isFirst = state.activities.size === 0;
  state.activities.add(activityId);
  for (const cb of state.listeners) { try { cb(); } catch { /* listener errors are non-fatal */ } }
  const shortId = activityId.split('#').pop() ?? '';
  return {
    path:  isFirst ? '/' : '/compact',
    title: isFirst ? 'Counter (main)' : `Counter (${shortId})`,
    metadata: { count: state.activities.size },
  };
});
