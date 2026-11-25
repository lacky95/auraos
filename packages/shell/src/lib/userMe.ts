/**
 * `GET /api/user/me` and `PATCH /api/user/me/profile` (D46, D47).
 *
 * `/api/user/me` answers who the caller acts for, and nothing else:
 *   { userId, username?, role?, isOwner, verified, systemId, ref, profile }
 * `profile` is filtered by the profile field registry for the reader: the
 * user themselves (their login, or a trusted system UI acting for them, D45)
 * sees every field; an app sees `basic` fields, `granted` ones it holds a
 * `user.profile.<field>` grant for, and never a `private` one. Unknown or
 * ungranted fields are absent, never an error. It never returns a session
 * id, the claim, a hash, another user or a user list.
 *
 * `verified` is true only when a live login session of that user stands
 * behind the request (the user's own login, or an App Host session through
 * the gateway). An instance token names its owner without one: false. While
 * login is dark, nothing is invented: `verified: false`.
 *
 * `ref` is the qualified reference apps persist (`userId@systemId`); `userId`
 * itself is opaque and local.
 *
 * The profile is changed only by the user (owner) themselves, through the
 * desktop or Settings: `PATCH /api/user/me/profile` with a JSON object of
 * fields, `null` clearing one. Validated by the same registry.
 */
import * as core from '@aura/core';
import type { AppManager, ProfileAudience, ProfileFieldName, UserAccount, UserProfile } from '@aura/core';
import type { ResolvedPrincipal } from './access/identify.js';
import { actingUserId } from './userContext.js';

export interface UserMeDeps {
  resolve(request: Request): Promise<ResolvedPrincipal>;
  users: {
    getUser(userId: string): Promise<UserAccount | null>;
    getProfile(userId: string): Promise<UserProfile | null>;
    updateProfile(userId: string, patch: { set: UserProfile; clear: readonly ProfileFieldName[] }): Promise<UserProfile | null>;
  };
  /** Whether app `appId` holds the owner's `user.profile.<field>` grant. */
  granted(appId: string, field: ProfileFieldName): Promise<boolean>;
  mgr: Pick<AppManager, 'getInstance'> | null;
  systemId(): string;
  changed(userId: string): void;
  audit?(entry: { userId: string; sessionId?: string; fields: string[] }): Promise<unknown>;
}

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** Who reads the profile: the user themselves, or the app the request comes from. */
function audienceOf(r: ResolvedPrincipal, deps: UserMeDeps): ProfileAudience | null {
  const p = r.principal;
  // The user's own login, or the owner through a trusted system UI: the
  // gateway (D45) and the SSR claim name only those. An App Host cookie
  // (`app-host`) is the user inside an ordinary app: that app's view.
  if (p.kind === 'user' && (!p.through || r.via !== 'app-host')) return { kind: 'user' };
  const appId = p.kind === 'user' ? p.through?.appId : p.kind === 'instance' ? p.appId : undefined;
  if (!appId) return p.kind === 'operator' || p.kind === 'apiKey' ? { kind: 'user' } : null;
  return { kind: 'app', granted: (field) => deps.granted(appId, field) };
}

/** A live login session of the user is behind the request. */
const isVerified = (r: ResolvedPrincipal): boolean =>
  r.principal.kind === 'user' || (r.principal.kind === 'instance' && r.via === 'gateway' && !!r.principal.userId);

export async function getUserMe(request: Request, deps: UserMeDeps): Promise<Response> {
  const r = await deps.resolve(request);
  if (r.rejected) return reply({ error: 'invalid-credential' }, 401);
  if (r.principal.kind === 'anonymous') return reply({ error: 'login-required' }, 401);
  const audience = audienceOf(r, deps);
  if (!audience) return reply({ error: 'no-user' }, 403);
  const userId = actingUserId(r.principal, deps.mgr);
  const systemId = deps.systemId();
  const account = await deps.users.getUser(userId);
  const profile = account ? await core.filterProfile((await deps.users.getProfile(userId)) ?? {}, audience) : {};
  return reply({
    userId,
    ...(account ? { username: account.username, role: account.role } : {}),
    isOwner: account?.role === 'owner',
    verified: isVerified(r) && !!account,
    systemId,
    ref: core.qualifiedRef(userId, systemId),
    profile,
  });
}

export async function patchMyProfile(request: Request, deps: UserMeDeps): Promise<Response> {
  // A JSON body only: a cross-site form can't send it without a preflight.
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return reply({ error: 'json-required' }, 415);
  const r = await deps.resolve(request);
  if (r.rejected) return reply({ error: 'invalid-credential' }, 401);
  const p = r.principal;
  // The user themselves, as the owner: their login or Settings (D45), never another app.
  if (p.kind !== 'user' || p.role !== 'owner' || audienceOf(r, deps)?.kind !== 'user') {
    return reply({ error: p.kind === 'anonymous' ? 'login-required' : 'forbidden' }, p.kind === 'anonymous' ? 401 : 403);
  }
  let body: unknown;
  try { body = JSON.parse(await request.text()); } catch { return reply({ error: 'invalid-json' }, 400); }
  const patch = core.parseProfilePatch(body);
  if (!patch.ok) return reply({ error: 'invalid-profile', field: patch.field, message: patch.error }, 400);
  const profile = await deps.users.updateProfile(p.userId, patch);
  if (!profile) return reply({ error: 'no-user' }, 404);
  deps.changed(p.userId);
  try {
    await deps.audit?.({ userId: p.userId, sessionId: p.sessionId, fields: [...Object.keys(patch.set), ...patch.clear] });
  } catch { /* the audit trail must not fail the change */ }
  return reply({ ok: true, profile });
}

/** The live dependencies. */
export async function liveUserMeDeps(): Promise<UserMeDeps> {
  const { resolveCaller } = await import('./auth.js');
  const svc = core.getAuthServices();
  let mgr: Pick<AppManager, 'getInstance'> | null = null;
  try { mgr = core.getAppManager(); } catch { mgr = null; }
  return {
    resolve: (request) => resolveCaller(request),
    users: svc.users,
    granted: async (appId, field) => {
      try { return !!(await svc.authorizer.grants.get({ kind: 'app', id: appId }, core.profileGrantPermission(field))); }
      catch { return false; }
    },
    mgr,
    systemId: () => core.localSystemId(),
    changed: (userId) => core.OsEventBus.emit('user:changed', { userId, systemId: core.localSystemId() }),
    audit: (e) => svc.audit.record({
      by: core.userAttribution(e), action: 'user.profile-changed', target: `user:${e.userId}`, detail: { fields: e.fields },
    }),
  };
}
