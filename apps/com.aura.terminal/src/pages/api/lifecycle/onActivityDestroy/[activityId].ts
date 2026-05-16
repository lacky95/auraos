import { createActivityDestroyHandler } from '@aura/app-sdk';
import { killSession } from '../../../../pty-server.js';

/**
 * Called by the OS when the user closes the terminal activity. The PTY
 * registry in pty-server.ts keeps shells alive across browser reload via
 * the activity id as a session key — when the activity is gone for real,
 * we need to free the resources.
 */
export const POST = createActivityDestroyHandler((activityId) => {
  killSession(activityId);
});
