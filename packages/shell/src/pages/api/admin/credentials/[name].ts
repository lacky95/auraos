import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { ownerAction } from '../../../../lib/approvals/admin.ts';
import { liveCredentialDeps, revokeCredential, vaultUserOf } from '../../../../lib/credentials.ts';
import { jsonResponse } from '../../../../lib/appResponse.js';

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * DELETE /api/admin/credentials/<NAME> — revoke a secret (D56): the value,
 * every handle and every read grant. `?app=<appId>`: only that app's handle
 * and read grant. Through the owner's approval dialog from Settings and the
 * CLI; the owner in the desktop and the operator directly (admin.ts).
 */
export const DELETE: APIRoute = async (ctx) => {
  const name = ctx.params['name'];
  if (!core.isCredentialName(name)) return jsonResponse({ error: 'invalid-name' }, 400);
  const app = new URL(ctx.request.url).searchParams.get('app');
  if (app !== null && !APP_ID_RE.test(app)) return jsonResponse({ error: 'invalid-app' }, 400);
  const actor = await ownerAction(ctx, {
    action: 'admin.revoke', payload: { vault: name, ...(app ? { app } : {}) }, level: 'session',
    title: app ? `Revoke ${app}'s access to the secret ${name}` : `Revoke the secret ${name}`,
    details: app
      ? ['Its handle stops working and it can no longer read the value. The secret stays in your vault.']
      : ['The value is deleted from your vault; every app\'s handle and read access ends.'],
  });
  if (actor instanceof Response) return actor;
  const removed = await revokeCredential(liveCredentialDeps(), vaultUserOf(actor.by), name, app, actor.by, actor.detail);
  return jsonResponse({ ok: true, removed });
};
