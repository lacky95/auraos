import type { APIRoute } from 'astro';
import { authenticate } from '../../../lib/auth.ts';
import { liveOwnerActionDeps } from '../../../lib/approvals/admin.ts';
import { systemMode } from '../../../lib/systemMode.ts';
import { getSystemPatches, liveSystemPatchDeps, postSystemPatches } from '../../../lib/systemPatches.ts';

/** `aura system patch` (Phase 7b, D68): lib/systemPatches.ts. Owner only; activation and enable at `fresh`. */
const deps = () => liveSystemPatchDeps({ authenticate: (r) => authenticate(r), owner: liveOwnerActionDeps(), mode: () => systemMode() });

export const GET: APIRoute = (ctx) => getSystemPatches(ctx, deps());
export const POST: APIRoute = (ctx) => postSystemPatches(ctx, deps());
