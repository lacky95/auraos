/**
 * Credentials (D56): asked for through the shell, kept in the user's vault,
 * handed out as handles.
 *
 *   POST /api/credentials/requests          an app (`osClient.credentials.request`) or the CLI
 *                                           (`aura secret ask`) asks: a pending `credential.store`
 *                                           approval. The owner types the secret into the shell's
 *                                           own dialog (OwnerPasswordDialog), whose approve request
 *                                           stores it (lib/approvals/routes.ts `storeCredential`).
 *   POST /api/credentials/requests/<id>     the requester collects: `{handle, name}`, never the value
 *   GET  /api/credentials/<handle>          the consuming app's server reads the value: only with
 *                                           the `credential.read:<NAME>` grant for its user, which a
 *                                           `fresh` approval gives (202 needs-approval until then)
 *   GET    /api/admin/credentials           the owner's list: names, consumers, last use; no values
 *   DELETE /api/admin/credentials/<NAME>    the owner revokes the secret (`?app=` one app's access);
 *                                           an approval from Settings or the CLI (admin.ts)
 *
 * The vault is per user (core `CredentialVault`, `context:user:<userId>`): a
 * handle resolves only in the vault of the user the caller acts for, so
 * another user's handle reads as unknown. A value never appears in an
 * answer other than the granted read, nor in a log or the audit trail.
 */
import * as core from '@aura/core';
import type { AccessPrincipal, ApprovalRecord, CredentialSummary, CredentialVault, GrantScope, GrantSubject } from '@aura/core';
import type { ResolvedPrincipal } from './access/identify.ts';
import { liveSetupService } from './setup/service.ts';
import { credentialAsk, credentialDisplay, credentialReadDisplay, requesterReason, type CredentialAsk, type CredentialRead } from './approvals/display.ts';
import {
  actionGate, consumeApproval, json, liveApprovalDeps, presentedApproval, refusal, requestApproval, requesterSummary,
  requesterView, type ApprovalServiceDeps,
} from './approvals/service.ts';

export const MAX_BODY_BYTES = 8 * 1024;

export interface CredentialDeps extends ApprovalServiceDeps {
  resolve(request: Request): Promise<ResolvedPrincipal>;
  vault: Pick<CredentialVault, 'store' | 'list' | 'resolve' | 'reveal' | 'handleOf' | 'removeConsumer' | 'remove' | 'describe'>;
  grants: {
    get(subject: GrantSubject, permission: string, scope: GrantScope): Promise<unknown>;
    grant(subject: GrantSubject, permission: string, opts: { by: core.GrantedBy; appScope?: string; installationId?: string; scope: GrantScope }): Promise<unknown>;
    revoke(subject: GrantSubject, permission: string, scope: GrantScope): Promise<unknown>;
  };
  /** The install scope an app id resolves to and its installation, for pinning a grant (S1). */
  appBinding(appId: string): Promise<core.AppGrantBinding>;
  /**
   * D108 owner decision 2: the calling instance's installation and its
   * current setup secret handles by field (the effective configuration), or
   * null (no setup engine, no setup, not ready). Only a handle that is still
   * its field's current one reads without a grant.
   */
  setupSecrets(instance: { appId: string; instanceId: string; userId?: string }): Promise<core.InstallationSecrets | null>;
}

export function liveCredentialDeps(): CredentialDeps {
  const svc = core.getAuthServices();
  return {
    ...liveApprovalDeps(),
    resolve: async (request) => (await import('./auth.ts')).resolveCaller(request),
    vault: new core.CredentialVault(),
    grants: svc.grants,
    appBinding: async (appId) => {
      try { return await core.getAppManager().appGrantBinding(appId); } catch { return { scope: undefined, installationId: null }; }
    },
    setupSecrets: async (instance) => {
      const service = liveSetupService();
      if (!service) return null;
      try {
        const view = await service.selfConfig(instance);
        return view.appId === instance.appId ? { installationId: view.installationId, secrets: view.secrets } : null;
      } catch { return null; }
    },
  };
}

async function audit(deps: Pick<ApprovalServiceDeps, 'audit'>, entry: core.AuditInput): Promise<void> {
  try { await deps.audit(entry); } catch { /* the audit trail must not fail the request */ }
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json({ error: 'body-too-large' }, 413);
  const text = await request.text().catch(() => null);
  if (text === null) return json({ error: 'invalid-request' }, 400);
  if (text.length === 0) return {};
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'json-required' }, 415);
  if (text.length > MAX_BODY_BYTES) return json({ error: 'body-too-large' }, 413);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* below */ }
  return json({ error: 'invalid-request' }, 400);
}

const readPermission = (name: string) => core.credentialReadPermission(name);

// ── asking ──────────────────────────────────────────────────────────────────

/**
 * The consuming app a request names: `scope: 'app'` (the default) is the
 * requester's own app, `{app}` another installed app (the CLI's `--for`).
 */
function consumerOf(scope: unknown, own: string | null): string | null | 'invalid' {
  if (scope === undefined || scope === 'app') return own;
  if (scope && typeof scope === 'object' && typeof (scope as { app?: unknown }).app === 'string') return (scope as { app: string }).app;
  return 'invalid';
}

