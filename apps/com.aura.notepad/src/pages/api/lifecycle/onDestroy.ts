import { createLifecycleHandler } from '@aura/app-sdk';
import { clearAll } from '../../../state.js';
export const POST = createLifecycleHandler('onDestroy', () => { clearAll(); });
