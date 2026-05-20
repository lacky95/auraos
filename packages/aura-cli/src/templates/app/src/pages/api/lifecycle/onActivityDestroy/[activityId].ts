import { createActivityDestroyHandler } from '@aura/app-sdk';

/**
 * Called by the OS when an activity is closed — either by the user (X
 * button on the slot, panel close) or programmatically via the SDK.
 * The handler runs server-side INSIDE this app's process, so it's the
 * right place to free per-activity resources (DB rows, sockets, etc.).
 *
 * Default impl is a no-op — replace with real teardown when the app
 * starts holding per-activity state.
 */
export const POST = createActivityDestroyHandler(async (_activityId) => {});
