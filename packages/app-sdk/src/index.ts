export { OsClient } from './OsClient.js';
// Keyboard / Back / system-action namespaces mounted on `osClient.{keymap,nav,system}`.
// Apps that just want to subscribe to a shortcut import only the types.
export { KeymapApi }   from './keymap.js';
export { NavApi }      from './nav.js';
export { SystemApi }   from './system.js';
export { ActivityApi } from './activity.js';
export type {
  KeymapHandler,
  KeymapHandlerCtx,
  KeymapChangeInfo,
} from './keymap.js';
export type {
  BackEvent,
  BackHandler,
} from './nav.js';
export type { NavigateOptions } from './activity.js';

// Lifecycle hook factories — apps use these in place of hand-rolled APIRoutes
// for /api/lifecycle/* files. See ./lifecycle.ts for the full API.
export {
  createHealthEndpoint,
  createLifecycleHandler,
  createActivityCreateHandler,
  createActivityDestroyHandler,
} from './lifecycle.js';
export type {
  LifecycleHookName,
  ActivityCreateRequest,
  ActivityCreateResult,
} from './lifecycle.js';

// Android-`Context`-equivalent: env-var + header readers. See ./context.ts.
export {
  getAppContext,
  readIdentityHeaders,
} from './context.js';
export type {
  AppContext,
  IdentityHeaders,
} from './context.js';

// integration.mjs is `.mjs` so app `astro.config.mjs` can import it via
// Node's loader before Astro/Vite take over. Re-export through the package
// barrel so it shows up alongside OsClient. `auraIdentityIntegration` is a
// back-compat alias for the previous name.
// @ts-expect-error — JS file, no .d.ts; only consumed from .mjs configs anyway
export { auraAppIntegration, auraIdentityIntegration } from './integration.mjs';
