import type { APIRoute } from 'astro';
import { authenticate } from '../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../lib/approvals/admin.ts';
import { activatePrepared, liveAppSourceDeps } from '../../../../lib/appSource.ts';

/**
 * Install a prepared app tree (Track P, `aura dev patch activate`).
 *
 *   POST { workspace: n } | { rollback: true }  [identity?, operatorCode?]
 *
 * Workspace `n` of the caller's user and the app's installation (or the
 * newest tree an earlier install moved aside) goes through the Nexus install
 * pipeline, action `app.patch.activate`: the owner approves the exact tree
 * (D9: one click; the password for Settings, Terminal, Nexus, a change of
 * tools or permissions, Docker or every tool), then an atomic swap with the
 * runtime data carried over and the previous tree kept for rollback. A
 * built-in app is refused (409 `system-app-later`, Q6). No restart:
 * `running` lists the instances to restart.
 *
 *   200 { ok, record, scope, rollbackTree, running }
 *   202 needs-approval (as /api/nexus/install), then again with X-Aura-Approval
 */
const deps = () => liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());

export const POST: APIRoute = ({ params, request }) => activatePrepared(request, params['id'], deps());
