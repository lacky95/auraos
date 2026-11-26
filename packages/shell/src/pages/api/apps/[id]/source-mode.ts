import type { APIRoute } from 'astro';
import { authenticate } from '../../../../lib/auth.ts';
import { liveApprovalDeps } from '../../../../lib/approvals/service.ts';
import { liveOwnerActionDeps } from '../../../../lib/approvals/admin.ts';
import { liveAppSourceDeps, setSourceMode } from '../../../../lib/appSource.ts';

/**
 * Open or close an installed app's source (Track P, `aura dev open|close`).
 *
 *   POST { mode: 'open' | 'closed' } → { ok, appId, mode, defaultMode }
 *
 * Opening is the owner's decision (`app.source.open`, D9: one click, the
 * password for Settings, Terminal and Nexus): from the CLI it answers 202
 * needs-approval, then the same request with `X-Aura-Approval`. Closing needs
 * nobody, and writable views of the app come back read-only. A system app
 * stays closed (409): patch it, and activation makes the user's own copy.
 */
const deps = () => liveAppSourceDeps((r) => authenticate(r), liveApprovalDeps(), liveOwnerActionDeps());

export const POST: APIRoute = (ctx) => setSourceMode(ctx, ctx.params['id'], deps());
