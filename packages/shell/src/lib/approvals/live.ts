/**
 * The approval routes bound to the live shell: core's stores, the shell's
 * principal resolver and the owner's login session. Kept apart from
 * routes.ts so tests bind fakes instead.
 */
import * as core from '@aura/core';
import { authenticate } from '../auth.ts';
import { clientRateKey, coreAuthServices, currentOwnerSession } from '../authSurface.ts';
import { shellOwner } from '../appHostHandoff.ts';
import { freshAuthRequiresHttps } from '../access/decide.ts';
import { edgeView } from '../../../server/host-policy.mjs';
import { liveApprovalDeps } from './service.ts';
import type { ApprovalRouteDeps, OwnerSession, RouteCtx } from './routes.ts';

/** The session's own user (C3), and only when the record says owner: approvals stay the owner's (I.2 §3). */
async function withUsername(s: { userId: string; sessionId: string } | null): Promise<OwnerSession | null> {
  if (!s) return null;
  const owner = await coreAuthServices()?.users.getUser(s.userId);
  return owner && !owner.disabled && owner.role === 'owner' && owner.id === s.userId ? { ...s, username: owner.username } : null;
}

export function liveRouteDeps(): ApprovalRouteDeps {
  const svc = core.getAuthServices();
  return {
    ...liveApprovalDeps(),
    authenticate: (request) => authenticate(request),
    shellOwner: async (ctx: RouteCtx) => {
      const r = await shellOwner(ctx as Parameters<typeof shellOwner>[0]);
      if ('error' in r) return { error: r.error, status: r.status };
      const owner = await withUsername({ userId: r.identity.userId, sessionId: r.identity.sid });
      return owner ? { owner, scheme: r.edge.scheme } : { error: 'login-required', status: 401 };
    },
    ownerRead: async (ctx) => withUsername(await currentOwnerSession(ctx)),
    scheme: (ctx) => {
      let peer: string | undefined;
      try { peer = ctx.clientAddress; } catch { peer = undefined; }
      return edgeView({ peer, header: (name: string) => ctx.request.headers.get(name) }).scheme;
    },
    freshAuthRequiresHttps: () => freshAuthRequiresHttps(svc.securityPolicy),
    lockOf: (sid, userId) => svc.clientSessions.effectiveLock(sid, { userId }),
    verifyPassword: async (username, password, rateLimitKey) => {
      const check = await svc.users.verifyPassword(username, password, { rateLimitKey });
      if (check.ok) return check.user.role === 'owner' && !check.user.disabled ? 'ok' : 'invalid';
      return check.reason === 'rate-limited' ? 'rate-limited' : 'invalid';
    },
    rateKey: (ctx) => clientRateKey(ctx, process.env),
    // D56: the secret typed into the dialog goes straight to the owner's vault.
    storeCredential: async (userId, ask, value, record) => {
      const { liveCredentialDeps, storeApprovedCredential } = await import('../credentials.ts');
      await storeApprovedCredential(liveCredentialDeps(), userId, ask, value, record);
    },
  };
}
