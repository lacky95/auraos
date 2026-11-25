import type { APIRoute } from 'astro';
import { authenticate } from '../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../lib/approvals/admin.ts';
import { bindWorkspace, detachWorkspace, liveAppSourceDeps } from '../../../../lib/appSource.ts';

/**
 * A patch workspace in the calling Terminal (Track P, `aura dev patch start`).
 *
 *   POST   { app, n?, new? } → creates `aura/workspaces/<user>/<installation>/<n>`
 *                              on the app-data volume if missing, and binds it
 *                              writable at /mnt/aura/work/<appId> in THIS
 *                              instance only. The dir starts empty: `aura dev`
 *                              fills it.
 *   DELETE ?app=<id|name>    → detach it (the dir is kept)
 */
const deps = () => liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());

export const POST: APIRoute = ({ params, request }) => bindWorkspace(request, params['instanceId'], deps());
export const DELETE: APIRoute = ({ params, request }) => detachWorkspace(request, params['instanceId'], deps());
