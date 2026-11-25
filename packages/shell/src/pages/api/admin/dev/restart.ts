import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { auditOwner, ownerAction } from '../../../../lib/approvals/admin.ts';
import { json } from '../../../../lib/approvals/service.ts';
import { plannedRestart } from '../../../../lib/plannedRestart.js';
import { isDeveloperMode } from '../../../../lib/systemMode.ts';

/**
 * `aura dev rebuild` / `aura dev restart` (D32, D60): Developer Mode only.
 *
 *   POST { build?: boolean, restore?: boolean = true }
 *     build: true → the next boot builds the packages whose sources changed
 *                   (os/boot.sh's build request), then the planned restart
 *     otherwise   → the planned restart alone (lib/plannedRestart.ts): the
 *                   desktop is saved and comes back
 *
 * The owner's (lib/approvals/admin.ts): the CLI in the System Terminal asks
 * for one click, the host operator and the owner in the desktop act directly.
 * 409 outside Developer Mode, and when a restart cannot start. Image rebuilds
 * stay with Settings → About and `aura restart os --rebuild`.
 */
export const POST: APIRoute = async (ctx) => {
  let body: { build?: unknown; restore?: unknown } = {};
  try { body = await ctx.request.json() as typeof body; } catch { /* empty body: defaults */ }
  if (body.build !== undefined && typeof body.build !== 'boolean') return json({ error: 'build must be a boolean' }, 400);
  if (!isDeveloperMode()) {
    return json({ ok: false, error: 'not-developer-mode', message: 'aura dev rebuild and restart need Developer Mode (Settings → System, or aura mode developer).' }, 409);
  }
  const build = body.build === true;
  const restore = body.restore !== false;
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: build ? 'dev.rebuild' : 'dev.restart', restore },
    title: build ? 'Rebuild and restart AuraOS' : 'Restart AuraOS',
    details: [
      ...(build ? ['The packages whose sources changed in /workspace are built while AuraOS starts again.'] : []),
      restore ? 'Your desktop is saved and comes back after the restart.' : 'AuraOS comes back with an empty desktop.',
    ],
  });
  if (actor instanceof Response) return actor;
  if (build) new core.SelfUpdater(process.env['AURA_DATA_DIR'] ?? '/data').requestBootBuild('dev-rebuild');
  const res = await plannedRestart({ mode: 'restart', restore });
  await auditOwner(actor, build ? 'dev.rebuild' : 'dev.restart', { outcome: res.ok ? 'ok' : 'failed', detail: { restore } });
  if (!res.ok) return json({ ok: false, error: res.error }, 409);
  return json({ ok: true, build, activities: res.activities }, 202);
};
