import type { APIRoute } from 'astro';
import { liveReleaseDeps, postBuild } from '../../../../lib/release/releaseAdmin.ts';

/** `POST /api/admin/release/build` { ref?, maturity? }: build a release (the owner decides, one click). */
export const POST: APIRoute = async (ctx) => {
  let body: Record<string, unknown> = {};
  try { body = (await ctx.request.json()) as Record<string, unknown> ?? {}; } catch { /* empty body */ }
  return postBuild(ctx, liveReleaseDeps(), body && typeof body === 'object' ? body : {});
};
