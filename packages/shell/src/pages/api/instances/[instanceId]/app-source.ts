import type { APIRoute } from 'astro';
import { authenticate } from '../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../lib/approvals/admin.ts';
import { appSourceStatus, liveAppSourceDeps } from '../../../../lib/appSource.ts';

/**
 * Where an agent finds an app's source (Track P, `aura dev status <app>`).
 *
 *   GET  ?app=<id|name>  → the app's source mode, installation, upstream, the
 *                          caller's source view and workspace (nothing changes)
 *   POST { app }         → the same, after making sure the source view is bound
 *                          into THIS instance at /mnt/aura/<appId>: read-only
 *                          for a closed install, writable for an open one
 *                          (the owner's Terminal only)
 *
 * lib/appSource.ts has the handler; the contract is in trackp-streams.md.
 */
const deps = () => liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());

export const GET: APIRoute = ({ params, request }) => appSourceStatus(request, params['instanceId'], deps(), false);
export const POST: APIRoute = ({ params, request }) => appSourceStatus(request, params['instanceId'], deps(), true);
