import { createNextHealthRoute } from '@aura/app-sdk/runtime/next';

// GET /api/lifecycle/health — the spawn-time identity gate. The body
// { ok, appId, instanceId } is verified by `verifyHealthIdentity` in
// packages/core/src/app-manager/ProotRunner.ts; a mismatch fails the
// spawn so we can't accidentally route to a port squatter.
export const { GET } = createNextHealthRoute();
