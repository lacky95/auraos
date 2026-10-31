import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';
import { parseIdentity } from '../../../lib/nexusIdentity.js';

/**
 * Install an app from a Nexus ref.
 *
 * POST body:
 *   { ref: string, scope?: 'global' | 'user', autoApprove?: boolean,
 *     identity?: { action: 'update-existing' | 'install-as' | 'install-copy', appId?: string } }
 *
 * Returns one of:
 *   { ok: true, record: InstallRecord }
 *   { ok: false, needsApproval: true, diff: PermissionDiff }
 *   { ok: false, needsIdentityChoice: true, conflict: IdentityConflict }
 *       the app shares an id or originId with an installed app (scenarios A,
 *       B, D — core AppIdentity). Nothing was installed; POST again with
 *       `identity` set to one of `conflict.choices`.
 *   { ok: false, error: string }
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    ref?:         string;
    scope?:       string;
    autoApprove?: boolean;
    identity?:    unknown;
  };
  if (!body.ref || typeof body.ref !== 'string') {
    return errorResponse('missing or invalid `ref`', 400);
  }
  if (body.scope === 'system') {
    return errorResponse('cannot install into system scope', 400);
  }
  const scope = (body.scope === 'user' ? 'user' : 'global') as 'global' | 'user';

  const identity = parseIdentity(body.identity);
  if (identity instanceof Response) return identity;

  const nexus = getNexusManager();
  const it = nexus.install({ ref: body.ref, scope, autoApprove: body.autoApprove, ...(identity ? { identity } : {}) });

  try {
    let cursor = await it.next();
    while (!cursor.done) {
      const ev = cursor.value;
      if (ev.type === 'identity.choice') {
        await it.return(undefined as never).catch(() => undefined);
        return jsonResponse({ ok: false, needsIdentityChoice: true, conflict: ev.conflict });
      }
      if (ev.type === 'permission.needed') {
        await it.return(undefined as never).catch(() => undefined);
        return jsonResponse({ ok: false, needsApproval: true, diff: ev.diff });
      }
      if (ev.type === 'error') {
        return errorResponse(ev.message, 500);
      }
      if (ev.type === 'install.done') {
        return jsonResponse({ ok: true, record: ev.record });
      }
      cursor = await it.next();
    }
    return jsonResponse({ ok: true, record: cursor.value });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
