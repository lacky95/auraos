import type { APIRoute } from 'astro';
import { authenticate } from '../../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../../lib/approvals/admin.ts';
import { cleanWorkspaces, liveAppSourceDeps } from '../../../../../lib/appSource.ts';

/**
 * Delete old patch workspaces (Track P, `aura dev patch clean`).
 *
 *   POST { app, keep? = 3, dryRun?, delete?: n[], force? }
 *        Candidates: the calling user's workspaces of the app's installation,
 *        except the one bound in THIS instance and the newest `keep`. One bound
 *        in another instance is `inUse`: kept unless `force` (detached first).
 *        `dryRun` only reports; `delete` limits it to those numbers (`aura dev`
 *        leaves out the ones with unsaved work).
 *        200 { ok, appId, installationId, kept, candidates, inUse, deleted, detached }
 */
const deps = () => liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());

export const POST: APIRoute = ({ params, request }) => cleanWorkspaces(request, params['instanceId'], deps());
