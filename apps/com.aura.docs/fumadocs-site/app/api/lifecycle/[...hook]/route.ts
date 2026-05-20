import { createNextLifecycleRoutes } from '@aura/app-sdk/runtime/next';

// Catch-all for every POST /api/lifecycle/<hook> the AppManager fires:
// onCreate, onStart, onResume, onPause, onStop, onDestroy, plus the two
// activity hooks (onActivityCreate, onActivityDestroy/[activityId]). The
// factory returns `{ ok: true }` for everything; pass an `impl` object to
// override individual hooks when this app grows real teardown logic.
export const { POST } = createNextLifecycleRoutes();
