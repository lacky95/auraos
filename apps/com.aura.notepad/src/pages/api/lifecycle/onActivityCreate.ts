import { createActivityCreateHandler } from '@aura/app-sdk';
import { state } from '../../../state.js';

/**
 * One shared buffer — every activity lands on '/'. Returned title carries
 * the short activity index purely as a window-chrome hint.
 */
export const POST = createActivityCreateHandler(({ activityId }) => {
  state.activities.add(activityId);
  for (const cb of state.listeners) { try { cb(); } catch { /* listener errors are non-fatal */ } }
  const shortId = activityId.split('#').pop() ?? '';
  return {
    path:  '/',
    title: `Notepad ${shortId}`,
    metadata: { count: state.activities.size },
  };
});
