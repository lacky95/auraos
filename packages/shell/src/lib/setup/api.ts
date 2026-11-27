/**
 * The HTTP side of app setup (D108): `/api/apps/<id>/setup/**` translates a
 * request into one `SetupServiceContract` call and its answer back (plain
 * data, so `-o json` prints the contract views as they are).
 *
 *   who      the verified principal, never a body field:
 *              the owner's login (a change by cookie needs the desktop's Origin)  → user
 *              the owner through a trusted system UI (Settings, D45)              → user
 *              the System Terminal by its own instance token (the CLI, agents)    → terminal, for its user
 *              the host operator (its one-time ticket)                            → operator
 *            refused: a member (owner-only in the alpha), another Aura's
 *            principal, the owner inside an ordinary app's page (App Host
 *            cookie), any other app (the route manifest refuses it first).
 *   body     a SetupProposal: `profile`, `values`, `secrets` (field → vault
 *            handle, never a value), `overrides`. Anything else is refused
 *            (422 `config-invalid`): there is no `yes`/`force`, no approval
 *            is ever skipped. A value for a secret field is refused too.
 *   answer   SetupOutcome: 200 ready/unchanged, 202 on-hold (the engine's
 *            `app.setup.apply` approval, `approvalId`) or initializing,
 *            409 needs-setup/blocked/unsupported, 422 invalid; a thrown
 *            engine error with `body: SetupErrorBody` → that body.
 *            503 `unavailable` while there is no engine (lib/setup/service.ts).
 *
 * The engine creates every approval (decision 9); this layer never asks for
 * one, never consumes one and never decides what is privileged.
 */
import * as core from '@aura/core';
import type { APIContext } from 'astro';
import type {
  AppManifest, DesiredOverrides, InstancePrincipal, SetupActor, SetupErrorBody, SetupOutcome, SetupProposal, SetupServiceContract,
} from '@aura/core';
import { resolveCaller } from '../auth.ts';
import { bearerToken, isTrustedOwnerAgent, type ResolvedPrincipal } from '../access/identify.ts';
import { shellOwner } from '../appHostHandoff.ts';
import { approvalsChanged, json } from '../approvals/service.ts';
import { liveSetupService, SETUP_UNAVAILABLE } from './service.ts';

/** The engine call a route makes. */
export type SetupOp = 'state' | 'profiles' | 'plan' | 'values' | 'setValues' | 'apply' | 'resume' | 'repair' | 'reconfigure' | 'secrets' | 'askSecret';

/** The calls that change something (the desktop's Origin for a cookie caller). */
const CHANGES: ReadonlySet<SetupOp> = new Set(['setValues', 'apply', 'resume', 'repair', 'reconfigure', 'askSecret']);
/** The calls that take a proposal (`plan` only by POST). `resume` takes none: it continues the recorded run. */
const PROPOSES: ReadonlySet<SetupOp> = new Set(['plan', 'setValues', 'apply', 'repair', 'reconfigure']);

export type RouteCtx = Pick<APIContext, 'request' | 'cookies' | 'params'> & { clientAddress?: string };

/** What a manifest says about its setup that this layer reads (the secret fields). */
type SetupManifestLite = Pick<AppManifest, 'id'> & { setup?: AppManifest['setup']; profiles?: AppManifest['profiles'] };

export interface SetupRouteDeps {
  service(): SetupServiceContract | null;
  resolve(request: Request): Promise<ResolvedPrincipal>;
  /** The installed app's parsed manifest, or null when there is no such app. */
  manifest(appId: string): SetupManifestLite | null;
  /** The owner's own System Terminal (its trusted system copy), D29. */
  trustedTerminal(p: InstancePrincipal): boolean;
  shellOwner(ctx: RouteCtx): Promise<{ error: string; status: number } | { identity: unknown }>;
}

export function liveSetupRouteDeps(): SetupRouteDeps {
  return {
    service: liveSetupService,
    resolve: (request) => resolveCaller(request),
    manifest: (appId) => (core.getAppManager().getManifest(appId) as SetupManifestLite | undefined) ?? null,
    trustedTerminal: (p) => isTrustedOwnerAgent(p, core.getAppManager()),
    shellOwner: (ctx) => shellOwner(ctx),
  };
}

// ── who acts ────────────────────────────────────────────────────────────────

const OWNER_ONLY = 'app setup is the owner\'s: use the desktop, Settings or the System Terminal';

