import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readJson } from '../../../lib/notificationCaller.js';
import { auditAdmin, requireAdmin } from '../../../lib/auth.js';

/**
 * API keys for external REST callers. Every method needs an admin session.
 *
 *   GET    → { scopes, keys: ApiKeyRecord[] }   (never secrets or hashes)
 *   POST   {name, scopes[]} → 201 { key, apiKey }
 *            `key` (aura_k1_…) is shown ONCE — only its hash is stored.
 *   DELETE ?id=<keyId> (or body {id}) → revoke: the key gets 401 at once;
 *            its grants are dropped too.
 *
 * A key authenticates as `Authorization: Bearer aura_k1_…` (verified sender
 * kind `rest`). Audited as "admin (shared credential)".
 */
function fail(err: unknown): Response {
  const status = (err as { status?: unknown }).status;
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: message }, typeof status === 'number' ? status : 500);
}

export const GET: APIRoute = async ({ request }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  return jsonResponse({ scopes: core.API_KEY_SCOPES, keys: await core.getAuthServices().apiKeys.list() });
};

export const POST: APIRoute = async ({ request }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const scopes = Array.isArray(body['scopes']) ? body['scopes'].map(String) : ['system.notifications'];
  try {
    const r = await core.getAuthServices().apiKeys.create({ name: String(body['name'] ?? ''), scopes, by: core.adminAttribution(p) });
    await auditAdmin(p, 'apiKey.create', { target: `apiKey:${r.apiKey.id}`, detail: { name: r.apiKey.name, scopes: r.apiKey.scopes } });
    return jsonResponse({ ok: true, ...r }, 201);
  } catch (err) {
    return fail(err);
  }
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  let id = url.searchParams.get('id') ?? '';
  if (!id) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    id = String(body['id'] ?? '');
  }
  const svc = core.getAuthServices();
  const rec = await svc.apiKeys.revoke(id);
  if (!rec) return jsonResponse({ error: `unknown API key ${id}` }, 404);
  const droppedGrants = await svc.grants.revokeAll({ kind: 'apiKey', id: rec.id });
  await auditAdmin(p, 'apiKey.revoke', { target: `apiKey:${rec.id}`, detail: { name: rec.name, droppedGrants } });
  return jsonResponse({ ok: true, apiKey: rec, droppedGrants });
};
