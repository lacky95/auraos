import { createLifecycleHandler } from '@aura/app-sdk';
import { sidecars } from '../../../lib/pocketbase.ts';

// Idempotent — ensureAll() no-ops when the sibling is already running.
export const POST = createLifecycleHandler('onStart', () => {
  void sidecars().ensureAll();
});
