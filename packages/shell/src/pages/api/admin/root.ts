import type { APIRoute } from 'astro';
import { endRootTabs, listRootTabs, postRootTab } from '../../../lib/rootTabs.ts';

/** `aura root` (Phase 5 stream J.6): grant, list and End root tabs (lib/rootTabs.ts). */
export const GET: APIRoute = (ctx) => listRootTabs(ctx);
export const POST: APIRoute = (ctx) => postRootTab(ctx);
export const DELETE: APIRoute = (ctx) => endRootTabs(ctx);
