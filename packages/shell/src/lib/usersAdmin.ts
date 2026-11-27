/**
 * Member accounts (Phase 5 stream I.2 part 2; D82, D83 §6), the host
 * operator's alone: `aura admin user …` in the master container, one
 * operator ticket per request (route manifest `HOST_OPERATOR_ONLY`). Never
 * the desktop, an app or an approval. No UI, invitations, RBAC or IdP.
 *
 *   GET    /api/admin/users                 → { users: [{ id, username, role, status, uid, gid, createdAt, grants }] }
 *   POST   /api/admin/users {username, role?}
 *          → { user: { id, username, role }, created }: a member without a
 *            password; the CLI then prints a one-time enrolment code (a
 *            `reset` ticket bound to the id, made on the host, never here)
 *   POST   /api/admin/users/<user> {action: 'disable'|'enable'}
 *          disable: the record's status, the user's login sessions and shell
 *          screens (core `setDisabled`), then its Terminal and jump sessions
 *          (kernel `endUserSessions`); enable: sign-in again with the same
 *          id, uid, home and grants. Nothing is ever deleted.
 *   POST   /api/admin/users/<user>/grants {change: 'grant'|'revoke', access: 'use'|'jump', appId}
 *          `app.use:<installationId>` / `app.jump:<installationId>`, explicit,
 *          never implied by `add`; audited `auth.user-grant`.
 *
 * `<user>` is a user id or a username. Responses name users by id and
 * username, never a hash; audit entries by id (C6).
 */
import * as core from '@aura/core';
import type { APIContext } from 'astro';
import { membersAllowed } from '../../server/access-mode.mjs';
import { ownerUiApp } from '../../server/gateway-identity.mjs';
import { SESSION_HOST_APPS } from '../../server/session-hosts.mjs';
import { authenticate } from './auth.ts';
import { json } from './approvals/service.ts';

type Ctx = Pick<APIContext, 'request' | 'params'>;

/** The host operator, else the refusal. The manifest refuses everyone else first. */
async function operator(ctx: Ctx): Promise<Response | null> {
  const p = await authenticate(ctx.request);
  if (p instanceof Response) return p;
  return p.kind === 'operator' ? null : json({ error: 'host-operator-only', message: 'Accounts are managed on the host: docker exec -it aura-shell aura admin user …' }, 403);
}

async function body(ctx: Ctx): Promise<Record<string, unknown> | Response> {
  try {
    const b = await ctx.request.json();
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400);
    return b as Record<string, unknown>;
  } catch { return json({ error: 'invalid-request', message: 'body must be JSON' }, 400); }
}

/** The account `<user>` names: an id, else a username through the index. */
async function accountOf(ref: unknown): Promise<core.UserAccount | null> {
  if (typeof ref !== 'string' || !ref) return null;
  const { users } = core.getAuthServices();
  return (await users.getUser(ref)) ?? (await users.getUser((await users.userIdOf(ref)) ?? ''));
}

const ACCESS = { use: core.appUsePermission, jump: core.appJumpPermission } as const;
type Access = keyof typeof ACCESS;

/** `use:<appId>` / `jump:<appId>` for each of the user's grants (the installation's app, when it is installed). */
async function grantsOf(userId: string, appOf: Map<string, string>): Promise<string[]> {
  const out: string[] = [];
  for (const g of await core.getAuthServices().grants.listAll()) {
    if (g.subject.kind !== 'user' || g.subject.id !== userId) continue;
    const m = /^app\.(use|jump):(.+)$/.exec(g.permission);
    if (m) out.push(`${m[1]}:${appOf.get(m[2]!) ?? m[2]}`);
  }
  return out.sort();
}

async function installations(): Promise<Map<string, string>> {
  const mgr = core.getAppManager();
  const out = new Map<string, string>();
  for (const m of mgr.registry.getAll()) {
    const id = await mgr.installationIdOf(m.id);
    if (id) out.set(id, m.id);
  }
  return out;
}

export async function listUsers(ctx: Ctx): Promise<Response> {
  const refused = await operator(ctx);
  if (refused) return refused;
  const { users, identity } = core.getAuthServices();
  const appOf = await installations();
  const rows = [];
  for (const u of await users.listUsers()) {
    const ident = await identity.getUser(u.id);
    rows.push({
      id: u.id, username: u.username, role: u.role, status: u.disabled ? 'disabled' : 'active',
      uid: ident?.uid ?? null, gid: ident?.gid ?? null, createdAt: u.createdAt, grants: await grantsOf(u.id, appOf),
    });
  }
  return json({ users: rows });
}