/** The actor of a setup request, from the verified principal only; or the refusal to send. */
export async function setupActor(ctx: RouteCtx, change: boolean, deps: SetupRouteDeps): Promise<SetupActor | Response> {
  const r = await deps.resolve(ctx.request);
  if (r.rejected || (r.via === 'unverified' && bearerToken(ctx.request) !== null)) return json({ error: 'invalid-credential' }, 401);
  const p = r.principal;
  if (p.kind === 'operator') return { kind: 'operator' };
  if (p.kind === 'anonymous') return json({ error: 'unauthenticated' }, 401);
  if (core.isForeignPrincipal(p as { systemId?: unknown })) return json({ error: 'foreign-system' }, 403);
  if (p.kind === 'user') {
    // Alpha: owner-only (D108 §9.1); a member's setup values arrive with BT-M1.
    if (p.role !== 'owner') return json({ error: 'owner-required', message: OWNER_ONLY }, 403);
    // An App Host cookie: the owner inside an ordinary app's page acts as that app, never as the owner.
    if (p.through && r.via === 'app-host') return json({ error: 'owner-required', message: OWNER_ONLY }, 403);
    // A login cookie rides on a sibling App Host's request too: a change by cookie needs the desktop's own Origin.
    if (change && !p.through && bearerToken(ctx.request) === null) {
      const owner = await deps.shellOwner(ctx);
      if ('error' in owner) return json({ error: owner.error }, owner.status);
    }
    return { kind: 'user', userId: p.userId };
  }
  if (p.kind === 'instance') {
    // The System Terminal by its own token (the CLI, agents), acting for its user (D29).
    if (p.appId === core.TERMINAL_APP_ID && !p.sidecar && r.via === 'instance-token' && deps.trustedTerminal(p)) {
      return { kind: 'terminal', userId: p.userId ?? core.DEFAULT_OWNER_ID, instanceId: p.instanceId };
    }
    return json({ error: 'access-denied', message: OWNER_ONLY }, 403);
  }
  return json({ error: 'access-denied', message: OWNER_ONLY }, 403);
}

// ── the request body ────────────────────────────────────────────────────────

const PROPOSAL_KEYS = ['profile', 'values', 'secrets', 'overrides'] as const;
/** Words a caller might hope skip an approval. None exists (D108 §5.4). */
const NO_SKIP = new Set(['yes', 'force', 'approve', 'approved', 'autoApprove', 'skipApproval', 'confirm']);
const OVERRIDE_VALUES: Record<keyof DesiredOverrides, (v: unknown) => boolean> = {
  homeEnvironment: (v) => v === 'app' || v === 'private',
  instanceScope: (v) => v === 'per-user' || v === 'shared',
  environmentScope: (v) => v === 'global' || v === 'user',
  sandbox: (v) => typeof v === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(v),
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const isConfigValue = (v: unknown): boolean =>
  typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string'
  || (Array.isArray(v) && v.every((e) => typeof e === 'string'));

/** The secret fields of the base setup and every profile (their values come only as vault handles). */
export function secretFields(m: SetupManifestLite): Set<string> {
  const out = new Set<string>();
  for (const [name, f] of Object.entries(m.setup?.fields ?? {})) if (f.type === 'secret') out.add(name);
  for (const p of m.profiles ?? []) {
    for (const [name, f] of Object.entries(p.setup?.fields ?? {})) if ((f as { type?: string }).type === 'secret') out.add(name);
  }
  return out;
}

const invalid = (message: string, extra: Omit<SetupErrorBody, 'error' | 'category' | 'message'> = {}): SetupErrorBody =>
  core.setupError('config-invalid', message, extra);

/**
 * A request body as a SetupProposal, or the D105 refusal. Checks the shape
 * only (the engine checks values against the fields); never echoes a value.
 */
export function parseProposal(raw: unknown, secrets: ReadonlySet<string>): SetupProposal | SetupErrorBody {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) return invalid('the request body must be a JSON object');
  const unknown = Object.keys(raw).filter((k) => !(PROPOSAL_KEYS as readonly string[]).includes(k));
  if (unknown.length) {
    const skip = unknown.some((k) => NO_SKIP.has(k));
    return invalid(`unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}: a setup request takes ${PROPOSAL_KEYS.join(', ')}`,
      skip ? { hint: 'no approval is ever skipped: the owner approves in the desktop, or the host operator with aura approve' } : {});
  }
  const out: SetupProposal = {};
  const fieldErrors: Record<string, string> = {};

  if (raw['profile'] !== undefined) {
    const p = raw['profile'];
    if (p !== null && (typeof p !== 'string' || !core.PROFILE_ID_RE.test(p))) {
      return invalid('profile must be a profile id (kebab-case) or null', { manifestField: 'profiles' });
    }
    out.profile = p as string | null;
  }

  if (raw['values'] !== undefined) {
    const v = raw['values'];
    if (!isPlainObject(v)) return invalid('values must be an object of field → value');
    const values: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!core.FIELD_NAME_RE.test(k)) { fieldErrors[k] = 'not a field name'; continue; }
      if (secrets.has(k)) { fieldErrors[k] = 'a secret field: pass its vault handle in secrets, never a value'; continue; }
      if (!isConfigValue(val)) { fieldErrors[k] = 'must be a boolean, number, string or list of strings'; continue; }
      values[k] = val;
    }
    out.values = values;
  }

  if (raw['secrets'] !== undefined) {
    const s = raw['secrets'];
    if (!isPlainObject(s)) return invalid('secrets must be an object of field → vault handle');
    const handles: Record<string, string> = {};
    for (const [k, h] of Object.entries(s)) {
      if (!core.FIELD_NAME_RE.test(k)) { fieldErrors[k] = 'not a field name'; continue; }
      if (typeof h !== 'string' || !core.isCredentialHandle(h)) { fieldErrors[k] = 'must be a vault handle (cred_…), never a value'; continue; }
      if (!secrets.has(k)) { fieldErrors[k] = 'not a secret field of this app'; continue; }
      handles[k] = h;
    }
    out.secrets = handles;
  }

  if (raw['overrides'] !== undefined) {
    const o = raw['overrides'];
    if (!isPlainObject(o)) return invalid('overrides must be an object');
    const overrides: DesiredOverrides = {};
    for (const [k, val] of Object.entries(o)) {
      const ok = OVERRIDE_VALUES[k as keyof DesiredOverrides];
      if (!ok) { fieldErrors[`overrides.${k}`] = `not an override (${Object.keys(OVERRIDE_VALUES).join(', ')})`; continue; }
      if (!ok(val)) { fieldErrors[`overrides.${k}`] = 'not a valid value'; continue; }
      (overrides as Record<string, unknown>)[k] = val;
    }
    out.overrides = overrides;
  }

  if (Object.keys(fieldErrors).length) return invalid('the setup request has invalid fields', { fieldErrors });
  return out;
}

