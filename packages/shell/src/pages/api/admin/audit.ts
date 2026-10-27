import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { requireAdmin } from '../../../lib/auth.js';

/**
 * The admin audit trail (`audit:admin` Valkey stream), newest first.
 *
 *   GET ?limit=<1–1000, default 100> → { entries: AuditEntry[] }
 *
 * Needs an admin session. The actor of every entry is "admin (shared
 * credential)" (or `system` / `anonymous` for rotation and failed unlocks);
 * no entry names an individual person.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  const limit = Number(url.searchParams.get('limit') ?? 100);
  return jsonResponse({ entries: await core.getAuthServices().audit.list(limit) });
};
