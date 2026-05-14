/**
 * Default `/api/lifecycle/health` route injected by `auraAppIntegration`.
 * Apps that want custom health logic can still ship their own
 * `src/pages/api/lifecycle/health.ts` — Astro's filesystem routes win over
 * integration-injected ones on path collision.
 */

import { createHealthEndpoint } from '../lifecycle.js';

export const GET = createHealthEndpoint();
