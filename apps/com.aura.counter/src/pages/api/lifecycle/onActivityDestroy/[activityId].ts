import { createActivityDestroyHandler } from '@aura/app-sdk';
import { state } from '../../../../state.js';

export const POST = createActivityDestroyHandler((activityId) => {
  if (state.activities.delete(activityId)) {
    for (const cb of state.listeners) { try { cb(); } catch { /* listener errors are non-fatal */ } }
  }
});