const isErrorBody = (v: unknown): v is SetupErrorBody =>
  isPlainObject(v) && typeof v['error'] === 'string' && (core.SETUP_ERROR_CODES as readonly string[]).includes(v['error'])
  && typeof v['message'] === 'string';

// ── the answer ──────────────────────────────────────────────────────────────

/** A refusal's status: 422 for invalid input, 409 for everything the app's state or this system refuses. */
export const errorStatus = (b: Pick<SetupErrorBody, 'category'>): number => (b.category === 'invalid-request' ? 422 : 409);

/** A SetupOutcome's status (CLI: 0 / 75 / 3 / 5). */
export function outcomeStatus(o: SetupOutcome): number {
  switch (o.status) {
    case 'ready': case 'unchanged': return 200;
    case 'on-hold': case 'initializing': return 202;
    case 'refused': default: return o.error ? errorStatus(o.error) : 409;
  }
}

/** A thrown engine error: its D105 body when it carries one, else a plain 500 (the message stays in the log). */
export function thrownResponse(err: unknown): Response {
  const body = (err as { body?: unknown } | null)?.body;
  if (isErrorBody(body)) return json(body, errorStatus(body));
  console.warn(`[setup] engine call failed: ${(err as Error)?.message ?? String(err)}`);
  return json({ error: 'internal', message: 'the setup engine failed; see the shell log' }, 500);
}

async function readBody(request: Request): Promise<unknown | Response> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  // JSON only: a cross-site form can't send it without a preflight.
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'json-required' }, 415);
  try { return JSON.parse(text) as unknown; } catch { return json(invalid('the request body is not JSON'), 422); }
}

/** One setup route: who, what, the engine call, its answer. */
export async function handleSetup(ctx: RouteCtx, op: SetupOp, deps: SetupRouteDeps = liveSetupRouteDeps()): Promise<Response> {
  const appId = ctx.params['id'];
  if (!appId) return json({ error: 'invalid-app' }, 400);
  const actor = await setupActor(ctx, CHANGES.has(op), deps);
  if (actor instanceof Response) return actor;
  const manifest = deps.manifest(appId);
  if (!manifest) return json({ error: 'app-not-found' }, 404);

  let proposal: SetupProposal = {};
  if (PROPOSES.has(op) && ctx.request.method !== 'GET') {
    const raw = await readBody(ctx.request);
    if (raw instanceof Response) return raw;
    const parsed = parseProposal(raw, secretFields(manifest));
    if ('error' in parsed) return json(parsed, errorStatus(parsed));
    proposal = parsed;
  }

  const svc = deps.service();
  if (!svc) return json(SETUP_UNAVAILABLE, 503);
  try {
    switch (op) {
      case 'state': return json(await svc.state(appId));
      case 'profiles': return json(await svc.profiles(appId));
      case 'plan': return json(ctx.request.method === 'GET' ? await svc.plan(appId) : await svc.plan(appId, proposal));
      case 'values': return json(await svc.values(appId));
      case 'secrets': return json(await svc.secretHandles(appId, actor));
      case 'askSecret': {
        // Only a secret field the app declares (base or a profile); the body carries nothing.
        const field = ctx.params['field'] ?? '';
        if (!secretFields(manifest).has(field)) {
          const e = invalid(`${field || '(none)'} is not a secret field of ${appId}`, { manifestField: 'setup.fields' });
          return json(e, errorStatus(e));
        }
        const asked = await svc.askSecret(appId, field, actor);
        // The engine created the request in the kernel: wake the desktop's approval dialog.
        approvalsChanged();
        return json(asked, 202);
      }
      default: {
        const o = await (op === 'resume' ? svc.resume(appId, actor) : svc[op](appId, proposal, actor));
        if (o.status === 'on-hold') approvalsChanged();
        return json(o, outcomeStatus(o));
      }
    }
  } catch (err) {
    return thrownResponse(err);
  }
}
