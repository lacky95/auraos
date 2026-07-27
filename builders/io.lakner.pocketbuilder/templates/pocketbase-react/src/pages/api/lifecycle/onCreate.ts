import { createLifecycleHandler } from '@aura/app-sdk';
import { sidecars } from '../../../lib/pocketbase.ts';

// Bring PocketBase up as soon as the instance is created. Fire-and-forget:
// the first run may pull a multi-hundred-MB image and the OS health window
// is 60s — ensureAll() reports progress through `sidecars().phase` instead.
export const POST = createLifecycleHandler('onCreate', () => {
  void sidecars().ensureAll();
});
