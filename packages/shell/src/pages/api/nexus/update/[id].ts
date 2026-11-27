import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { errorResponse } from '../../../../lib/appResponse.js';
import { authenticate } from '../../../../lib/auth.ts';
import { parseIdentity } from '../../../../lib/nexusIdentity.js';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { installGate, runInstall } from '../../../../lib/approvals/nexus.ts';

/**
 * Update an installed app to the latest version on its stored ref + channel.
 * Same protocol as /install, approval included (D31): `{ ok, record }`, 202
 * needs-approval (then again with `X-Aura-Approval`), or
 * `{ ok: false, needsIdentityChoice: true, conflict }` when the source now
 * serves a different app under this id (re-POST with `identity`).
 * A dev checkout (`aura dev checkout`) answers 409 unless `force: true`.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const id = params['id'];
  if (!id) return errorResponse('missing app id', 400);
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  const body = await request.json().catch(() => ({})) as { force?: boolean; identity?: unknown; operatorCode?: unknown };
  const identity = parseIdentity(body.identity);
  if (identity instanceof Response) return identity;

  const nexus = getNexusManager();
  if (!nexus.records.get(id)) {
    return errorResponse(`app '${id}' has no Nexus install record — cannot auto-update`, 404);
  }

  const gate = installGate(liveApprovalDeps(), principal, request, body.operatorCode);
  return runInstall(nexus.update(id, {
    approval: gate.approval, ...(identity ? { identity } : {}), ...(body.force === true ? { replaceCheckout: true } : {}),
  }), gate, (ev) => (ev.code === 'dev-checkout' ? 409 : 500), { request, locals });
};
