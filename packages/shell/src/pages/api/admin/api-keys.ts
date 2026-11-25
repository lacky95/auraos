import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readJson } from '../../../lib/notificationCaller.js';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';

/**
 * API keys for external REST callers. Who may call, as every owner-management
 * route (D50, lib/approvals/admin.ts): the owner and the host operator
 * directly, a read through Settings directly, everything else with the
 * owner's approval. Creating a key needs the password (`fresh`).
 *
 *   GET    → { scopes, keys: ApiKeyRecord[] }   (never secrets or hashes)
 *   POST   {name, scopes[]} → 201 { key, apiKey }
 *            `key` (aura_k1_…) is shown ONCE — only its hash is stored.
 *   DELETE ?id=<keyId> (or body {id}) → revoke: the key gets 401 at once;
 *            its grants are dropped too.
 *
 * A key authenticates as `Authorization: Bearer aura_k1_…` (verified sender
 * kind `rest`). The record and the audit name the owner (or the operator).
 */
function fail(err: unknown): Response {
  const status = (err as { status?: unknown }).status;
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: message }, typeof status === 'number' ? status : 500);
}

export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, { action: 'admin.read', payload: { view: 'api-keys' }, level: 'session', title: 'Show the API keys' });
  if (actor instanceof Response) return actor;
  return jsonResponse({ scopes: core.API_KEY_SCOPES, keys: await core.getAuthServices().apiKeys.list() });
};

export const POST: APIRoute = async (ctx) => {
  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;
  const scopes = Array.isArray(body['scopes']) ? body['scopes'].map(String) : ['system.notifications'];
  const name = String(body['name'] ?? '');
  const actor = await ownerAction(ctx, {
    action: 'admin.api-key', level: 'fresh', payload: { op: 'create', name, scopes },
    title: `Create the API key "${name}"`,
    details: [`Scopes: ${scopes.join(', ') || 'none'}`, 'The key is shown once, to the caller that asked.'],
  });
  if (actor instanceof Response) return actor;
  try {
    const r = await core.getAuthServices().apiKeys.create({ name, scopes, by: actor.by });
    await auditOwner(actor, 'apiKey.create', { target: `apiKey:${r.apiKey.id}`, detail: { name: r.apiKey.name, scopes: r.apiKey.scopes } });
    return jsonResponse({ ok: true, ...r }, 201);
  } catch (err) {
    return fail(err);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  let id = ctx.url.searchParams.get('id') ?? '';
  if (!id) {
    const body = await readJson(ctx.request);
    if (body instanceof Response) return body;
    id = String(body['id'] ?? '');
  }
  const svc = core.getAuthServices();
  const known = await svc.apiKeys.get(id);
  if (!known) return jsonResponse({ error: `unknown API key ${id}` }, 404);
  const actor = await ownerAction(ctx, {
    action: 'admin.api-key', level: 'session', payload: { op: 'revoke', id },
    title: `Revoke the API key "${known.name}"`, details: [`Key: ${id}`, 'It gets 401 at once, and its grants are dropped.'],
  });
  if (actor instanceof Response) return actor;
  const rec = await svc.apiKeys.revoke(id);
  if (!rec) return jsonResponse({ error: `unknown API key ${id}` }, 404);
  const droppedGrants = await svc.grants.revokeAll({ kind: 'apiKey', id: rec.id });
  await auditOwner(actor, 'apiKey.revoke', { target: `apiKey:${rec.id}`, detail: { name: rec.name, droppedGrants } });
  return jsonResponse({ ok: true, apiKey: rec, droppedGrants });
};
