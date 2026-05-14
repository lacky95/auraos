export { OsClient } from './OsClient.js';
// identity-middleware is `.mjs` so app `astro.config.mjs` can import it via
// Node's loader before Astro/Vite take over. Re-export through the package
// barrel so it shows up alongside OsClient.
// @ts-expect-error — JS file, no .d.ts; only consumed from .mjs configs anyway
export { auraIdentityIntegration } from './identity-middleware.mjs';