/** POST /api/credentials/requests `{name, label?, purpose?, scope?}`. */
export async function requestCredential(request: Request, deps: CredentialDeps): Promise<Response> {
  const r = await deps.resolve(request);
  if (r.rejected) return json({ error: 'invalid-credential' }, 401);
  const principal = r.principal as AccessPrincipal;
  const requester = core.approvalRequester(principal);
  const own = requester ? core.requesterAppId(requester) : null;
  if (!requester || !own) return json({ error: 'app-required', message: 'An app or the CLI in an app asks for a credential.' }, 403);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const consumer = consumerOf(body['scope'], own);
  if (consumer === 'invalid' || consumer === null) return json({ error: 'invalid-scope', message: 'scope is "app" or {app: "<app id>"}' }, 400);
  const ask = credentialAsk({ name: body['name'], for: consumer });
  if (!ask) return json({ error: 'invalid-name', message: `name must match ${core.CREDENTIAL_NAME_RE.source}` }, 400);
  const consumerName = deps.appName(ask.for);
  if (consumerName === null) return json({ error: 'unknown-app', message: `No app ${ask.for} is installed.` }, 404);
  const label = requesterReason(body['label']);
  const purpose = requesterReason(body['purpose']);
  const reason = requesterReason([label, purpose].filter(Boolean).join(': '));
  const created = await requestApproval(deps, principal, {
    action: 'credential.store', payload: ask, level: 'session', keepPayload: true,
    display: (by) => credentialDisplay(ask, consumerName, by, reason),
  });
  return created.ok ? json(requesterView(created.record), 201) : refusal(created.reason);
}

/** POST /api/credentials/requests/<id> `{name, scope?}`: the handle, once the owner stored the secret. */
export async function collectCredential(request: Request, id: string | undefined, deps: CredentialDeps): Promise<Response> {
  if (!id || !core.isApprovalId(id)) return refusal('not-found');
  const r = await deps.resolve(request);
  if (r.rejected) return json({ error: 'invalid-credential' }, 401);
  const principal = r.principal as AccessPrincipal;
  const requester = core.approvalRequester(principal);
  const own = requester ? core.requesterAppId(requester) : null;
  if (!requester || !own) return refusal('not-a-requester');
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const consumer = consumerOf(body['scope'], own);
  const ask = consumer === 'invalid' || consumer === null ? null : credentialAsk({ name: body['name'], for: consumer });
  if (!ask) return json({ error: 'invalid-payload' }, 400);
  const used = await consumeApproval(deps, principal, id, 'credential.store', ask);
  if (!used.ok) return refusal(used.reason);
  const decided = used.record.decidedBy;
  const handle = decided?.kind === 'user' ? await deps.vault.handleOf(decided.userId, ask.name, ask.for) : null;
  if (!handle) return json({ error: 'unavailable' }, 409);
  return json({ handle, name: ask.name });
}

/**
 * Keep the secret the owner typed for an approved `credential.store`
 * (bound into the approval routes as `storeCredential`).
 */
export async function storeApprovedCredential(
  deps: Pick<CredentialDeps, 'vault' | 'audit'>, userId: string, ask: CredentialAsk, value: string, record: ApprovalRecord,
): Promise<void> {
  const { created } = await deps.vault.store(userId, ask.name, value, { consumer: ask.for });
  await audit(deps, {
    by: core.userAttribution({ userId }), action: 'vault.stored', target: `vault:${ask.name}`, outcome: 'ok',
    detail: { name: ask.name, consumer: ask.for, created, requestedBy: requesterSummary(record.requester), approval: record.id },
  });
}

// ── the raw value ───────────────────────────────────────────────────────────

/** The instance a server-side read comes from: its own token, never a page. */
function serverInstance(r: ResolvedPrincipal): core.InstancePrincipal | Response {
  if (r.rejected) return json({ error: 'invalid-credential' }, 401);
  const p = r.principal;
  if (p.kind !== 'instance' || r.via !== 'instance-token') {
    return json({ error: 'server-only', message: 'A credential value goes only to the consuming app\'s own server, with its instance token.' },
      p.kind === 'anonymous' ? 401 : 403);
  }
  return p as core.InstancePrincipal;
}

/** Whether `appId` holds the read grant of `name` in `userId`'s vault, pinned to its install scope and installation. */
async function holdsRead(deps: CredentialDeps, appId: string, userId: string, name: string): Promise<boolean> {
  const g = await deps.grants.get({ kind: 'app', id: appId }, readPermission(name), core.userScope(userId)) as core.GrantRecord | null;
  return core.appGrantCounts(g, await deps.appBinding(appId));
}

async function reveal(
  deps: CredentialDeps, p: core.InstancePrincipal, userId: string, name: string, via: string, grant?: 'setup-generated' | 'credential.read',
): Promise<string | null> {
  const value = await deps.vault.reveal(userId, name, p.appId);
  await audit(deps, {
    by: { kind: 'system' }, action: 'vault.read', target: `vault:${name}`, outcome: value === null ? 'failed' : 'ok',
    detail: { name, app: p.appId, instance: p.instanceId, user: userId, via, ...(grant ? { grant } : {}) },
  });
  return value;
}

