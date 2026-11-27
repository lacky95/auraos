import type { APIRoute } from 'astro';
import { liveReleaseDeps, postActivate } from '../../../../lib/release/releaseAdmin.ts';

/** `POST /api/admin/release/activate` { releaseId, when? }: approval `system.release.activate` (forced), then the switch. */
export const POST: APIRoute = async (ctx) => {
  let body: Record<string, unknown> = {};
  try { body = (await ctx.request.json()) as Record<string, unknown> ?? {}; } catch { /* empty body */ }
  return postActivate(ctx, liveReleaseDeps(), body && typeof body === 'object' ? body : {});
};
