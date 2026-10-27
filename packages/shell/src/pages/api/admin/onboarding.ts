import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../lib/appResponse.js';
import { auditAdmin, requireAdmin } from '../../../lib/auth.js';
import { resetOnboarding } from '../../../lib/onboarding/index.js';
import { readOnboarding } from '../../../lib/onboarding/state.js';

/**
 * Onboarding state (lib/onboarding).
 *
 *   GET                       → { setupDoneAt?, welcome: { hidden?, done } }
 *   POST reset                → (admin) the welcome checklist starts over and
 *                               shows again now
 *   POST reset {setup: true}  → (admin) also the first-boot setup card, on the
 *                               next shell boot
 */
export const GET: APIRoute = async () => jsonResponse(await readOnboarding() ?? { welcome: { done: {} } });

export const POST: APIRoute = async ({ request }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  const body = await request.json().catch(() => ({})) as { setup?: unknown };
  const setup = body.setup === true;
  await resetOnboarding({ setup });
  await auditAdmin(p, 'onboarding.reset', { detail: { setup } });
  return jsonResponse({ ok: true, state: await readOnboarding() });
};
