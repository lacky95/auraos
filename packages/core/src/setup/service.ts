/**
 * The setup engine (D108 P3, review §3–§5): `SetupService` implements the
 * `SetupServiceContract` the API, the CLI, the wizard and `/api/setup/self`
 * call, and the `SetupGate` AppManager asks at its start choke point.
 *
 *   plan / profiles / values / state   read-only: the resolution of the
 *                    stored (or a proposed) desired configuration, steps that
 *                    are not needed skipped, the approval it would ask for
 *   apply / setValues / reconfigure / repair
 *                    1. the proposal is resolved without writing anything;
 *                       a refusal (invalid values, unsupported, policy) leaves
 *                       every record as it was
 *                    2. `configuring`: step + the desired record written
 *                       BEFORE acting (§3.3), generated secrets added
 *                       (`updatedBy: kernel`)
 *                    3. privileges added → one `app.setup.apply` (D102) bound
 *                       to both digests, requested by the calling actor →
 *                       `awaiting-approval` (on hold)
 *                    4. `initializing`: the app's hooks in a maintenance start
 *                       (hooks.ts) → `ready` only through `markReady`, CAS
 *                       with the digests just validated
 *   resume           continues at the recorded step: a pending approval is
 *                    never asked twice; an approved one is revalidated
 *                    against the current digests (a changed configuration
 *                    needs a new one) and consumed once; `initializing` is
 *                    retried (idempotent) up to MAX_INIT_ATTEMPTS
 *   check (gate)     declaring app: `ready` and the stored `configDigest`
 *                    equal to the freshly resolved one, else a 409 D105
 *                    `needs-setup` body. The engine's own maintenance start
 *                    (reason `setup` while `initializing`) is the exception
 *
 *   P8 (change.ts) changePlan (the grantDigest diff, §5.5 compatibility,
 *                    data that stays behind), the last applied configuration
 *                    and its explicit restore (decision 13), the user's own
 *                    Private Home revocation, and the update re-resolution
 *                    `onManifestChanged` (renames, `onMigrateConfig` fail
 *                    closed, `repair-required` on invalid values, a new
 *                    required field or a dropped profile)
 *
 * Decision 3: no profile picked for the caller, except "exactly one
 * feasible input-free profile" (`autoSelectableProfile`); otherwise
 * `profile-required`. Requests never grant before the approval; on its
 * consumption the existing grant paths record what it covers (GrantStore
 * app grants, the Private Home through P9). Secrets only as vault handles:
 * nothing here logs, audits or returns a value.
 */
import type { ConfigField, ConfigValue } from '../config/schema.js';
import type { MaintenanceReason } from '../app-manager/maintenance.js';
import type { SidecarSetupValues } from '../app-manager/sidecar-spec.js';
import type { ApprovalRecord, ApprovalRequester } from '../approvals/types.js';
import type { ChangeAttribution } from '../auth/types.js';
import { setupGateBlock, type OperationalBlock } from '../contract/types.js';
import { SETUP_SECRET_PREFIX } from '../context/CredentialVault.js';
import {
  declaresSetup, setupApplyClass, setupApplyNeedsFresh, setupError, SETUP_APPLY_ACTION, SETUP_AUDIT_ACTIONS,
  type DesiredConfig, type EffectiveConfig, type FieldView, type InstallationSetupSummary, type OperationalState,
  type ProfileOption, type Resolution, type SecretHandleOption, type SetupActor, type SetupApplyPayload, type SetupConfigView,
  type SetupErrorBody, type SetupErrorCode, type SetupOutcome, type SetupPlan, type SetupPlanStep, type SetupProposal,
  type SetupReason, type SetupStateView, type SetupValuesView, type SetupStep,
} from './contracts.js';
import { approvable, askSecretDisplay, askSecretName, missingAuthorizations, setupApplyDisplay, setupApplyPayload, setupRequesterLabel } from './approval.js';
import { needsHooks, runSetupHooks, SetupHookError } from './hooks.js';
import type { ApprovedRequests, SetupAppManifest, SetupEngine, SetupEngineDeps, SetupGateDecision } from './ports.js';
import { effectiveManifestView } from './merge.js';
import { autoSelectableProfile, profileOptions, resolveEffective } from './resolve.js';
import type { DesiredRead } from './store.js';
import { generateSetupSecrets, setupConfigView, sidecarSetupValues, vaultSecretReader } from './values.js';
import { blockingDecision, BlockingWatcher } from './blocking.js';
import {
  compatibilityIssues, dataStaysBehind, DATA_STAYS_NOTE, fieldScopesOf, grantDiff, migrateDesired, RESTORE_NOTICE,
  type FieldScopes, type HomePrivateGrantView, type LastAppliedView, type ManifestChangeOutcome, type SetupChangePlan,
} from './change.js';
import { grantBearingOf } from './digest.js';
import { HOME_PRIVATE_AUDIT } from './homeEnvironment.js';
import { HOME_PRIVATE_PERMISSION, homePrivateSidecarPermission } from './contracts.js';
import { NO_MAINTENANCE_HINT } from './hooks.js';

/** Init attempts of one run (a kernel restart during `initializing` retries, then `setup-failed`). */
export const MAX_INIT_ATTEMPTS = 3;
const NONE: ApprovedRequests = Object.freeze({ permissions: [], tools: [] });

/** An engine refusal thrown to the routes: carries the D105 body (`code`, `body`). */
export class SetupEngineError extends Error {
  readonly code: SetupErrorCode;
  constructor(readonly body: SetupErrorBody) { super(body.message); this.name = 'SetupEngineError'; this.code = body.error; }
}
const fail = (code: SetupErrorCode, message: string, extra: Omit<SetupErrorBody, 'error' | 'category' | 'message'> = {}) =>
  new SetupEngineError(setupError(code, message, extra));

/** Everything one operation reads about an app. */
interface Ctx {
  appId: string;
  m: SetupAppManifest;
  declares: boolean;
  installationId: string;
  userId: string;
  summary: InstallationSetupSummary | null;
  state: OperationalState;
  desired: DesiredRead;
  userDesired: DesiredRead;
}

interface FieldDecl { scope: 'installation' | 'user'; secret: boolean; source?: string; title: string }

/** Every field a manifest declares (base and profiles), by name: its scope and whether it is a secret. */
function fieldDecls(m: SetupAppManifest): Record<string, FieldDecl> {
  const out: Record<string, FieldDecl> = {};
  const take = (name: string, f: Partial<ConfigField> & { type?: string }) => {
    const prev = out[name];
    out[name] = {
      scope: f.scope === 'user' || prev?.scope === 'user' ? 'user' : 'installation',
      secret: f.type === 'secret' || prev?.secret === true,
      ...((f as { secret?: { source?: string } }).secret?.source ?? prev?.source ? { source: (f as { secret?: { source?: string } }).secret?.source ?? prev?.source } : {}),
      title: (f as { title?: string }).title ?? prev?.title ?? name,
    };
  };
  for (const [k, f] of Object.entries(m.setup?.fields ?? {})) take(k, f);
  for (const p of m.profiles ?? []) for (const [k, f] of Object.entries(p.setup?.fields ?? {})) take(k, f as Partial<ConfigField>);
  return out;
}

const emptyDesired = (setupVersion: number): DesiredConfig => ({
  v: 1, setupVersion, profile: null, values: {}, secrets: {}, overrides: {}, updatedAt: new Date(0).toISOString(), updatedBy: 'kernel',
});

const SIDECAR_RE = /^[a-z][a-z0-9-]{0,47}$/;
const actorUser = (actor: SetupActor, ownerId: string): string => (actor.kind === 'operator' ? ownerId : actor.userId);
/** The blocking codes a lost authorization, policy or feature gives (blocked, never a repair). */
const AUTHZ_CODES: ReadonlySet<string> = new Set(['requirement-unauthorized', 'policy-refused', 'requirement-unsupported']);

const updatedByOf = (actor: SetupActor): string => (actor.kind === 'operator' ? 'operator' : `user:${actor.userId}`);
const attributionOf = (actor: SetupActor): ChangeAttribution => (actor.kind === 'operator' ? { kind: 'operator' } : { kind: 'user', userId: actor.userId });
const isEmptyProposal = (p: SetupProposal): boolean =>
  p.profile === undefined && !Object.keys(p.values ?? {}).length && !Object.keys(p.secrets ?? {}).length && !Object.keys(p.overrides ?? {}).length;

/** Which state answers which gate code (§3.1). */
function gateCodeOf(state: OperationalState): 'setup-required' | 'setup-blocked' | 'repair-required' {
  if (state === 'blocked') return 'setup-blocked';
  if (state === 'repair-required') return 'repair-required';
  return 'setup-required';
}

/** The bodies that block a proposal, with the configuration-invalid ones merged into one (field → why, never a value). */
function refusalOf(bodies: SetupErrorBody[]): SetupErrorBody {
  const invalid = bodies.filter((b) => b.error === 'config-invalid');
  const other = bodies.filter((b) => b.error !== 'config-invalid');
  if (other.length) return other[0]!;
  if (invalid.length === 1) return invalid[0]!;
  const fieldErrors = Object.assign({}, ...invalid.map((b) => b.fieldErrors ?? {})) as Record<string, string>;
  return setupError('config-invalid', `${Object.keys(fieldErrors).length} setup fields are invalid or missing: ${Object.keys(fieldErrors).sort().join(', ')}`, { fieldErrors });
}

