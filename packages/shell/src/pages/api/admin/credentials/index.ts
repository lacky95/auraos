import type { APIRoute } from 'astro';
import { ownerAction } from '../../../../lib/approvals/admin.ts';
import { listCredentials, liveCredentialDeps, vaultUserOf } from '../../../../lib/credentials.ts';
import { jsonResponse } from '../../../../lib/appResponse.js';

/**
 * GET /api/admin/credentials — the owner's personal vault (D56): each
 * secret's name, the apps holding a handle (and whether each may read the
 * value), and its last use. Never a value or a handle. The owner, Settings
 * through D45, the operator directly; the CLI with an approval (admin.ts).
 */
export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, { action: 'admin.read', payload: { view: 'credentials' }, level: 'session', title: 'Show your secrets (names and use, no values)' });
  if (actor instanceof Response) return actor;
  const credentials = await listCredentials(liveCredentialDeps(), vaultUserOf(actor.by));
  return jsonResponse({ credentials });
};
