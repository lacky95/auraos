import type { APIRoute } from 'astro';
import { liveReleaseDeps, postRollback } from '../../../../lib/release/releaseAdmin.ts';

/** `POST /api/admin/release/rollback` { restoreData?, confirmInsecure? }: the owner at `fresh` (Q35, 5b answer 1). */
export const POST: APIRoute = async (ctx) => {
  let body: Record<string, unknown> = {};
  try { body = (await ctx.request.json()) as Record<string, unknown> ?? {}; } catch { /* empty body */ }
  return postRollback(ctx, liveReleaseDeps(), body && typeof body === 'object' ? body : {});
};
