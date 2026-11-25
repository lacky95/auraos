import type { APIRoute } from 'astro';
import { defaultRedis } from '@aura/kv-store';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readAccessReport } from '../../../lib/access/report.ts';
import { ACCESS_BRIDGE_KEY, type AccessBridgeHost } from '../../../lib/access/types.ts';

/**
 * The aggregated access report (Phase 1, report-only), newest day first.
 *
 *   GET ?days=<1–14, default 1> → { days, samples, pending }
 *
 * Needs an admin session, like /api/admin/audit. `pending` is what the
 * observer holds in memory until its next flush.
 */
export const GET: APIRoute = async ({ url }) => {
  const asked = Number(url.searchParams.get('days') ?? 1);
  const days = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 14) : 1;
  let redis: ReturnType<typeof defaultRedis>;
  try { redis = defaultRedis(); } catch { return jsonResponse({ error: 'report-store-unavailable' }, 503); }
  if (redis.status !== 'ready') return jsonResponse({ error: 'report-store-unavailable' }, 503);
  const report = await readAccessReport(redis, days, Date.now());
  const pending = (globalThis as AccessBridgeHost)[ACCESS_BRIDGE_KEY]?.pending?.() ?? null;
  return jsonResponse({ ...report, pending });
};
