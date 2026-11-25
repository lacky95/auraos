import type { APIRoute } from 'astro';
import { authenticate } from '../../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../../lib/approvals/admin.ts';
import { cleanWorkspaces, liveAppSourceDeps } from '../../../../../lib/appSource.ts';

/**
 * Delete old patch workspaces (Track P, `aura dev patch clean`).
 *
 *   POST { app, keep? = 3 } → deletes the calling user's workspaces of the
 *        app's installation, except the one bound in THIS instance and the
 *        newest `keep`; one bound in another instance is detached first.
 *        200 { ok, appId, installationId, kept: n[], deleted: n[], detached }
 */
const deps = () => liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());

export const POST: APIRoute = ({ params, request }) => cleanWorkspaces(request, params['instanceId'], deps());
