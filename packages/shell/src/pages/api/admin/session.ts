import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readJson } from '../../../lib/notificationCaller.js';
import { auditAdmin, requireAdmin } from '../../../lib/auth.js';
import { markWelcomeStep } from '../../../lib/onboarding/index.js';

/**
 * Admin unlock / lock (minimal admin auth — ONE shared operator credential,
 * no user accounts).
 *
 *   POST   {credential} → 200 {token, expiresAt, ttlMs}
 *            401 wrong credential · 429 too many failed attempts
 *            The token is a short-lived session (15 min, not renewed): send it
 *            as `Authorization: Bearer <token>` to the /api/admin/* routes.
 *            Never a cookie (the shell proxy forwards headers to app upstreams).
 *   GET    (with session) → {admin:true, expiresAt}; without → 401
 *   DELETE (with session) → lock: the session stops working at once
 *
 * The credential is in <dataDir>/aura/secrets/admin.key in the master
 * container (aura-shell) — read it there (`aura jump -m`, then
 * `aura admin credential`). Rotate with `aura admin rotate` (master only).
 * Every unlock / lock / failed attempt is audited as "admin (shared credential)".
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const credential = body['credential'];
  const { admin } = core.getAuthServices();
  admin.ensure();
  const r = await admin.unlock(credential);
  if (!r.ok) {
    await auditAdmin(null, 'session.unlock', { outcome: 'denied', detail: { reason: r.reason } });
    if (r.reason === 'rate-limited') return jsonResponse({ error: 'rate-limited', message: 'too many failed unlock attempts — wait a minute' }, 429);
    if (r.reason === 'no-credential') return jsonResponse({ error: 'no-credential', message: 'no admin credential is configured (the shell creates one at boot)' }, 503);
    return jsonResponse({ error: 'invalid-credential', message: 'wrong admin credential' }, 401);
  }
  const principal = { kind: 'admin', credential: 'shared', sessionId: r.sessionId, verification: 'verified' } as const;
  await auditAdmin(principal, 'session.unlock', { detail: { expiresAt: r.expiresAt } });
  // Getting-started checklist: "Unlock admin" is done.
  void markWelcomeStep('admin').catch(() => undefined);
  return jsonResponse({ ok: true, token: r.token, expiresAt: r.expiresAt, ttlMs: admin.ttlMs });
};

export const GET: APIRoute = async ({ request }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  const s = await core.getAuthServices().admin.verifySession(/^Bearer\s+(\S+)/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '');
  return jsonResponse({ admin: true, actor: core.ADMIN_AUDIT_LABEL, expiresAt: s?.expiresAt ?? null });
};

export const DELETE: APIRoute = async ({ request }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  const locked = await core.getAuthServices().admin.lock(p.sessionId);
  await auditAdmin(p, 'session.lock');
  return jsonResponse({ ok: true, locked });
};
