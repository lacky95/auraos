import type { APIRoute } from 'astro';
import { defaultRedis } from '@aura/kv-store';
import { jsonResponse } from '../../../lib/appResponse.js';
import { ownerAction } from '../../../lib/approvals/admin.ts';
import { readAccessReport } from '../../../lib/access/report.ts';
import { ACCESS_BRIDGE_KEY, type AccessBridgeHost } from '../../../lib/access/types.ts';

/**
 * The aggregated access report (Phase 1, report-only), newest day first.
 *
 *   GET ?days=<1–14, default 1> → { days, samples, pending }
 *
 * An owner view, like /api/admin/audit (D50, lib/approvals/admin.ts).
 * `pending` is what the observer holds in memory until its next flush.
 */
export const GET: APIRoute = async (ctx) => {
  const asked = Number(ctx.url.searchParams.get('days') ?? 1);
  const days = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 14) : 1;
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'access-report', days }, level: 'session', title: 'Show the access report',
    details: [`Days: ${days}`],
  });
  if (actor instanceof Response) return actor;
  let redis: ReturnType<typeof defaultRedis>;
  try { redis = defaultRedis(); } catch { return jsonResponse({ error: 'report-store-unavailable' }, 503); }
  if (redis.status !== 'ready') return jsonResponse({ error: 'report-store-unavailable' }, 503);
  const report = await readAccessReport(redis, days, Date.now());
  const pending = (globalThis as AccessBridgeHost)[ACCESS_BRIDGE_KEY]?.pending?.() ?? null;
  return jsonResponse({ ...report, pending });
};