export async function addUser(ctx: Ctx): Promise<Response> {
  const refused = await operator(ctx);
  if (refused) return refused;
  const b = await body(ctx);
  if (b instanceof Response) return b;
  if (b['role'] !== undefined && b['role'] !== 'member') {
    return json({ error: 'invalid-role', message: 'only member accounts can be created; there is exactly one owner (D5, D16)' }, 400);
  }
  // Members exist only where the access policy is enforced (access-mode.mjs `membersAllowed`).
  if (!membersAllowed()) {
    return json({ error: 'members-need-enforce', message: 'Member accounts need AURA_ACCESS_ENFORCE=enforce: in report or off mode nothing refuses a member what only the owner may do.' }, 409);
  }
  try {
    const { user, created } = await core.getAuthServices().users.createUser({ username: String(b['username'] ?? ''), role: 'member' }, core.operatorAttribution());
    return json({ user: { id: user.id, username: user.username, role: user.role }, created }, created ? 201 : 200);
  } catch (err) {
    if (err instanceof core.UserStoreError) return json({ error: err.code, message: err.message }, 400);
    return json({ error: 'failed', message: (err as Error).message }, 500);
  }
}

export async function setUserStatus(ctx: Ctx): Promise<Response> {
  const refused = await operator(ctx);
  if (refused) return refused;
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const action = b['action'];
  if (action !== 'disable' && action !== 'enable') return json({ error: 'invalid-request', message: 'expected { action: "disable" | "enable" }' }, 400);
  const account = await accountOf(ctx.params['id']);
  if (!account) return json({ error: 'no-user' }, 404);
  const disabled = action === 'disable';
  const r = await core.getAuthServices().users.setDisabled(account.id, disabled, core.operatorAttribution());
  if (!r.ok) {
    if (r.reason === 'owner') return json({ error: 'owner', message: 'The owner is never disabled (break-glass). Recover it with aura user reset-password.' }, 409);
    return json({ error: r.reason }, r.reason === 'no-user' ? 404 : 409);
  }
  // D82: after the status and the revoke, what the user still runs as a session ends.
  // Also on a repeated disable: a Terminal started in between goes too.
  let ended: core.UserSessionsEnded | null = null;
  if (disabled) {
    try { ended = await core.getAppManager().endUserSessions(account.id); } catch { ended = null; }
    await core.getAuthServices().audit.record({
      by: core.operatorAttribution(), action: core.IDENTITY_AUDIT_ACTIONS.userSessionsEnded, target: `user:${account.id}`,
      outcome: ended && ended.terminalsFailed === 0 ? 'ok' : 'failed', detail: { ...(ended ?? { error: 'kernel unavailable' }) },
    }).catch(() => undefined);
  }
  const complete = !disabled || (r.sessionsRevoked !== null && !!ended && ended.terminalsFailed === 0);
  return json({
    ok: complete, user: { id: account.id, username: account.username }, status: disabled ? 'disabled' : 'active',
    changed: r.changed, sessionsRevoked: r.sessionsRevoked, ...(disabled ? { ended } : {}),
  }, complete ? 200 : 500);
}

export async function changeUserGrant(ctx: Ctx): Promise<Response> {
  const refused = await operator(ctx);
  if (refused) return refused;
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const { change, access, appId } = b;
  if ((change !== 'grant' && change !== 'revoke') || (access !== 'use' && access !== 'jump') || typeof appId !== 'string' || !appId) {
    return json({ error: 'invalid-request', message: 'expected { change: "grant" | "revoke", access: "use" | "jump", appId }' }, 400);
  }
  const account = await accountOf(ctx.params['id']);
  if (!account) return json({ error: 'no-user' }, 404);
  if (account.role === 'owner') return json({ error: 'owner', message: 'The owner holds every app already; grants are for members.' }, 409);
  // The owner's management UIs act as the owner (D45); they are not a member's app. The System Terminal is
  // the exception: it is in that list for the owner's instance picker only, and each user's own session host
  // (D69); a member's use grant is its own Terminal (D82).
  if (change === 'grant' && ownerUiApp(appId) && !SESSION_HOST_APPS.has(appId)) {
    return json({ error: 'owner-ui-app', message: `${appId} is the owner's management UI (D45); it is not granted to members in Phase 5.` }, 409);
  }
  const mgr = core.getAppManager();
  if (!mgr.getManifest(appId)) return json({ error: 'no-app', message: `${appId} is not installed` }, 404);
  const installationId = await mgr.installationIdOf(appId);
  if (!installationId) return json({ error: 'no-installation', message: `${appId} has no installation record yet; start it once as the owner` }, 409);
  const permission = ACCESS[access as Access](installationId);
  const { grants, audit } = core.getAuthServices();
  const subject = { kind: 'user', id: account.id } as const;
  let changed: boolean;
  try {
    changed = change === 'grant'
      ? (await grants.grant(subject, permission, { by: core.operatorAttribution() })).changed
      : (await grants.revoke(subject, permission)) !== null;
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return json({ error: (err as Error).message }, typeof status === 'number' ? status : 500);
  }
  await audit.record({
    by: core.operatorAttribution(), action: core.IDENTITY_AUDIT_ACTIONS.userGrant, target: `user:${account.id}`,
    detail: { change, permission, appId, changed },
  }).catch(() => undefined);
  return json({ ok: true, user: { id: account.id, username: account.username }, permission, appId, changed });
}