/** The non-grantable requests of a set of missing-authorization keys (or a payload's adds). */
function nonGrantable(keys: { permissions: readonly string[]; tools: readonly string[] }, grantable: (p: string) => boolean): ApprovedRequests {
  return { permissions: keys.permissions.filter((p) => !grantable(p)).sort(), tools: [...keys.tools].sort() };
}
function keysOf(missing: string[]): { permissions: string[]; tools: string[] } {
  const permissions: string[] = [];
  const tools: string[] = [];
  for (const m of missing) {
    if (m.startsWith('permission:')) permissions.push(m.slice('permission:'.length));
    else if (m.startsWith('tool:')) tools.push(m.slice('tool:'.length));
    else if (m.startsWith('capability:')) tools.push(m.slice('capability:'.length));
  }
  return { permissions, tools };
}

export class SetupService implements SetupEngine {
  private readonly now: () => Date;
  /** One operation at a time per installation (CAS protects the records; this keeps a run's steps in order). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Init runs in flight (installationId). */
  private readonly running = new Map<string, Promise<void>>();
  /** The non-grantable requests the approval of the current run covers (installationId). */
  private readonly consumed = new Map<string, ApprovedRequests>();
  /** The last gate refusal per app (the supervisor skip). */
  private readonly blocks = new Map<string, OperationalBlock>();
  /** The gate-validated effective configuration of a ready app (sidecar values). */
  private readonly effective = new Map<string, EffectiveConfig>();
  private watcher: BlockingWatcher | null = null;

  constructor(private readonly deps: SetupEngineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return next;
  }

  private async audit(entry: Parameters<SetupEngineDeps['audit']>[0]): Promise<void> {
    try { await this.deps.audit(entry); } catch { /* the audit trail never fails a setup step */ }
  }

  private emit(ctx: Pick<Ctx, 'appId' | 'installationId'>, previous: OperationalState | null, next: InstallationSetupSummary): void {
    try {
      this.deps.emit({ appId: ctx.appId, installationId: ctx.installationId, state: next.state, previous, step: next.step });
    } catch { /* an event listener never fails a step */ }
    if (previous !== next.state) {
      void this.audit({
        by: { kind: 'system' }, action: SETUP_AUDIT_ACTIONS.stateChanged, target: `app:${ctx.appId}`, outcome: 'ok',
        detail: { installation: ctx.installationId, from: previous, to: next.state, step: next.step, ...(next.error ? { code: next.error.error } : {}) },
      });
    }
  }

  private async ctx(appId: string): Promise<Ctx> {
    const m = this.deps.manifest(appId);
    if (!m) throw fail('setup-blocked', `${appId} is not installed`, { target: appId });
    const inst = await this.deps.installation(appId);
    if (!inst) throw fail('setup-blocked', `${appId} has no installation record yet; try again in a moment`, { target: appId });
    const userId = this.deps.ownerId;
    const declares = declaresSetup(m);
    if (!declares) {
      const none: DesiredRead = { value: null, stored: null, tampered: false };
      return { appId, m, declares, installationId: inst.installationId, userId, summary: null, state: 'ready', desired: none, userDesired: none };
    }
    const desired = await this.deps.states.desired({ installationId: inst.installationId });
    const userDesired = await this.deps.states.desired({ installationId: inst.installationId, userId });
    const s = await this.deps.states.state(inst.installationId, m);
    return { appId, m, declares, installationId: inst.installationId, userId, summary: s.summary, state: s.state, desired, userDesired };
  }

  private viewOf(ctx: Ctx, r?: Resolution | null): SetupStateView {
    const s = ctx.summary;
    return {
      appId: ctx.appId, installationId: ctx.installationId, declares: ctx.declares, state: ctx.state,
      profile: s?.profile ?? ctx.desired.value?.profile ?? null,
      step: s?.step ?? null,
      configDigest: s?.configDigest ?? null,
      ...(s?.state === 'awaiting-approval' && s.approvalId ? { approvalId: s.approvalId } : {}),
      ...(s?.error ? { error: s.error } : {}),
      degraded: r?.degraded ?? this.effective.get(ctx.appId)?.degraded ?? [],
    };
  }

  private withSummary(ctx: Ctx, summary: InstallationSetupSummary): Ctx {
    return { ...ctx, summary, state: summary.state };
  }

  /** The stored desired records with a proposal applied (nothing written). */
  private proposed(ctx: Ctx, proposal: SetupProposal, by: string, repair = false): { desired: DesiredConfig; userDesired: DesiredConfig | null } {
    const version = ctx.m.setup?.version ?? 0;
    const desired = structuredClone(ctx.desired.value ?? emptyDesired(version));
    const user = ctx.userDesired.value ? structuredClone(ctx.userDesired.value) : null;
    const userDesired: DesiredConfig = user ?? emptyDesired(desired.setupVersion);
    if (repair && ctx.m.setup && desired.setupVersion !== version) {
      // P8: a repair after a `setup.version` change keeps the stored values under their new names.
      const at = this.now().toISOString();
      Object.assign(desired, migrateDesired(desired, ctx.m.setup, at).desired);
      Object.assign(userDesired, migrateDesired(userDesired, ctx.m.setup, at).desired);
    }
    if (repair) { desired.setupVersion = version; userDesired.setupVersion = version; }
    const decls = fieldDecls(ctx.m);
    if (proposal.profile !== undefined) desired.profile = proposal.profile;
    for (const [k, v] of Object.entries(proposal.values ?? {})) {
      const target = decls[k]?.scope === 'user' ? userDesired : desired;
      if (v === null) delete target.values[k];
      else target.values[k] = v as ConfigValue;
    }
    for (const [k, h] of Object.entries(proposal.secrets ?? {})) {
      const target = decls[k]?.scope === 'user' ? userDesired : desired;
      target.secrets[k] = h;
    }
    if (proposal.overrides) desired.overrides = { ...desired.overrides, ...proposal.overrides };
    const changed = !isEmptyProposal(proposal) || repair;
    if (changed) {
      const at = this.now().toISOString();
      desired.updatedAt = at; desired.updatedBy = by;
      userDesired.updatedAt = at; userDesired.updatedBy = by;
    }
    const keepUser = user !== null || Object.keys(userDesired.values).length > 0 || Object.keys(userDesired.secrets).length > 0;
    return { desired, userDesired: keepUser ? userDesired : null };
  }

  /** A `source: ask` secret the owner stored through the shell's dialog: bound by its vault name (D56). */
  private async bindAsked(ctx: Ctx, desired: DesiredConfig, userDesired: DesiredConfig | null): Promise<void> {
    for (const [name, d] of Object.entries(fieldDecls(ctx.m))) {
      if (!d.secret || d.source !== 'ask') continue;
      const target = d.scope === 'user' ? userDesired : desired;
      if (!target || target.secrets[name]) continue;
      let handle: string | null = null;
      try { handle = await this.deps.vault.handleOf(ctx.userId, askSecretName(ctx.appId, name), ctx.appId); } catch { handle = null; }
      if (handle) target.secrets[name] = handle;
    }
  }

  private async resolveWith(ctx: Ctx, desired: DesiredConfig | null, userDesired: DesiredConfig | null, approved: ApprovedRequests): Promise<Resolution> {
    const q = { appId: ctx.appId, installationId: ctx.installationId, userId: ctx.userId, manifest: ctx.m, approved };
    const input = { appId: ctx.appId, installationId: ctx.installationId, userId: ctx.userId, manifest: ctx.m, desired, userDesired };
    const first = resolveEffective(input, await this.deps.resolverPorts(q));
    if (first.requested.homeEnvironment !== 'private') return first;
    // D107-a: the Private Home is authorized against the requested configuration (the profile's
    // sidecar networks and homes), not the base manifest; the second pass is the answer.
    return resolveEffective(input, await this.deps.resolverPorts({ ...q, homeView: effectiveManifestView(ctx.m, first.requested) }));
  }

  /** The approval record of the run in `initializing` (kept on the summary), when still readable. */
  private async runApproval(ctx: Ctx): Promise<ApprovedRequests | null> {
    const inRun = this.consumed.get(ctx.installationId);
    if (inRun) return inRun;
    const id = ctx.summary?.state === 'initializing' ? ctx.summary.approvalId : undefined;
    if (!id) return null;
    const rec = await this.deps.approvals.get(id).catch(() => null);
    const adds = (rec?.state === 'consumed' ? (rec.payload as SetupApplyPayload | undefined)?.adds : undefined);
    return adds ? nonGrantable(adds, (p) => this.deps.grants.grantable(p)) : null;
  }

  /**
   * The resolution of a desired state as authorized now: grantable requests
   * count only through their grants; the non-grantable ones a profile adds
   * count when the approval of this run covers them, or when the
   * privilege-bearing part is exactly the one `ready` was approved with.
   */
  private async resolveCurrent(ctx: Ctx, desired: DesiredConfig | null, userDesired: DesiredConfig | null): Promise<Resolution> {
    const run = await this.runApproval(ctx);
    let r = await this.resolveWith(ctx, desired, userDesired, run ?? NONE);
    if (!run && ctx.summary?.grantDigest && r.grantDigest === ctx.summary.grantDigest && !r.authorized.ok) {
      const extra = nonGrantable(keysOf(missingAuthorizations(r)), (p) => this.deps.grants.grantable(p));
      if (extra.permissions.length || extra.tools.length) r = await this.resolveWith(ctx, desired, userDesired, extra);
    }
    return r;
  }