/** GET /api/credentials/<handle>: `{name, value}`, 202 needs-approval for the grant, 404 unknown here. */
export async function readCredential(request: Request, handle: string | undefined, deps: CredentialDeps): Promise<Response> {
  if (!core.isCredentialHandle(handle)) return json({ error: 'not-found' }, 404);
  const p = serverInstance(await deps.resolve(request));
  if (p instanceof Response) return p;
  if (!p.userId) return json({ error: 'no-user', message: 'This instance acts for no user, so it has no vault.' }, 403);
  const userId = p.userId;
  const held = await deps.vault.resolve(userId, handle);
  // Another user's handle, another app's handle, a revoked one: all unknown.
  if (!held || held.consumer !== p.appId) return json({ error: 'not-found' }, 404);

  // D108 owner decision 2: the installation's own generated setup secret, while it is its field's current
  // handle, needs no grant (nobody typed it; core setup/values.ts `secretReadableWithoutGrant`).
  let own = false;
  if (held.installation) {
    const current = await deps.setupSecrets({ appId: p.appId, instanceId: p.instanceId, userId });
    const pinned = (await deps.appBinding(p.appId)).installationId;
    own = !!current && current.installationId === pinned && core.secretReadableWithoutGrant(held, current, handle);
  }
  if (!own && !(await holdsRead(deps, p.appId, userId, held.name))) {
    const binding = await deps.appBinding(p.appId);
    if (!binding.installationId) {
      return json({ error: 'no-installation', message: `${p.appId} has no installation record: a read grant is given to one installation of it.` }, 409);
    }
    const read: CredentialRead = { name: held.name, app: p.appId };
    const gate = actionGate(deps, p, { approvalId: presentedApproval(request) });
    if (!(await gate.allows('credential.read', read))) {
      const appName = deps.appName(p.appId) ?? p.appId;
      return gate.needsApproval({
        action: 'credential.read', payload: read, level: 'fresh',
        display: (by) => credentialReadDisplay(read, appName, by),
      });
    }
    const decided = gate.consumed()?.decidedBy;
    const by = decided?.kind === 'user' ? core.userAttribution({ userId: decided.userId, sessionId: decided.sessionId }) : core.operatorAttribution();
    await deps.grants.grant({ kind: 'app', id: p.appId }, readPermission(held.name), {
      by, scope: core.userScope(userId), ...(binding.scope ? { appScope: binding.scope } : {}), installationId: binding.installationId,
    });
    await audit(deps, {
      by, action: 'vault.read-granted', target: `vault:${held.name}`, outcome: 'ok',
      detail: { name: held.name, app: p.appId, user: userId, approval: gate.consumed()?.id },
    });
  }
  const value = await reveal(deps, p, userId, held.name, 'handle', own ? 'setup-generated' : 'credential.read');
  if (value === null) return json({ error: 'not-found' }, 404);
  return json({ name: held.name, value });
}

// ── the owner's view (Settings → Users & Identities → Secrets) ──────────────

/** The user an owner action manages the vault of: the owner who acts or approved; the operator acts for the owner. */
export function vaultUserOf(by: core.ChangeAttribution): string {
  return by.kind === 'user' ? by.userId : core.DEFAULT_OWNER_ID;
}

export interface CredentialListRow extends CredentialSummary {
  consumers: Array<{ appId: string; since: number; name: string; canRead: boolean }>;
}

/** Every credential of `userId`, with each consumer's name and whether it holds the read grant. No values. */
export async function listCredentials(deps: CredentialDeps, userId: string): Promise<CredentialListRow[]> {
  const rows = await deps.vault.list(userId);
  const out: CredentialListRow[] = [];
  for (const row of rows) {
    const consumers = [];
    for (const c of row.consumers) {
      consumers.push({ ...c, name: deps.appName(c.appId) ?? c.appId, canRead: await holdsRead(deps, c.appId, userId, row.name) });
    }
    out.push({ ...row, consumers });
  }
  return out;
}

/** Revoke `name` (every handle and read grant), or only `app`'s handle and grant. Whether anything changed. */
export async function revokeCredential(
  deps: CredentialDeps, userId: string, name: string, app: string | null, by: core.ChangeAttribution, detail: Record<string, unknown>,
): Promise<boolean> {
  const summary = await deps.vault.describe(userId, name);
  if (!summary) return false;
  const apps = app ? [app] : summary.consumers.map((c) => c.appId);
  for (const a of apps) await deps.grants.revoke({ kind: 'app', id: a }, readPermission(name), core.userScope(userId));
  const changed = app ? await deps.vault.removeConsumer(userId, name, app) : await deps.vault.remove(userId, name);
  await audit(deps, {
    by, action: 'vault.revoked', target: `vault:${name}`, outcome: 'ok',
    detail: { ...detail, name, ...(app ? { app } : { apps }), user: userId },
  });
  return changed || apps.length > 0;
}
