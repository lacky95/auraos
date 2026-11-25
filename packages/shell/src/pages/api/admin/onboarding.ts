import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../lib/appResponse.js';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import { resetOnboarding } from '../../../lib/onboarding/index.js';
import { readOnboarding } from '../../../lib/onboarding/state.js';

/**
 * Onboarding state (lib/onboarding).
 *
 *   GET                       → { setupDoneAt?, welcome: { hidden?, done } }
 *   POST reset                → (owner) the welcome checklist starts over and
 *                               shows again now
 *   POST reset {setup: true}  → (owner) also the first-boot setup card, on the
 *                               next shell boot
 * A reset from an app needs the owner's approval (D50, lib/approvals/admin.ts).
 */
export const GET: APIRoute = async () => jsonResponse(await readOnboarding() ?? { welcome: { done: {} } });

export const POST: APIRoute = async (ctx) => {
  const body = await ctx.request.json().catch(() => ({})) as { setup?: unknown };
  const setup = body.setup === true;
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'onboarding.reset', setup },
    title: 'Reset onboarding', details: [setup ? 'The welcome checklist and the first-boot setup card start over.' : 'The welcome checklist starts over.'],
  });
  if (actor instanceof Response) return actor;
  await resetOnboarding({ setup });
  await auditOwner(actor, 'onboarding.reset', { detail: { setup } });
  return jsonResponse({ ok: true, state: await readOnboarding() });
};
