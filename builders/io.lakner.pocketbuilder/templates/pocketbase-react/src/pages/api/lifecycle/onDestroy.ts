import { createLifecycleHandler } from '@aura/app-sdk';
import { sidecars } from '../../../lib/pocketbase.ts';

// Remove the sibling container. The OS also reaps anything labelled
// `aura.parent=<instanceId>`, so this is belt-and-braces.
export const POST = createLifecycleHandler('onDestroy', async () => {
  await sidecars().teardownAll();
});
