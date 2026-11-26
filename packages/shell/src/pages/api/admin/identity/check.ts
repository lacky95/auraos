import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { ownerAction } from '../../../../lib/approvals/admin.ts';
import { identityCheck } from '../../../../lib/identityReports.ts';

/**
 * The identity invariants (Phase 5 streams I and I.2; D70, D83, D84):
 *
 *   GET → { registry: { users, apps, ownerUid, hwm, maxAllocated, findings },
 *           accounts: { users, owners, members, disabled, findings },
 *           enabledWithoutIdentity, auditUsernameTargets }
 *
 * Counts and findings by id only: never a hash, a username or a record.
 * Read by `diagnose/identity-registry` and `diagnose/identity-accounts`.
 */
export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'identity-check' }, level: 'session', title: 'Check the identity registry and accounts',
  });
  if (actor instanceof Response) return actor;
  return jsonResponse(await identityCheck());
};
