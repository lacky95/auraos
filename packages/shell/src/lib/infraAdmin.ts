/**
 * The infrastructure configuration's routes (D94 IC-1, §4.5; one implementation: core
 * infra/admin.ts over os/infra):
 *
 *   GET    /api/admin/infra                      → InfraShow (the stored config: references only)
 *   POST   /api/admin/infra/validate {config, files?} → { ok, configDigest, warnings, diff, changed } | 400 { errors }
 *   PUT    /api/admin/infra {config, files?}     → InfraApplyResult (render + live reload)
 *   PUT    /api/admin/infra/credentials/<name> {kind, user, password | pem} → { ok, key, hosts }
 *   DELETE /api/admin/infra/credentials/<name>   → { ok, removed }
 *
 * Owner routes (D50): reads at `session`, every change at `fresh` (the password), bound to the
 * exact config digest (an approval of one config can't apply another); the host operator acts
 * directly. Audited with digests and names, never a value. Apps never reach them (the route
 * access manifest).
 */
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

type Ctx = Parameters<typeof ownerAction>[0];

export const INFRA_AUDIT = {
  applied: 'infra.config-applied',
  credentialSet: 'infra.credential-set',
  credentialRemoved: 'infra.credential-removed',
} as const;

export interface InfraAdminDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  show: typeof core.showInfra;
  validate: typeof core.validateInfra;
  apply: typeof core.applyInfra;
  setCredential: typeof core.setInfraCredential;
  removeCredential: typeof core.removeInfraCredential;
}

export function liveInfraAdminDeps(): InfraAdminDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    show: core.showInfra, validate: core.validateInfra, apply: core.applyInfra,
    setCredential: core.setInfraCredential, removeCredential: core.removeInfraCredential,
  };
}

/** The refusals core infra/admin.ts names (InfraAdminError codes), in fixed words; the field paths travel in `errors`. */
const REFUSAL: Readonly<Record<string, string>> = {
  'invalid-config': 'The infrastructure config is invalid (see errors: field paths, never values).',
  'invalid-request': 'Expected { config: <text>, files?: { <path>: <PEM> } }, or a credential { kind: "basic", user, password } / { kind: "private-key", pem } with a valid name.',
  'policy-in-config': 'policy: is the install seed only: change infra-public-fallback and infra-proxy with `aura admin security set`.',
  'no-such-ref': 'No reference in the infrastructure config is system:INFRA_<NAME> for this credential: reference it in the config first.',
};

function refused(err: unknown): Response {
  const { code, errors } = err as { code?: string; errors?: Array<{ path: string; message: string }> };
  const words = code ? REFUSAL[code] : undefined;
  if (!code || !words) throw err;
  return json({ error: code, category: 'invalid-input', message: words, ...(errors?.length ? { errors } : {}) }, code === 'no-such-ref' ? 409 : 400);
}

async function bodyOf(ctx: Ctx): Promise<Record<string, unknown> | Response> {
  try {
    const b = await ctx.request.json();
    return b && typeof b === 'object' ? b as Record<string, unknown> : json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400);
  } catch { return json({ error: 'invalid-request', message: 'body must be JSON' }, 400); }
}

const submission = (b: Record<string, unknown>): core.InfraSubmission => ({
  config: b['config'] as string,
  ...(b['files'] && typeof b['files'] === 'object' ? { files: b['files'] as Record<string, string> } : {}),
});

export async function getInfra(ctx: Ctx, deps: InfraAdminDeps = liveInfraAdminDeps()): Promise<Response> {
  const actor = await deps.ownerAction(ctx, { action: 'admin.read', payload: { view: 'infra' }, level: 'session', title: 'Show the infrastructure configuration' });
  if (actor instanceof Response) return actor;
  return json(await deps.show());
}

export async function postValidate(ctx: Ctx, deps: InfraAdminDeps = liveInfraAdminDeps()): Promise<Response> {
  const b = await bodyOf(ctx); if (b instanceof Response) return b;
  const actor = await deps.ownerAction(ctx, { action: 'admin.read', payload: { view: 'infra-validate' }, level: 'session', title: 'Check an infrastructure configuration' });
  if (actor instanceof Response) return actor;
  try { return json(await deps.validate(submission(b))); } catch (err) { return refused(err); }
}

export async function putInfra(ctx: Ctx, deps: InfraAdminDeps = liveInfraAdminDeps()): Promise<Response> {
  const b = await bodyOf(ctx); if (b instanceof Response) return b;
  let v: core.InfraValidation;
  try { v = await deps.validate(submission(b)); } catch (err) { return refused(err); }
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', level: 'fresh', payload: { op: 'infra.apply', configDigest: v.configDigest },
    title: 'Apply an infrastructure configuration (proxy, CAs, mirrors)',
    details: [
      `${v.diff.length} changed line(s); config ${v.configDigest.slice(0, 19)}…`,
      'AuraOS, its builds and (by default) every app use it; apps get it at their next start.',
    ],
  });
  if (actor instanceof Response) return actor;
  let r: core.InfraApplyResult;
  try { r = await deps.apply(submission(b)); } catch (err) { return refused(err); }
  if (r.configDigest !== v.configDigest) return json({ error: 'conflict', message: 'The configuration changed between the check and the apply.' }, 409);
  if (r.changed) await deps.audit(actor, INFRA_AUDIT.applied, { target: 'system:infra', detail: { configDigest: r.configDigest, renderDigest: r.renderDigest, lines: r.diff.length } });
  return json({ ok: true, ...r });
}

export async function putCredential(ctx: Ctx, name: string, deps: InfraAdminDeps = liveInfraAdminDeps()): Promise<Response> {
  const b = await bodyOf(ctx); if (b instanceof Response) return b;
  const credential = (b['kind'] === 'private-key'
    ? { kind: 'private-key', pem: b['pem'] } : { kind: 'basic', user: b['user'], password: b['password'] }) as core.InfraCredentialInput;
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', level: 'fresh', payload: { op: 'infra.credential', name, kind: credential.kind },
    title: `Set the infrastructure credential ${name}`, details: ['Sealed for AuraOS\'s own builds and updates only; never readable, never given to an app.'],
  });
  if (actor instanceof Response) return actor;
  try {
    const r = await deps.setCredential({ name, credential });
    await deps.audit(actor, INFRA_AUDIT.credentialSet, { target: `system:${r.key}`, detail: { name, kind: credential.kind, hosts: r.hosts } });
    return json({ ok: true, key: r.key, hosts: r.hosts });
  } catch (err) { return refused(err); }
}

export async function deleteCredential(ctx: Ctx, name: string, deps: InfraAdminDeps = liveInfraAdminDeps()): Promise<Response> {
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', level: 'fresh', payload: { op: 'infra.credential-remove', name },
    title: `Remove the infrastructure credential ${name}`, details: ['Builds that need it are refused until it is set again.'],
  });
  if (actor instanceof Response) return actor;
  try {
    const removed = await deps.removeCredential({ name });
    if (removed) await deps.audit(actor, INFRA_AUDIT.credentialRemoved, { target: 'system:infra', detail: { name } });
    return json({ ok: true, removed });
  } catch (err) { return refused(err); }
}
