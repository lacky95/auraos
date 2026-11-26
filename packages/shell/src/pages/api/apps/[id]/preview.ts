import type { APIRoute } from 'astro';
import { authenticate } from '../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../lib/approvals/admin.ts';
import { liveAppSourceDeps, startPreview, stopPreviews } from '../../../../lib/appSource.ts';

/**
 * A preview of a patch workspace (Track P, `aura dev patch preview`).
 *
 *   POST { workspace: n }  → the caller's own workspace `n` runs as a separate
 *                            instance of the app (own App Host slot, a copy of
 *                            the data, marked "Preview"); no approval, nothing
 *                            installed.  200 { ok, appId, instanceId, workspace }
 *   DELETE [?user=]        → stop the caller's previews of the app (the owner
 *                            may name a user).  200 { ok, stopped }
 */
const deps = () => liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());

export const POST: APIRoute = ({ params, request }) => startPreview(request, params['id'], deps());
export const DELETE: APIRoute = ({ params, request }) => stopPreviews(request, params['id'], deps());
