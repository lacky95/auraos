import type { APIRoute } from 'astro';
import { liveReleaseDeps, postAcceptWrites } from '../../../../lib/release/releaseAdmin.ts';

/**
 * `POST /api/admin/release/accept-writes` { jobId? }: the updater's operator
 * ticket once the release is healthy; the owner (`fresh`) only after an
 * abandoned activation.
 */
export const POST: APIRoute = async (ctx) => {
  let body: Record<string, unknown> = {};
  try { body = (await ctx.request.json()) as Record<string, unknown> ?? {}; } catch { /* empty body */ }
  return postAcceptWrites(ctx, liveReleaseDeps(), body && typeof body === 'object' ? body : {});
};
