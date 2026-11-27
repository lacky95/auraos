/**
 * `aura root` (Phase 5 stream J.6, P5-4, D55): the root tab's grant, list and End.
 *
 *   POST   /api/admin/root {instanceId}   the owner's own System Terminal instance;
 *                                         approved at `fresh` (password or host
 *                                         operator) → {grant, expiresAt}: single use,
 *                                         two minutes, consumed when the root session
 *                                         opens on the exec bridge ({op:'open', root})
 *   GET    /api/admin/root                the open root tabs (never persisted)
 *   DELETE /api/admin/root?instanceId=    End: every root tab of that instance (or all)
 *
 * Refused while the D64 switch `aura-root` is `disabled`. Audited
 * `root.granted` here and `root.ended` by the bridge. A normal tab never has
 * the socket: only the root session's own mount namespace does (core
 * SessionBroker, os/session-enter).
 */
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

type Ctx = Parameters<typeof ownerAction>[0];
type Mgr = ReturnType<typeof core.getAppManager>;

export interface RootTabDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  mgr: Pick<Mgr, 'getInstance' | 'rootGrants' | 'openSessions' | 'endRootSessions'>;
  /** The effective `aura-root` value (a read failure counts as disabled: fail closed). */
  enabled(): Promise<boolean>;
}

export function liveRootTabDeps(): RootTabDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    mgr: core.getAppManager(),
    enabled: async () => {
      try {
        const store = core.getAuthServices().securityPolicy;
        if (!store) return false;
        return core.securityPolicyValue(await store.get(), core.AURA_ROOT_OPTION) === 'enabled';
      } catch { return false; }
    },
  };
}

async function body(ctx: Ctx): Promise<Record<string, unknown> | Response> {
  try {
    const b = await ctx.request.json();
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400);
    return b as Record<string, unknown>;
  } catch { return json({ error: 'invalid-request', message: 'body must be JSON' }, 400); }
}

export async function postRootTab(ctx: Ctx, deps: RootTabDeps = liveRootTabDeps()): Promise<Response> {
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const instanceId = b['instanceId'];
  if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(instanceId)) {
    return json({ error: 'invalid-request', message: 'expected { instanceId } of your System Terminal' }, 400);
  }
  if (!(await deps.enabled())) return json({ error: 'root-disabled', message: 'aura root is disabled on this installation (security option aura-root)' }, 403);
  const inst = deps.mgr.getInstance(instanceId) as (ReturnType<Mgr['getInstance']> & { owner?: string; inPool?: boolean }) | undefined;
  // P5-4: only into the owner's own Terminal instance, its session context.
  if (!inst || !core.isUserEnvironment(inst) || inst.inPool || inst.owner !== core.DEFAULT_OWNER_ID) {
    return json({ error: 'not-a-terminal', message: 'aura root opens only in your own System Terminal' }, 409);
  }
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { root: { instanceId } }, level: 'fresh',
    title: 'Open a root tab in your Terminal',
    details: [
      'A dedicated tab runs as root (Docker\'s default capabilities) with the Docker socket, in this Terminal instance only.',
      'The socket gives full control of the host. The tab ends with `exit`, `aura root end`, or a Terminal restart.',
    ],
  });
  if (actor instanceof Response) return actor;
  const g = deps.mgr.rootGrants.issue(core.DEFAULT_OWNER_ID, instanceId);
  await deps.audit(actor, core.ROOT_AUDIT_ACTIONS.granted, { target: `instance:${instanceId}`, detail: { expiresAt: g.expiresAt } });
  return json({ ok: true, instanceId, grant: g.grant, expiresAt: g.expiresAt });
}

export async function listRootTabs(ctx: Ctx, deps: RootTabDeps = liveRootTabDeps()): Promise<Response> {
  const actor = await deps.ownerAction(ctx, { action: 'admin.read', payload: { view: 'root-tabs' }, level: 'session', title: 'Show the open root tabs' });
  if (actor instanceof Response) return actor;
  const tabs = deps.mgr.openSessions().filter((s) => s.kind === 'root')
    .map((s) => ({ sessionId: s.sessionId, instanceId: s.instanceId, userId: s.userId ?? null, startedAt: s.startedAt }));
  return json({ enabled: await deps.enabled(), tabs });
}

export async function endRootTabs(ctx: Ctx, deps: RootTabDeps = liveRootTabDeps()): Promise<Response> {
  const instanceId = new URL(ctx.request.url).searchParams.get('instanceId') ?? undefined;
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { rootEnd: { instanceId: instanceId ?? '*' } }, level: 'session',
    title: instanceId ? `End the root tabs of ${instanceId}` : 'End every root tab',
  });
  if (actor instanceof Response) return actor;
  const ended = await deps.mgr.endRootSessions(instanceId);
  return json({ ok: true, ended });
}
