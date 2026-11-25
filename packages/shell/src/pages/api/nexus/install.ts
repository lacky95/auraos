import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { errorResponse } from '../../../lib/appResponse.js';
import { authenticate } from '../../../lib/auth.ts';
import { parseIdentity } from '../../../lib/nexusIdentity.js';
import { liveApprovalDeps } from '../../../lib/approvals/service.ts';
import { installGate, runInstall } from '../../../lib/approvals/nexus.ts';

/**
 * Install an app from a Nexus ref. Every install needs the owner's approval
 * of the exact artifact, scope and permissions (D31, lib/approvals/nexus.ts).
 *
 * POST body:
 *   { ref: string, scope?: 'global' | 'user', force?: boolean,
 *     identity?: { action: 'update-existing' | 'install-as' | 'install-copy', appId?: string },
 *     operatorCode?: string }
 * Header `X-Aura-Approval: <id>`: the approved request this install uses up.
 *
 * Returns one of:
 *   200 { ok: true, record: InstallRecord }
 *   202 { ok: false, error: 'needs-approval', needsApproval: true, approvalId, level, expiresAt, display, diff }
 *       the owner decides in the desktop (or `aura approve <id>` on the host);
 *       then POST the same body again with the header
 *   202 { ..., operatorOnly: true, operatorSubject } for a caller with no
 *       requester identity (the host CLI): an operator code for that subject
 *   200 { ok: false, needsIdentityChoice: true, conflict: IdentityConflict }
 *       the app shares an id or originId with an installed app (scenarios A,
 *       B, D — core AppIdentity). Nothing was installed; POST again with
 *       `identity` set to one of `conflict.choices`.
 *   4xx/5xx { error: string }
 *
 * `force` replaces an app that is a dev checkout (`aura dev checkout`); without
 * it such an install fails rather than overwriting the working tree.
 */
export const POST: APIRoute = async ({ request }) => {
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  const body = await request.json().catch(() => ({})) as {
    ref?:          string;
    scope?:        string;
    force?:        boolean;
    identity?:     unknown;
    operatorCode?: unknown;
  };
  if (!body.ref || typeof body.ref !== 'string') {
    return errorResponse('missing or invalid `ref`', 400);
  }
  if (body.scope === 'system') {
    return errorResponse('cannot install into system scope', 400);
  }
  const scope = (body.scope === 'user' ? 'user' : 'global') as 'global' | 'user';

  const identity = parseIdentity(body.identity);
  if (identity instanceof Response) return identity;

  const gate = installGate(liveApprovalDeps(), principal, request, body.operatorCode);
  return runInstall(getNexusManager().install({
    ref: body.ref, scope, approval: gate.approval,
    ...(identity ? { identity } : {}), ...(body.force === true ? { replaceCheckout: true } : {}),
  }), gate);
};