  /** The fields whose missing value the vault generates (no owner input). */
  private generated(ctx: Ctx): Set<string> {
    return new Set(Object.entries(fieldDecls(ctx.m)).filter(([, d]) => d.secret && d.source === 'generate').map(([k]) => k));
  }

  /** What blocks a proposal beyond the owner's approval and the generated secrets. */
  private hardBlockers(ctx: Ctx, r: Resolution): SetupErrorBody[] {
    const gen = this.generated(ctx);
    return r.blocking.filter((b) => {
      if (approvable(b, (p) => this.deps.grants.grantable(p))) return false;
      if (b.error === 'config-invalid' && b.fieldErrors && Object.entries(b.fieldErrors).every(([f, why]) => why === 'required' && gen.has(f))) return false;
      return true;
    });
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async state(appId: string): Promise<SetupStateView> {
    return this.viewOf(await this.ctx(appId));
  }

  async profiles(appId: string): Promise<ProfileOption[]> {
    const ctx = await this.ctx(appId);
    if (!ctx.declares || !(ctx.m.profiles ?? []).length) return [];
    const ports = await this.deps.resolverPorts({ appId, installationId: ctx.installationId, userId: ctx.userId, manifest: ctx.m, approved: NONE });
    return profileOptions(ctx.m, ports, { appId, installationId: ctx.installationId, userId: ctx.userId, desired: ctx.desired.value, userDesired: ctx.userDesired.value });
  }

  async plan(appId: string, proposal: SetupProposal = {}): Promise<SetupPlan> {
    const ctx = await this.ctx(appId);
    if (!ctx.declares) {
      const steps = (['profile', 'values', 'requirements', 'review', 'approval', 'init', 'readiness'] as SetupStep[])
        .map((step): SetupPlanStep => ({ step, title: step, status: 'skipped' }));
      return {
        appId, state: this.viewOf(ctx), steps: [...steps, { step: 'done', title: 'Ready', status: 'done' }], profiles: [], fields: [], requirements: [],
        approval: null, blocking: [], degraded: [], configDigest: '', grantDigest: '',
      };
    }
    const { desired, userDesired } = this.proposed(ctx, proposal, 'kernel');
    await this.bindAsked(ctx, desired, userDesired);
    const ports = await this.deps.resolverPorts({ appId, installationId: ctx.installationId, userId: ctx.userId, manifest: ctx.m, approved: NONE });
    const pctx = { appId, installationId: ctx.installationId, userId: ctx.userId, desired, userDesired };
    if ((ctx.m.profiles ?? []).length && desired.profile === null) {
      const auto = autoSelectableProfile(ctx.m, ports, pctx);
      if (auto) desired.profile = auto;
    }
    const r = await this.resolveCurrent(ctx, desired, userDesired);
    const profiles = (ctx.m.profiles ?? []).length ? profileOptions(ctx.m, ports, pctx) : [];
    const approval = setupApplyPayload(r, ctx.m);
    const fields: FieldView[] = Object.entries(r.fields).map(([name, field]) => {
      const value = r.requested.values[name] ?? desired.values[name] ?? userDesired?.values[name];
      const error = r.values.fieldErrors[name] ?? (r.values.missing.includes(name) && !(field.type === 'secret' && field.secret.source === 'generate') ? 'required' : undefined);
      return {
        name, field,
        ...(field.type === 'secret' ? { hasSecret: name in r.requested.secrets } : value !== undefined ? { value } : {}),
        ...(error ? { error } : {}),
      };
    });
    const hard = this.hardBlockers(ctx, r);
    const ready = ctx.state === 'ready' && r.effective !== null && r.configDigest === ctx.summary?.configDigest;
    const has = (code: string) => hard.some((b) => b.error === code);
    const st = (skip: boolean, blocked: boolean, done: boolean): SetupPlanStep['status'] => (skip ? 'skipped' : blocked ? 'blocked' : done ? 'done' : 'todo');
    const hasRequirements = r.feasible.requirements.length > 0 || !r.policy.ok;
    const steps: SetupPlanStep[] = [
      { step: 'profile', title: 'Operating profile', status: st(!(ctx.m.profiles ?? []).length, has('unknown-profile') || has('profile-unavailable'), r.profile !== null && !has('profile-required')) },
      { step: 'values', title: 'Settings', status: st(Object.keys(r.fields).length === 0, false, r.values.ok || !has('config-invalid')) },
      { step: 'requirements', title: 'Requirements', status: st(!hasRequirements, has('requirement-unsupported') || has('policy-refused'), r.feasible.ok && r.policy.ok) },
      { step: 'review', title: 'Review', status: ready ? 'done' : 'todo' },
      { step: 'approval', title: 'Your approval', status: st(approval === null, false, ready) },
      { step: 'init', title: 'Initialize', status: st(ctx.m.setup?.init?.hook !== true, false, ready) },
      { step: 'readiness', title: 'Check', status: st(ctx.m.setup?.readiness?.hook !== true, false, ready) },
      { step: 'done', title: 'Ready', status: ready ? 'done' : 'todo' },
    ];
    return {
      appId, state: this.viewOf(ctx, r), steps, profiles, fields, requirements: r.feasible.requirements, approval,
      blocking: r.blocking, degraded: r.degraded, configDigest: r.configDigest, grantDigest: r.grantDigest,
    };
  }

  async values(appId: string): Promise<SetupValuesView> {
    const ctx = await this.ctx(appId);
    if (!ctx.declares) return { appId, profile: null, desired: null, effective: null, fields: [], degraded: [] };
    const r = await this.resolveCurrent(ctx, ctx.desired.value, ctx.userDesired.value);
    const d = ctx.desired.value;
    const u = ctx.userDesired.value;
    return {
      appId, profile: d?.profile ?? null,
      desired: d ? {
        values: { ...d.values, ...(u?.values ?? {}) }, secrets: { ...d.secrets, ...(u?.secrets ?? {}) }, overrides: { ...d.overrides }, setupVersion: d.setupVersion,
      } : null,
      effective: r.effective ? { values: { ...r.effective.values }, secrets: { ...r.effective.secrets }, configDigest: r.effective.configDigest } : null,
      fields: Object.entries(r.fields).map(([name, field]) => ({
        name, field,
        ...(field.type === 'secret' ? { hasSecret: name in r.requested.secrets } : r.requested.values[name] !== undefined ? { value: r.requested.values[name] } : {}),
        ...(r.values.fieldErrors[name] ? { error: r.values.fieldErrors[name] } : {}),
      })),
      degraded: r.degraded,
    };
  }

  // ── changes ───────────────────────────────────────────────────────────────

  setValues(appId: string, proposal: SetupProposal, actor: SetupActor): Promise<SetupOutcome> { return this.change(appId, proposal, actor, 'values'); }
  apply(appId: string, proposal: SetupProposal, actor: SetupActor): Promise<SetupOutcome> { return this.change(appId, proposal, actor, 'setup'); }
  reconfigure(appId: string, proposal: SetupProposal, actor: SetupActor): Promise<SetupOutcome> { return this.change(appId, proposal, actor, 'reconfigure'); }
  repair(appId: string, proposal: SetupProposal, actor: SetupActor): Promise<SetupOutcome> { return this.change(appId, proposal, actor, 'repair'); }

  private async change(appId: string, proposal: SetupProposal, actor: SetupActor, mode: 'values' | 'setup' | 'reconfigure' | 'repair'): Promise<SetupOutcome> {
    const first = await this.ctx(appId);
    if (!first.declares) return { status: 'unchanged', state: this.viewOf(first) };
    return this.serial(first.installationId, async () => {
      const ctx = await this.ctx(appId);
      if (ctx.state === 'awaiting-approval' && isEmptyProposal(proposal) && mode !== 'repair') return this.resumeLocked(ctx, actor);
      return this.changeLocked(ctx, proposal, actor, mode);
    });
  }

  private refused(ctx: Ctx, error: SetupErrorBody, r?: Resolution): SetupOutcome {
    return { status: 'refused', state: this.viewOf(ctx, r), error };
  }

  private async changeLocked(
    ctx: Ctx, proposal: SetupProposal, actor: SetupActor, mode: 'values' | 'setup' | 'reconfigure' | 'repair',
    explicit?: { desired: DesiredConfig; userDesired: DesiredConfig | null },
  ): Promise<SetupOutcome> {
    if (ctx.state === 'initializing') {
      return this.refused(ctx, setupError('setup-required', `${ctx.appId} is initializing; wait for it, then change the setup`, { state: 'initializing', target: ctx.appId }));
    }
    const { desired, userDesired } = explicit ?? this.proposed(ctx, proposal, updatedByOf(actor), mode === 'repair');
    await this.bindAsked(ctx, desired, userDesired);
    // Decision 3: only exactly one feasible input-free profile is ever picked for the caller.
    if ((ctx.m.profiles ?? []).length && desired.profile === null) {
      const ports = await this.deps.resolverPorts({ appId: ctx.appId, installationId: ctx.installationId, userId: ctx.userId, manifest: ctx.m, approved: NONE });
      const auto = autoSelectableProfile(ctx.m, ports, { appId: ctx.appId, installationId: ctx.installationId, userId: ctx.userId, desired, userDesired });
      if (auto) desired.profile = auto;
    }
    // 1. Resolve without writing: a refused proposal changes nothing.
    const dry = await this.resolveCurrent(ctx, desired, userDesired);
    const hard = this.hardBlockers(ctx, dry);
    if (hard.length) return this.refused(ctx, refusalOf(hard), dry);
    // P8 (§5.5): per-user values never become installation values; no shared instance with per-user secrets.
    const compat = compatibilityIssues({ to: dry.requested, desired, userDesired, scopes: this.scopes(ctx, dry) });
    if (compat.length) return this.refused(ctx, compat[0]!, dry);
    const dryPayload = setupApplyPayload(dry, ctx.m);
    if (mode === 'values' && (dryPayload || (ctx.summary?.grantDigest && dry.grantDigest !== ctx.summary.grantDigest))) {
      return this.refused(ctx, setupError('setup-blocked', `this change of ${ctx.appId} changes what it may do (${dryPayload ? 'it adds privileges' : 'its privilege-bearing part'}); `
        + 'a plain value change cannot: apply it as a setup, which asks for your approval', { state: ctx.state, target: ctx.appId }), dry);
    }
    if (ctx.state === 'ready' && dry.effective && dry.configDigest === ctx.summary?.configDigest && !dryPayload) {
      return { status: 'unchanged', state: this.viewOf(ctx, dry) };
    }

    // 2. configuring: step and desired record before acting (§3.3).
    let summary = await this.deps.states.begin(ctx.installationId, ctx.m);
    let cur = this.withSummary(ctx, summary);
    summary = await this.toConfiguring(cur, summary);
    cur = this.withSummary(ctx, summary);
    this.consumed.delete(ctx.installationId);
    await this.writeDesired(cur, desired, userDesired);
    // Generated secrets: the vault creates them, bound to this installation (no value leaves it).
    const generated = await this.generateSecrets(cur, dry, desired, userDesired);
    const r = generated ? await this.resolveCurrent(cur, desired, userDesired) : dry;
    const still = this.hardBlockers(cur, r);
    if (still.length) return this.failRun(cur, summary, refusalOf(still), r);
    const payload = setupApplyPayload(r, ctx.m);
    if (payload) return this.requestApproval(cur, summary, r, payload, actor);
    if (!r.effective) return this.failRun(cur, summary, refusalOf(r.blocking), r);
    return this.initialize(cur, summary, r, mode === 'repair' ? 'repair' : ctx.summary?.configDigest ? 'reconfigure' : 'setup');
  }

  private async toConfiguring(ctx: Ctx, s: InstallationSetupSummary): Promise<InstallationSetupSummary> {
    let summary = s;
    if (summary.state === 'awaiting-approval' && summary.approvalId) {
      await this.deps.approvals.cancel(summary.approvalId, { kind: 'system', reason: 'superseded by a new setup proposal' }).catch(() => undefined);
    }
    const prev = summary.state;
    if (summary.state === 'configuring') summary = await this.deps.states.progress(ctx.installationId, summary, { step: 'values', approvalId: null });
    else summary = await this.deps.states.transition(ctx.installationId, summary, 'configuring', { step: 'values', attempt: 0, approvalId: null });
    this.emit(ctx, prev, summary);
    return summary;
  }

  private async writeDesired(ctx: Ctx, desired: DesiredConfig, userDesired: DesiredConfig | null): Promise<void> {
    const w = await this.deps.store.update({ installationId: ctx.installationId }, () => desired);
    if (!w.ok) throw fail('setup-blocked', `the setup of ${ctx.appId} changed meanwhile; try again`, { target: ctx.appId });
    if (userDesired) {
      const u = await this.deps.store.update({ installationId: ctx.installationId, userId: ctx.userId }, () => ({ ...userDesired, profile: null, overrides: {} }));
      if (!u.ok) throw fail('setup-blocked', `the setup of ${ctx.appId} changed meanwhile; try again`, { target: ctx.appId });
    }
  }

  /** Creates the missing `generate` secrets of the active fields and stores their handles (`updatedBy: kernel`). True when any was added. */
  private async generateSecrets(ctx: Ctx, r: Resolution, desired: DesiredConfig, userDesired: DesiredConfig | null): Promise<boolean> {
    const active = Object.entries(r.fields).filter(([, f]) => f.type === 'secret' && f.secret.source === 'generate');
    if (!active.length) return false;
    const inst = Object.fromEntries(active.filter(([, f]) => f.scope !== 'user'));
    const user = Object.fromEntries(active.filter(([, f]) => f.scope === 'user'));
    const base = { userId: ctx.userId, appId: ctx.appId, installationId: ctx.installationId, audit: (e: Parameters<SetupEngineDeps['audit']>[0]) => this.audit(e) };
    const made = await generateSetupSecrets(this.deps.vault, { ...base, fields: inst, have: desired.secrets });
    const madeUser = Object.keys(user).length ? await generateSetupSecrets(this.deps.vault, { ...base, fields: user, have: userDesired?.secrets ?? {} }) : {};
    if (!Object.keys(made).length && !Object.keys(madeUser).length) return false;
    const at = this.now().toISOString();
    if (Object.keys(made).length) {
      Object.assign(desired.secrets, made);
      const w = await this.deps.store.update({ installationId: ctx.installationId }, (c) => ({ ...(c ?? desired), secrets: { ...(c ?? desired).secrets, ...made }, updatedAt: at, updatedBy: 'kernel' }));
      if (!w.ok) throw fail('setup-blocked', `the setup of ${ctx.appId} changed meanwhile; try again`, { target: ctx.appId });
    }
    if (Object.keys(madeUser).length) {
      const u = userDesired ?? emptyDesired(desired.setupVersion);
      Object.assign(u.secrets, madeUser);
      const w = await this.deps.store.update({ installationId: ctx.installationId, userId: ctx.userId }, (c) => ({ ...(c ?? u), secrets: { ...(c ?? u).secrets, ...madeUser }, profile: null, overrides: {}, updatedAt: at, updatedBy: 'kernel' }));
      if (!w.ok) throw fail('setup-blocked', `the setup of ${ctx.appId} changed meanwhile; try again`, { target: ctx.appId });
    }
    return true;
  }

  private async failRun(ctx: Ctx, s: InstallationSetupSummary, error: SetupErrorBody, r?: Resolution): Promise<SetupOutcome> {
    const body: SetupErrorBody = { ...error, state: 'setup-failed' };
    let summary = s;
    if (s.state !== 'setup-failed') {
      summary = await this.deps.states.transition(ctx.installationId, s, 'setup-failed', { error: body, approvalId: null });
      this.emit(ctx, s.state, summary);
    }
    this.consumed.delete(ctx.installationId);
    return this.refused(this.withSummary(ctx, summary), body, r);
  }

  // ── approval ──────────────────────────────────────────────────────────────

  private async requestApproval(ctx: Ctx, s: InstallationSetupSummary, r: Resolution, payload: SetupApplyPayload, actor: SetupActor | null, requester?: ApprovalRequester): Promise<SetupOutcome> {
    let summary = await this.deps.states.progress(ctx.installationId, s, { step: 'approval' });
    const who = requester ?? (actor ? this.deps.requester(actor) : null);
    if (!who) return this.failRun(ctx, summary, setupError('setup-blocked', 'nobody can be asked for this approval', { target: ctx.appId }), r);
    const appName = this.deps.appName(ctx.appId) ?? ctx.appId;
    const created = await this.deps.approvals.create({
      requester: who, action: SETUP_APPLY_ACTION, payloadHash: this.deps.approvals.hash(payload),
      display: setupApplyDisplay(payload, appName, setupRequesterLabel(who, (id) => this.deps.appName(id))),
      level: setupApplyNeedsFresh(payload) ? 'fresh' : 'session',
      class: setupApplyClass(payload),
      payload,
    });
    if (!created.ok) {
      const why = created.reason === 'too-many-pending' ? 'you already have an open approval request from here; answer it first'
        : created.reason === 'blocked' ? 'requests from here are blocked' : created.reason === 'rate-limited' ? 'too many requests; try again in a minute' : created.reason;
      return this.refused(this.withSummary(ctx, summary), setupError('setup-blocked', `the approval for ${ctx.appId} could not be requested: ${why}`, { state: summary.state, target: ctx.appId }), r);
    }
    const prev = summary.state;
    summary = await this.deps.states.transition(ctx.installationId, summary, 'awaiting-approval', { step: 'approval', approvalId: created.record.id });
    this.emit(ctx, prev, summary);
    if (!created.resumed) {
      void this.audit({
        by: actor ? (actor.kind === 'operator' ? { kind: 'operator' } : { kind: 'user', userId: actor.userId }) : { kind: 'system' },
        action: 'approval.requested', target: `approval:${created.record.id}`, outcome: 'ok',
        detail: { action: SETUP_APPLY_ACTION, app: ctx.appId, title: created.record.display.title },
      });
    }
    return { status: 'on-hold', state: this.viewOf(this.withSummary(ctx, summary), r), approvalId: created.record.id };
  }

  async resume(appId: string, actor: SetupActor): Promise<SetupOutcome> {
    const first = await this.ctx(appId);
    if (!first.declares) return { status: 'unchanged', state: this.viewOf(first) };
    return this.serial(first.installationId, async () => this.resumeLocked(await this.ctx(appId), actor));
  }

  private async resumeLocked(ctx: Ctx, actor: SetupActor | null): Promise<SetupOutcome> {
    const s = ctx.summary;
    switch (ctx.state) {
      case 'ready': return { status: 'unchanged', state: this.viewOf(ctx) };
      case 'awaiting-approval': return this.resumeApproval(ctx, s!, actor);
      case 'initializing': return this.resumeInit(ctx, s!);
      case 'blocked': {
        await this.recheckLocked(ctx);
        const after = await this.ctx(ctx.appId);
        return after.state === 'ready' ? { status: 'ready', state: this.viewOf(after) } : this.refused(after, after.summary?.error ?? setupError('setup-blocked', `${ctx.appId} stays blocked`, { state: 'blocked' }));
      }
      default:
        if (!actor) return { status: 'unchanged', state: this.viewOf(ctx) };
        return this.changeLocked(ctx, {}, actor, ctx.state === 'repair-required' ? 'repair' : 'setup');
    }
  }

  private async resumeApproval(ctx: Ctx, s: InstallationSetupSummary, actor: SetupActor | null): Promise<SetupOutcome> {
    const r = await this.resolveWith(ctx, ctx.desired.value, ctx.userDesired.value, NONE);
    const payload = setupApplyPayload(r, ctx.m);
    const rec: ApprovalRecord | null = s.approvalId ? await this.deps.approvals.get(s.approvalId) : null;
    const back = async (why: string): Promise<SetupOutcome> => {
      // The configuration (or its approval) is no longer what was asked: back to configuring, ask anew.
      if (rec && (rec.state === 'pending' || rec.state === 'approved')) await this.deps.approvals.cancel(rec.id, { kind: 'system', reason: why }).catch(() => undefined);
      const configuring = await this.deps.states.transition(ctx.installationId, s, 'configuring', { step: 'approval', approvalId: null });
      this.emit(ctx, s.state, configuring);
      const c = this.withSummary(ctx, configuring);
      if (this.hardBlockers(c, r).length) return this.failRun(c, configuring, refusalOf(this.hardBlockers(c, r)), r);
      if (!payload) return r.effective ? this.initialize(c, configuring, r, 'setup') : this.failRun(c, configuring, refusalOf(r.blocking), r);
      return this.requestApproval(c, configuring, r, payload, actor, actor ? undefined : rec?.requester);
    };
    if (!rec || rec.state === 'expired' || rec.state === 'cancelled') return back('expired');
    if (rec.state === 'pending') {
      // D102: the same request, never a duplicate; a changed configuration revalidates.
      if (!payload || this.deps.approvals.hash(payload) !== rec.payloadHash) return back('the setup changed since it was requested');
      return { status: 'on-hold', state: this.viewOf(ctx, r), approvalId: rec.id };
    }
    if (rec.state === 'denied') {
      const feedback = rec.feedback ? ` The owner says: "${rec.feedback.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 300)}"` : '';
      this.consumed.delete(ctx.installationId);
      return this.failRun(ctx, s, setupError('approval-denied', `the setup of ${ctx.appId} was not approved.${feedback}`, { approvalId: rec.id, target: ctx.appId }), r);
    }
    // approved (or consumed by a run the kernel restart interrupted): revalidate against the current digests.
    if (!payload || this.deps.approvals.hash(payload) !== rec.payloadHash) return back('the setup changed since it was approved');
    if (rec.state === 'approved') {
      const used = await this.deps.approvals.consume(rec.id, { requester: rec.requester, action: SETUP_APPLY_ACTION, payloadHash: rec.payloadHash });
      if (!used.ok) return back(`the approval could not be used (${used.reason})`);
    } else if (rec.state !== 'consumed') {
      return back('the approval is no longer usable');
    }
    try {
      await this.recordAuthorization(ctx, payload, rec);
    } catch (err) {
      const body = (err as { body?: SetupErrorBody }).body ?? setupError('setup-failed', `the approved privileges of ${ctx.appId} could not be recorded: ${(err as Error).message}`, { target: ctx.appId });
      return this.failRun(ctx, s, body, r);
    }
    this.consumed.set(ctx.installationId, nonGrantable(payload.adds, (p) => this.deps.grants.grantable(p)));
    const approved = await this.resolveCurrent(ctx, ctx.desired.value, ctx.userDesired.value);
    if (!approved.effective) return this.failRun(ctx, s, refusalOf(approved.blocking), approved);
    void this.audit({
      by: { kind: 'system' }, action: SETUP_AUDIT_ACTIONS.applied, target: `app:${ctx.appId}`, outcome: 'ok',
      detail: { installation: ctx.installationId, approval: rec.id, profile: payload.profile, configDigest: payload.configDigest, grantDigest: payload.grantDigest },
    });
    return this.initialize(ctx, s, approved, ctx.summary?.configDigest ? 'reconfigure' : 'setup', rec.id);
  }

  /** The approved privileges as ordinary grants (the existing paths); idempotent. Requests never grant before this. */
  private async recordAuthorization(ctx: Ctx, payload: SetupApplyPayload, rec: ApprovalRecord): Promise<void> {
    const d = rec.decidedBy;
    const by: ChangeAttribution = d?.kind === 'user' ? { kind: 'user', userId: d.userId } : { kind: 'operator' };
    const g = { appId: ctx.appId, installationId: ctx.installationId, by };
    for (const permission of payload.adds.permissions) if (this.deps.grants.grantable(permission)) await this.deps.grants.grantPermission({ ...g, permission });
    for (const key of payload.adds.context) await this.deps.grants.grantContext({ ...g, key });
    if (payload.adds.homePrivate || payload.adds.homePrivateSidecars.length) {
      if (!this.deps.home) throw fail('setup-failed', `the Private Home of ${ctx.appId} cannot be granted on this AuraOS (no home environment module)`, { target: ctx.appId });
      await this.deps.home.grantHomePrivate({
        appId: ctx.appId, installationId: ctx.installationId, userId: ctx.userId,
        homePrivate: payload.adds.homePrivate, sidecars: payload.adds.homePrivateSidecars, approvalId: rec.id, by,
      });
    }
  }

  // ── init and readiness ────────────────────────────────────────────────────

  private async initialize(ctx: Ctx, s: InstallationSetupSummary, r: Resolution, reason: SetupReason, approvalId?: string): Promise<SetupOutcome> {
    const prev = s.state;
    const summary = await this.deps.states.transition(ctx.installationId, s, 'initializing', { step: 'init', attempt: 1, ...(approvalId ? { approvalId } : { approvalId: null }) });
    this.emit(ctx, prev, summary);
    return this.startInit(this.withSummary(ctx, summary), summary, r, reason);
  }

  private async startInit(ctx: Ctx, summary: InstallationSetupSummary, r: Resolution, reason: SetupReason): Promise<SetupOutcome> {
    const run = this.runInit(ctx, summary, r, reason);
    if (!needsHooks(ctx.m)) return run;
    // The app's hooks may take minutes: the run continues; the CLI and the wizard follow the state.
    const tracked = run.then(() => undefined, () => undefined).finally(() => this.running.delete(ctx.installationId));
    this.running.set(ctx.installationId, tracked);
    return { status: 'initializing', state: this.viewOf(ctx, r) };
  }

  private async runInit(ctx: Ctx, summary: InstallationSetupSummary, r: Resolution, reason: SetupReason): Promise<SetupOutcome> {
    const effective = r.effective!;
    try {
      await runSetupHooks({
        appId: ctx.appId, manifest: ctx.m, userId: ctx.userId, starter: this.deps.maintenance(),
        hook: { configDigest: effective.configDigest, previousDigest: summary.configDigest, attempt: summary.attempt, reason },
      });
    } catch (err) {
      const body = err instanceof SetupHookError ? err.body
        : setupError('setup-failed', `the setup of ${ctx.appId} failed: ${(err as Error).message}`, { target: ctx.appId });
      return this.failInit(ctx, summary, body, r);
    }
    // Readiness passed: re-validate that nothing changed under the run, then `ready` by CAS with exactly these digests.
    const now = await this.ctx(ctx.appId);
    if (now.state !== 'initializing' || now.summary?.updatedAt !== summary.updatedAt) {
      return { status: 'refused', state: this.viewOf(now), error: setupError('setup-required', `the setup of ${ctx.appId} changed while it initialized`, { target: ctx.appId }) };
    }
    const again = await this.resolveCurrent(now, now.desired.value, now.userDesired.value);
    if (!again.effective || again.configDigest !== effective.configDigest || again.grantDigest !== effective.grantDigest) {
      return this.failInit(now, summary, again.effective ? setupError('setup-failed', `the configuration of ${ctx.appId} changed while it initialized; apply it again`, { target: ctx.appId }) : refusalOf(again.blocking), again);
    }
    const ready = await this.deps.states.markReady(ctx.installationId, summary, { configDigest: effective.configDigest, grantDigest: effective.grantDigest, profile: effective.profile });
    await this.keepApplied(now, effective);
    this.consumed.delete(ctx.installationId);
    this.effective.set(ctx.appId, again.effective);
    this.blocks.delete(ctx.appId);
    this.emit(ctx, summary.state, ready);
    return { status: 'ready', state: this.viewOf(this.withSummary(ctx, ready), again) };
  }

  private async failInit(ctx: Ctx, summary: InstallationSetupSummary, body: SetupErrorBody, r?: Resolution): Promise<SetupOutcome> {
    // Never `ready` with the new digest: the summary keeps the last ready digests (P2), the gate refuses the new ones.
    const cur = await this.deps.states.state(ctx.installationId, ctx.m);
    const s = cur.summary ?? summary;
    if (s.state !== 'initializing') return this.refused(this.withSummary(ctx, s), body, r);
    return this.failRun(ctx, s, body, r);
  }

  private async resumeInit(ctx: Ctx, s: InstallationSetupSummary): Promise<SetupOutcome> {
    if (this.running.has(ctx.installationId)) return { status: 'initializing', state: this.viewOf(ctx) };
    if (s.attempt >= MAX_INIT_ATTEMPTS) {
      return this.failRun(ctx, s, setupError('setup-failed', `the initialization of ${ctx.appId} was interrupted ${s.attempt} times; apply the setup again`, { target: ctx.appId }));
    }
    const r = await this.resolveCurrent(ctx, ctx.desired.value, ctx.userDesired.value);
    if (!r.effective) return this.failRun(ctx, s, refusalOf(r.blocking), r);
    const next = await this.deps.states.progress(ctx.installationId, s, { attempt: s.attempt + 1, step: 'init' });
    // A retried onSetup is the same call (idempotent, decision 8), with the next attempt number.
    return this.startInit(this.withSummary(ctx, next), next, r, ctx.summary?.configDigest ? 'reconfigure' : 'setup');
  }

  // ── blocked (D107 rule for every counted requirement, decision 10) ────────

  /** Re-check the authorization of a ready or blocked app: block it (stop, never reconfigure) or unblock it. */
  async recheck(appId: string): Promise<void> {
    const first = await this.ctx(appId).catch(() => null);
    if (!first?.declares || (first.state !== 'ready' && first.state !== 'blocked')) return;
    await this.serial(first.installationId, async () => this.recheckLocked(await this.ctx(appId)));
  }

  private async recheckLocked(ctx: Ctx): Promise<void> {
    if (!ctx.summary || (ctx.state !== 'ready' && ctx.state !== 'blocked')) return;
    const r = await this.resolveCurrent(ctx, ctx.desired.value, ctx.userDesired.value);
    const d = blockingDecision(ctx.summary, r);
    if (d.kind === 'block') {
      const s = await this.deps.states.transition(ctx.installationId, ctx.summary, 'blocked', { error: d.error });
      this.effective.delete(ctx.appId);
      this.blocks.set(ctx.appId, setupGateBlock(ctx.appId, 'setup-blocked', 'blocked', `${ctx.appId} is blocked: ${d.error.message}`, `re-authorize it (aura app setup ${ctx.appId} --resume) or change its setup`));
      this.emit(ctx, ctx.summary.state, s);
      await this.deps.stopWorkloads(ctx.appId).catch((err) => console.warn(`[setup] stopping ${ctx.appId} failed: ${(err as Error).message}`));
      if (d.privateHomeLost && this.deps.home) {
        await this.deps.home.privateHomeTeardown({ appId: ctx.appId, installationId: ctx.installationId, userId: ctx.userId, reason: d.error.message, code: d.error.error })
          .catch((err) => console.warn(`[setup] Private Home teardown of ${ctx.appId} failed: ${(err as Error).message}`));
      }
      void this.audit({
        by: { kind: 'system' }, action: SETUP_AUDIT_ACTIONS.blocked, target: `app:${ctx.appId}`, outcome: 'ok',
        detail: { installation: ctx.installationId, code: d.error.error, missing: d.error.missing ?? [] },
      });
    } else if (d.kind === 'unblock') {
      const s = await this.deps.states.markReady(ctx.installationId, ctx.summary, { configDigest: r.configDigest, grantDigest: r.grantDigest, profile: r.profile });
      this.effective.set(ctx.appId, r.effective!);
      this.blocks.delete(ctx.appId);
      this.emit(ctx, 'blocked', s);
    }
  }

  // ── secrets (D56) ─────────────────────────────────────────────────────────

  async secretHandles(appId: string, actor: SetupActor): Promise<SecretHandleOption[]> {
    const userId = actor.kind === 'operator' ? this.deps.ownerId : actor.userId;
    const out: SecretHandleOption[] = [];
    for (const c of await this.deps.vault.list(userId)) {
      if (c.name.startsWith(SETUP_SECRET_PREFIX) || !c.consumers.some((x) => x.appId === appId)) continue;
      const handle = await this.deps.vault.handleOf(userId, c.name, appId);
      if (handle) out.push({ handle, label: c.label ?? c.name });
    }
    return out;
  }

  async askSecret(appId: string, field: string, actor: SetupActor): Promise<{ approvalId: string }> {
    const ctx = await this.ctx(appId);
    const decl = ctx.declares ? fieldDecls(ctx.m)[field] : undefined;
    if (!decl?.secret) throw fail('config-invalid', `${field} is not a secret field of ${appId}`, { manifestField: 'setup.fields', target: appId });
    const ask = { name: askSecretName(appId, field), for: appId };
    const requester = this.deps.requester(actor);
    const created = await this.deps.approvals.create({
      requester, action: 'credential.store', payloadHash: this.deps.approvals.hash(ask),
      display: askSecretDisplay(ask, this.deps.appName(appId) ?? appId, setupRequesterLabel(requester, (id) => this.deps.appName(id)), decl.title),
      level: 'session', class: 'deferrable', payload: ask,
    });
    if (!created.ok) throw fail('setup-blocked', `the secret for ${field} could not be requested (${created.reason})`, { target: appId });
    if (!created.resumed) {
      void this.audit({
        by: actor.kind === 'operator' ? { kind: 'operator' } : { kind: 'user', userId: actor.userId }, action: 'approval.requested',
        target: `approval:${created.record.id}`, outcome: 'ok', detail: { action: 'credential.store', app: appId, field, name: ask.name },
      });
    }
    return { approvalId: created.record.id };
  }

  // ── the app's own view ────────────────────────────────────────────────────

  async selfConfig(instance: { appId: string; instanceId: string; userId?: string }): Promise<SetupConfigView> {
    const ctx = await this.ctx(instance.appId);
    if (!ctx.declares) throw fail('setup-required', `${instance.appId} declares no setup`, { target: instance.appId, state: 'ready' });
    const gate = await this.check(instance.appId, ctx.m, { installationId: ctx.installationId });
    if (!gate.ok) {
      const b = gate.block;
      throw new SetupEngineError(setupError(b.error as SetupErrorCode, b.message, { hint: b.hint, state: b.details.state, target: instance.appId }));
    }
    return setupConfigView(gate.effective!);
  }

  // ── the gate ──────────────────────────────────────────────────────────────

  async check(appId: string, manifest: SetupAppManifest, opts: { installationId: string; maintenance?: MaintenanceReason }): Promise<SetupGateDecision> {
    if (!declaresSetup(manifest)) return { ok: true, effective: null };
    const decide = (d: SetupGateDecision): SetupGateDecision => {
      if (d.ok) this.blocks.delete(appId); else { this.blocks.set(appId, d.block); this.effective.delete(appId); }
      return d;
    };
    let ctx: Ctx;
    try {
      ctx = await this.ctx(appId);
    } catch (err) {
      return decide({ ok: false, block: setupGateBlock(appId, 'setup-required', 'setup-required', `${appId}'s setup can't be read (${(err as Error).message}); not started`, `try again; aura app setup ${appId}`) });
    }
    if (ctx.installationId !== opts.installationId) {
      return decide({ ok: false, block: setupGateBlock(appId, 'setup-required', ctx.state, `${appId}'s installation changed; not started`, `aura app setup ${appId}`) });
    }
    const name = this.deps.appName(appId) ?? appId;
    if (opts.maintenance === 'setup' && ctx.state === 'initializing') {
      const r = await this.resolveCurrent(ctx, ctx.desired.value, ctx.userDesired.value);
      return r.effective ? { ok: true, effective: r.effective }
        : decide({ ok: false, block: setupGateBlock(appId, 'setup-required', 'initializing', `${name} can't be initialized: ${refusalOf(r.blocking).message}`, `aura app setup ${appId} --resume`) });
    }
    if (ctx.state !== 'ready') {
      const code = gateCodeOf(ctx.state);
      const why = ctx.summary?.error ? `: ${ctx.summary.error.message}` : '';
      const message = ctx.state === 'awaiting-approval' ? `${name}'s setup waits for your approval`
        : ctx.state === 'blocked' ? `${name} is blocked${why}`
          : ctx.state === 'repair-required' ? `${name}'s setup needs repair${why}`
            : ctx.state === 'setup-failed' ? `${name}'s setup failed${why}`
              : ctx.state === 'initializing' ? `${name} is initializing its setup`
                : `${name} is not set up yet: complete its setup first`;
      return decide({ ok: false, block: setupGateBlock(appId, code, ctx.state, message, `open it on the desktop, or run aura app setup ${appId}${ctx.state === 'setup-required' ? '' : ' --resume'}`) });
    }
    const r = await this.resolveCurrent(ctx, ctx.desired.value, ctx.userDesired.value);
    if (!r.effective) {
      const first = refusalOf(r.blocking);
      const authz = r.blocking.some((b) => b.error === 'requirement-unauthorized' || b.error === 'policy-refused' || b.error === 'requirement-unsupported');
      // A lost authorization, policy or feature: the state follows (blocked, workloads stopped).
      if (authz) void this.recheck(appId).catch(() => undefined);
      return decide({ ok: false, block: setupGateBlock(appId, authz ? 'setup-blocked' : 'repair-required', ctx.state,
        `${name} can't start with its setup: ${first.message}`, authz ? `re-authorize it (aura app setup ${appId} --resume) or change its setup` : `aura app setup ${appId} --resume`,
        first.manifestField ?? 'setup') });
    }
    if (r.configDigest !== ctx.summary?.configDigest || r.grantDigest !== ctx.summary?.grantDigest) {
      return decide({ ok: false, block: setupGateBlock(appId, 'repair-required', ctx.state,
        `${name}'s configuration changed since it was set up (an update, a changed manifest or setting); it starts only with the configuration that was validated`,
        `run its setup again: aura app setup ${appId} --resume`) });
    }
    this.effective.set(appId, r.effective);
    return decide({ ok: true, effective: r.effective });
  }

  manifestView<M extends SetupAppManifest>(appId: string, base: M, effective?: EffectiveConfig | null): M {
    if (!declaresSetup(base)) return base;
    const e = effective ?? this.effective.get(appId);
    return e ? effectiveManifestView(base, e) : base;
  }

  knownBlock(appId: string): OperationalBlock | null {
    return this.blocks.get(appId) ?? null;
  }

  async sidecarValues(appId: string): Promise<SidecarSetupValues | null> {
    const effective = this.effective.get(appId);
    if (!effective) return null;
    const userId = this.deps.ownerId;
    return sidecarSetupValues(effective, vaultSecretReader({
      vault: this.deps.vault, userId, appId, installationId: effective.installationId, secrets: effective.secrets,
      readGranted: (name) => this.deps.readGranted(appId, userId, name),
      audit: (e) => this.audit(e),
    }));
  }

  // ── P8: configuration and change management (change.ts) ──────────────────

  /** Every field's scope (resolution first, then every declared field). */
  private scopes(ctx: Ctx, r: Pick<Resolution, 'fields'>): FieldScopes {
    return fieldScopesOf(r, fieldDecls(ctx.m));
  }

  /** Decision 13: the configuration a run just made `ready` is kept for an explicit restore. Never fails the run. */
  private async keepApplied(ctx: Ctx, effective: EffectiveConfig): Promise<void> {
    const desired = ctx.desired.value;
    if (!desired) return;
    try {
      await this.deps.store.writeApplied(ctx.installationId, {
        v: 1, desired, userDesired: ctx.userDesired.value, userId: ctx.userId, profile: effective.profile,
        configDigest: effective.configDigest, grantDigest: effective.grantDigest, appliedAt: this.now().toISOString(),
      });
    } catch (err) {
      console.warn(`[setup] the applied configuration of ${ctx.appId} could not be kept: ${(err as Error).message}`);
    }
  }

  async changePlan(appId: string, proposal: SetupProposal): Promise<SetupChangePlan> {
    const ctx = await this.ctx(appId);
    if (!ctx.declares) {
      return {
        appId, from: null, to: { profile: null, configDigest: '', grantDigest: '' }, unchanged: true, valuesOnly: false,
        grantDiff: { added: [], removed: [], changed: false }, approval: null, compatibility: [], blocking: [], dataStaysBehind: [], note: DATA_STAYS_NOTE,
      };
    }
    const { desired, userDesired } = this.proposed(ctx, proposal, 'kernel');
    await this.bindAsked(ctx, desired, userDesired);
    if ((ctx.m.profiles ?? []).length && desired.profile === null) {
      const ports = await this.deps.resolverPorts({ appId, installationId: ctx.installationId, userId: ctx.userId, manifest: ctx.m, approved: NONE });
      const auto = autoSelectableProfile(ctx.m, ports, { appId, installationId: ctx.installationId, userId: ctx.userId, desired, userDesired });
      if (auto) desired.profile = auto;
    }
    const to = await this.resolveCurrent(ctx, desired, userDesired);
    const from = ctx.desired.value ? await this.resolveCurrent(ctx, ctx.desired.value, ctx.userDesired.value) : null;
    const s = ctx.summary;
    const approval = setupApplyPayload(to, ctx.m);
    const unchanged = ctx.state === 'ready' && to.effective !== null && to.configDigest === s?.configDigest && !approval;
    return {
      appId,
      from: from ? { profile: from.profile, configDigest: s?.configDigest ?? null, grantDigest: s?.grantDigest ?? null } : null,
      to: { profile: to.profile, configDigest: to.configDigest, grantDigest: to.grantDigest },
      unchanged,
      valuesOnly: !unchanged && !approval && !!s?.grantDigest && to.grantDigest === s.grantDigest,
      grantDiff: grantDiff(from ? grantBearingOf(from.requested) : null, grantBearingOf(to.requested)),
      approval,
      compatibility: compatibilityIssues({ to: to.requested, desired, userDesired, scopes: this.scopes(ctx, to) }),
      blocking: this.hardBlockers(ctx, to),
      dataStaysBehind: dataStaysBehind(this.deps.appName(appId) ?? appId, from?.requested ?? null, to.requested),
      note: DATA_STAYS_NOTE,
    };
  }

  async lastApplied(appId: string): Promise<LastAppliedView | null> {
    const ctx = await this.ctx(appId);
    if (!ctx.declares) return null;
    const snap = await this.deps.store.readApplied(ctx.installationId);
    if (!snap || snap.userId !== ctx.userId) return null;
    return {
      appId, profile: snap.profile, configDigest: snap.configDigest, appliedAt: snap.appliedAt,
      current: ctx.state === 'ready' && ctx.summary?.configDigest === snap.configDigest,
      values: { ...snap.desired.values, ...(snap.userDesired?.values ?? {}) },
      secretFields: [...new Set([...Object.keys(snap.desired.secrets), ...Object.keys(snap.userDesired?.secrets ?? {})])].sort(),
      notice: RESTORE_NOTICE,
    };
  }

  async restoreLast(appId: string, actor: SetupActor): Promise<SetupOutcome & { notice: string }> {
    const first = await this.ctx(appId);
    if (!first.declares) return { status: 'unchanged', state: this.viewOf(first), notice: RESTORE_NOTICE };
    const o = await this.serial(first.installationId, async () => {
      const ctx = await this.ctx(appId);
      const snap = await this.deps.store.readApplied(ctx.installationId);
      if (!snap || snap.userId !== ctx.userId) {
        return this.refused(ctx, setupError('setup-required', `${appId} has no applied configuration to restore`, { state: ctx.state, target: appId, hint: `set it up: aura app setup ${appId}` }));
      }
      if (ctx.state === 'ready' && ctx.summary?.configDigest === snap.configDigest) return { status: 'unchanged' as const, state: this.viewOf(ctx) };
      // The snapshot replaces the desired records; it is revalidated like any change (current grants, policy, features).
      const at = this.now().toISOString();
      const by = updatedByOf(actor);
      const version = ctx.m.setup?.version ?? 0;
      const stamp = (d: DesiredConfig): DesiredConfig => {
        const c = structuredClone(d);
        const m = ctx.m.setup && c.setupVersion !== version ? migrateDesired(c, ctx.m.setup, at).desired : c;
        return { ...m, updatedAt: at, updatedBy: by };
      };
      const desired = stamp(snap.desired);
      const userDesired = snap.userDesired ? stamp(snap.userDesired)
        : ctx.userDesired.value ? { ...emptyDesired(desired.setupVersion), updatedAt: at, updatedBy: by } : null;
      return this.changeLocked(ctx, {}, actor, 'reconfigure', { desired, userDesired });
    });
    return { ...o, notice: RESTORE_NOTICE };
  }

  async homePrivateGrants(appId: string, actor: SetupActor): Promise<HomePrivateGrantView[]> {
    if (!this.deps.manifest(appId)) throw fail('setup-blocked', `${appId} is not installed`, { target: appId });
    const held = (await this.deps.grants.homePrivateHeld?.({ appId, userId: actorUser(actor, this.deps.ownerId) })) ?? [];
    const prefix = `${HOME_PRIVATE_PERMISSION}.sidecar:`;
    return [...held].sort().map((permission) => (permission.startsWith(prefix) ? { permission, sidecar: permission.slice(prefix.length) } : { permission }));
  }

  async revokeHomePrivate(appId: string, actor: SetupActor, opts: { sidecar?: string } = {}): Promise<{ revoked: string[]; state: SetupStateView }> {
    if (!this.deps.manifest(appId)) throw fail('setup-blocked', `${appId} is not installed`, { target: appId });
    const revoke = this.deps.grants.revokeHomePrivate;
    if (!revoke) throw fail('setup-blocked', 'revoking a Private Home grant is not available on this AuraOS', { target: appId });
    if (opts.sidecar !== undefined && !SIDECAR_RE.test(opts.sidecar)) throw fail('config-invalid', 'invalid sidecar name', { target: appId });
    // Only the acting user's own home: the grant's scope is their user id (the host operator acts for the owner, D50).
    const userId = actorUser(actor, this.deps.ownerId);
    const held = (await this.deps.grants.homePrivateHeld?.({ appId, userId })) ?? [];
    const perms = opts.sidecar !== undefined ? [homePrivateSidecarPermission(opts.sidecar)]
      : [HOME_PRIVATE_PERMISSION, ...held.filter((p) => p !== HOME_PRIVATE_PERMISSION).sort()];
    const revoked: string[] = [];
    for (const permission of perms) if (await revoke({ appId, userId, permission })) revoked.push(permission);
    if (revoked.length) {
      void this.audit({
        by: attributionOf(actor) as Parameters<SetupEngineDeps['audit']>[0]['by'], action: HOME_PRIVATE_AUDIT.revoked, target: `app:${appId}`, outcome: 'ok',
        detail: { user: userId, permissions: revoked, cause: 'user' },
      });
      // D107: a revoked Private Home blocks the app (workloads stopped, sessions ended), never App Home.
      await this.recheck(appId);
    }
    return { revoked, state: await this.state(appId) };
  }

  async onManifestChanged(appId: string): Promise<ManifestChangeOutcome> {
    const first = await this.ctx(appId).catch(() => null);
    if (!first?.declares) return { status: 'unchanged', state: first ? this.viewOf(first) : null };
    return this.serial(first.installationId, async () => this.manifestChangedLocked(await this.ctx(appId)));
  }

  /** `ready`/`blocked` → `repair-required` (stopped; the gate refuses until a repair). */
  private async toRepair(ctx: Ctx, s: InstallationSetupSummary, error: SetupErrorBody, renamed: Array<{ from: string; to: string }> = []): Promise<ManifestChangeOutcome> {
    const body: SetupErrorBody = { ...error, state: 'repair-required' };
    const next = await this.deps.states.transition(ctx.installationId, s, 'repair-required', { error: body });
    this.effective.delete(ctx.appId);
    const name = this.deps.appName(ctx.appId) ?? ctx.appId;
    this.blocks.set(ctx.appId, setupGateBlock(ctx.appId, 'repair-required', 'repair-required', `${name}'s setup needs repair: ${body.message}`, `aura app setup ${ctx.appId} --resume`));
    this.emit(ctx, s.state, next);
    await this.deps.stopWorkloads(ctx.appId).catch((err) => console.warn(`[setup] stopping ${ctx.appId} failed: ${(err as Error).message}`));
    return { status: 'repair-required', state: this.viewOf(this.withSummary(ctx, next)), error: body, ...(renamed.length ? { renamed } : {}) };
  }

  private async manifestChangedLocked(ctx: Ctx): Promise<ManifestChangeOutcome> {
    // Only a configuration that ran (or ran and was blocked) is re-resolved; any other state is finished by its setup run.
    if (!ctx.summary || (ctx.state !== 'ready' && ctx.state !== 'blocked')) return { status: 'not-ready', state: this.viewOf(ctx) };
    const s = ctx.summary;
    const appId = ctx.appId;
    const version = ctx.m.setup?.version ?? 0;
    let desired = ctx.desired.value;
    let user = ctx.userDesired.value;
    let renamed: Array<{ from: string; to: string }> = [];
    if (ctx.m.setup && desired && desired.setupVersion !== version) {
      const from = desired.setupVersion;
      if (from > version) {
        return this.toRepair(ctx, s, setupError('repair-required', `the stored values of ${appId} were written for setup version ${from}, newer than its version ${version}: set it up again`, { manifestField: 'setup.version' }));
      }
      if (needsHooks(ctx.m)) {
        // `onMigrateConfig` runs in a maintenance start (reserved reason `migrate`, app-manager/maintenance.ts) that this
        // release can't run: fail closed, nothing written, never `ready` (the repair renames declaratively with the owner).
        return this.toRepair(ctx, s, setupError('repair-required', `${appId} changed its setup version (${from} → ${version}); its migration hook can't run on this AuraOS, so its values were not migrated`, {
          manifestField: 'setup.version', hint: `repair it: aura app setup ${appId} --resume (${NO_MAINTENANCE_HINT})`,
        }));
      }
      const at = this.now().toISOString();
      const mig = migrateDesired(desired, ctx.m.setup, at);
      const umig = user ? migrateDesired(user, ctx.m.setup, at) : null;
      renamed = [...mig.renamed, ...(umig?.renamed ?? [])];
      const w = await this.deps.store.update({ installationId: ctx.installationId }, () => mig.desired);
      if (!w.ok) throw fail('setup-blocked', `the setup of ${appId} changed meanwhile; try again`, { target: appId });
      if (umig) {
        const u = await this.deps.store.update({ installationId: ctx.installationId, userId: ctx.userId }, () => ({ ...umig.desired, profile: null, overrides: {} }));
        if (!u.ok) throw fail('setup-blocked', `the setup of ${appId} changed meanwhile; try again`, { target: appId });
      }
      desired = mig.desired;
      user = umig?.desired ?? null;
    }
    const cur: Ctx = { ...ctx, desired: { ...ctx.desired, value: desired }, userDesired: { ...ctx.userDesired, value: user } };
    const r = await this.resolveCurrent(cur, desired, user);
    const migrated = renamed.length ? { renamed } : {};
    if (r.effective && r.configDigest === s.configDigest && r.grantDigest === s.grantDigest) {
      if (ctx.state === 'blocked') await this.recheckLocked(cur);
      return { status: 'unchanged', state: this.viewOf(await this.ctx(appId), r), ...migrated };
    }
    if (!r.effective) {
      const dropped = r.blocking.find((b) => b.error === 'unknown-profile');
      if (dropped) {
        const suggest = (await this.profiles(appId)).filter((p) => p.available).map((p) => p.id);
        return this.toRepair(cur, s, setupError('profile-required', `the update of ${appId} dropped its operating profile ${desired?.profile ?? ''}: select a profile`, {
          manifestField: 'profiles', ...(suggest.length ? { suggest } : {}),
        }), renamed);
      }
      const grantable = (p: string) => this.deps.grants.grantable(p);
      const config = r.blocking.filter((b) => !AUTHZ_CODES.has(b.error));
      if (config.length) return this.toRepair(cur, s, refusalOf(config), renamed);
      if (r.blocking.every((b) => approvable(b, grantable))) {
        // New privileges: never held before the owner's `app.setup.apply`; the repair asks for it.
        return this.toRepair(cur, s, setupError('setup-blocked', `the update of ${appId} asks for more privileges (${missingAuthorizations(r).join(', ')}): approve them`, {
          missing: missingAuthorizations(r), hint: `aura app setup ${appId} --resume`,
        }), renamed);
      }
      // A lost authorization, policy or feature: blocked (D107 rule), never another configuration.
      await this.recheckLocked(cur);
      const after = await this.ctx(appId);
      return { status: after.state === 'blocked' ? 'blocked' : 'not-ready', state: this.viewOf(after, r), ...migrated };
    }
    // Valid with the same privileges or fewer: re-validate the new digests in a run (init again; `ready` only by markReady).
    if (needsHooks(ctx.m) && !this.deps.maintenance()) {
      return this.toRepair(cur, s, setupError('repair-required', `${appId}'s configuration changed with its update; its setup hooks can't run on this AuraOS`, { hint: NO_MAINTENANCE_HINT }), renamed);
    }
    const configuring = await this.deps.states.transition(ctx.installationId, s, 'configuring', { step: 'values', attempt: 0, approvalId: null });
    this.emit(cur, s.state, configuring);
    this.effective.delete(appId);
    const o = await this.initialize(this.withSummary(cur, configuring), configuring, r, 'migrate');
    return {
      status: o.status === 'ready' ? 'migrated' : 'not-ready', state: o.state, ...migrated, ...(o.error ? { error: o.error } : {}),
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.watcher) return;
    this.watcher = new BlockingWatcher({
      recheck: (appId) => this.recheck(appId), appIds: () => this.declaringApps(), manifestChanged: (appId) => this.onManifestChanged(appId),
    });
    this.watcher.start();
    void this.recover().catch((err) => console.warn(`[setup] recovery failed: ${(err as Error).message}`));
  }

  stop(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  private declaringApps(): string[] {
    return this.deps.appIds().filter((id) => { const m = this.deps.manifest(id); return !!m && declaresSetup(m); });
  }

  /** Kernel restart: an `initializing` run without its live maintenance start is retried (idempotent) or failed after MAX_INIT_ATTEMPTS. */
  async recover(): Promise<void> {
    for (const appId of this.declaringApps()) {
      try {
        const ctx = await this.ctx(appId);
        if (ctx.state !== 'initializing') continue;
        await this.serial(ctx.installationId, async () => this.resumeLocked(await this.ctx(appId), null));
      } catch (err) {
        console.warn(`[setup] recovery of ${appId} failed: ${(err as Error).message}`);
      }
    }
  }

  /** Wait for the init runs in flight (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }
}

