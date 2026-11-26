/**
 * `/api/admin/security-options` (D64): the security options registry
 * (core `security/options.ts`), read and written.
 *
 *   GET            → { options: EffectiveSecurityOption[] }: every option,
 *                    its effective value and where it comes from
 *   PUT {id, value} → { ok, changed, option }: a `policy` option only
 *
 * An owner route (D50, lib/approvals/admin.ts `ownerAction`): a read is
 * direct for the owner, Settings and the host operator. A change is each
 * option's `change` level (`fresh`, the password): the owner approves it in
 * the shell's dialog, coming from Settings or the System Terminal; the host
 * operator acts directly. So with `fresh-auth-require-https` on, turning it
 * off over HTTP needs HTTPS or the host (D63). An `env` option answers 409:
 * it is set on the host; a `record` or `file` option too: it is changed where
 * it always was.
 */
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

type Ctx = Parameters<typeof ownerAction>[0];

export interface SecurityOptionsDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  store: Pick<core.SecurityPolicyStore, 'get' | 'set'>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  env: Record<string, string | undefined>;
}

export function liveSecurityOptionsDeps(): SecurityOptionsDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    store: core.getAuthServices().securityPolicy,
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    env: process.env,
  };
}

const show = (v: core.SecurityOptionValue): string =>
  v === true ? 'on' : v === false ? 'off' : Array.isArray(v) ? (v.join(', ') || '(none)') : String(v ?? '-');

export async function getSecurityOptions(ctx: Ctx, deps: SecurityOptionsDeps = liveSecurityOptionsDeps()): Promise<Response> {
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'security-options' }, level: 'session', title: 'Show the security options',
  });
  if (actor instanceof Response) return actor;
  return json({ options: core.resolveSecurityOptions(await deps.store.get(), deps.env) });
}

export async function putSecurityOption(ctx: Ctx, deps: SecurityOptionsDeps = liveSecurityOptionsDeps()): Promise<Response> {
  let body: unknown;
  try { body = await ctx.request.json(); } catch { return json({ error: 'invalid-request', message: 'body must be JSON: { id, value }' }, 400); }
  const { id, value: raw } = (body && typeof body === 'object' ? body : {}) as { id?: unknown; value?: unknown };
  const option = typeof id === 'string' ? core.securityOption(id) : undefined;
  if (!option) return json({ error: 'unknown-option' }, 404);
  if (option.source === 'env') {
    return json({ error: 'set-on-host', message: `Set on the host: ${option.env} in compose/.env, then restart.` }, 409);
  }
  if (option.source === 'record') {
    return json({ error: 'own-setting', message: `${option.title} keeps its own record (${option.record}) and is changed where it always was.` }, 409);
  }
  if (option.source === 'file') {
    return json({ error: 'own-setting', message: `${option.title} keeps its own switch (/data/${option.file}) and is changed where it always was.` }, 409);
  }
  if (option.source === 'reserved') return json({ error: 'not-yet-available' }, 409);
  if (option.env && (deps.env[option.env] ?? '').trim() !== '') {
    return json({ error: 'set-on-host', message: `${option.env} on the host decides it; remove it there first.` }, 409);
  }
  const value = core.parseOptionValue(option, raw);
  if (value === undefined) return json({ error: 'invalid-value', ...(option.values ? { values: option.values } : {}) }, 400);

  const before = core.resolveSecurityOptions(await deps.store.get(), deps.env).find((o) => o.id === option.id)!;
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { securityOption: option.id, value }, level: option.change,
    title: `${option.title}: ${show(before.value)} → ${show(value)}`,
    details: [option.description],
  });
  if (actor instanceof Response) return actor;

  let result: core.SecurityOptionChangeResult;
  try { result = await deps.store.set(option.id, value); }
  catch (err) {
    if (err instanceof core.SecurityOptionError) return json({ error: err.code }, 400);
    throw err;
  }
  if (!result.ok) return json({ error: 'conflict', message: 'The security options changed meanwhile. Try again.' }, 409);
  if (result.changed) {
    await deps.audit(actor, core.SECURITY_AUDIT_ACTIONS.optionChanged, {
      target: `security:${option.id}`, detail: { from: result.previous, to: result.value },
    });
  }
  const now = core.resolveSecurityOptions(await deps.store.get(), deps.env).find((o) => o.id === option.id)!;
  return json({ ok: true, changed: result.changed, option: now });
}
