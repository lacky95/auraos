import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { ownerAction } from '../../../lib/approvals/admin.ts';

/**
 * The audit trail (`audit:admin` Valkey stream), newest first.
 *
 *   GET ?limit=<1–1000, default 100> → { entries: AuditEntry[] }
 *
 * An owner view (D50, lib/approvals/admin.ts): the owner, the host operator
 * and Settings read it directly; an app asks the owner for one click. Each
 * entry names the owner `user:<id>`, the `operator`, `system` or `anonymous`
 * (entries from before D50 may name "admin (shared credential)").
 */
export const GET: APIRoute = async (ctx) => {
  const limit = Number(ctx.url.searchParams.get('limit') ?? 100);
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'audit', limit }, level: 'session', title: 'Show the audit trail',
  });
  if (actor instanceof Response) return actor;
  return jsonResponse({ entries: await core.getAuthServices().audit.list(limit) });
};
