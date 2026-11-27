/**
 * The setup module's contracts (D108: application operating profiles and the
 * unified setup framework). Plain data only, so the engine, the API, the CLI,
 * the wizard and the SDK share one shape (AGENTS.md "Replaceability").
 *
 *   desired     what the owner selected: profile, values, overrides (stored,
 *               `app:config:<installationId>[:u:<userId>]`, MAC-sealed, CAS)
 *   requested   base manifest ⊕ profile overlay ⊕ desired (one pure merge)
 *   authorized  every privileged request has a counting grant or approval
 *   feasible    every required requirement is met by the resolved runtime
 *   effective   requested, when policy-allowed ∧ authorized ∧ feasible ∧
 *               the required fields are valid; otherwise NONE, with D105
 *               reasons. Never a silent fallback (§2.4, §5.2; D107: a
 *               revoked `home.private` is `blocked`, never App Home).
 *
 * Operational state is per installation (and per user for user-scope values)
 * and exists only for apps that declare `setup` or `profiles`; every other
 * app is `ready` by derivation and has no record.
 *
 * Contract leaf (dep-check `contract-leaf`): no runtime import of another
 * core module; type-only imports are free.
 */
import type { ConfigField, ConfigValue, ConfigValues } from '../config/schema.js';
import type {
  EnvValue, HomeEnvironment, HomeEnvironmentsDeclaration, InstanceScope, ProfileDeclaration, ServiceOverlay,
  SetupDeclaration, SetupRequirement, SidecarHome,
} from '../types/setupManifest.js';

// ── operational state ───────────────────────────────────────────────────────

/**
 * The per-installation lifecycle of a configured app (§3.1). Separate from
 * the instance lifecycle (types/lifecycle.ts), which it gates.
 */
export const OPERATIONAL_STATES = [
  'setup-required', 'configuring', 'awaiting-approval', 'initializing', 'ready', 'setup-failed', 'blocked', 'repair-required',
] as const;
export type OperationalState = (typeof OPERATIONAL_STATES)[number];

/**
 * The legal transitions (the engine's state machine, P2/P3). `ready` is only
 * ever entered by the engine after init and readiness succeed, in one
 * compare-and-set with the `configDigest` it validated.
 */
export const OPERATIONAL_TRANSITIONS: Readonly<Record<OperationalState, readonly OperationalState[]>> = Object.freeze({
  'setup-required': ['configuring', 'blocked'],
  configuring: ['awaiting-approval', 'initializing', 'setup-failed', 'setup-required', 'blocked'],
  'awaiting-approval': ['initializing', 'setup-failed', 'configuring', 'blocked'],
  initializing: ['ready', 'setup-failed', 'blocked'],
  ready: ['configuring', 'blocked', 'repair-required', 'setup-required'],
  'setup-failed': ['configuring', 'setup-required', 'blocked'],
  blocked: ['ready', 'configuring', 'setup-required', 'repair-required'],
  'repair-required': ['configuring', 'blocked', 'setup-required'],
});

/** Where a setup run is (resumption point; written before the step acts, §3.3). */
export const SETUP_STEPS = ['profile', 'values', 'requirements', 'review', 'approval', 'init', 'readiness', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Why the engine runs the app's hooks (`onSetup` input). */
export type SetupReason = 'setup' | 'reconfigure' | 'repair' | 'migrate';

/**
 * The small summary on the installation record (`apphost:install:<id>`,
 * field `setup`), next to `runAs`/`execution`/`runAsMigration`, written CAS.
 * The full desired configuration lives in the config record.
 */
export interface InstallationSetupSummary {
  state: OperationalState;
  profile: string | null;
  /** The digest `ready` was validated with; the gate compares the freshly resolved one. */
  configDigest: string | null;
  grantDigest: string | null;
  step: SetupStep | null;
  /** Init attempts of the current run (kernel restart during `initializing` retries, then `setup-failed`). */
  attempt: number;
  /** The approval of the current run while `awaiting-approval` (D102). */
  approvalId?: string;
  updatedAt: string;
  /** The last refusal or failure, as a D105 body (no secret, no value). */
  error?: SetupErrorBody;
}

// ── desired configuration (the store shared with D107-a, decision 5) ───────

/** The record key of an installation's desired configuration; `userId` for user-scope values. */
export function configRecordKey(installationId: string, userId?: string): string {
  return userId ? `app:config:${installationId}:u:${userId}` : `app:config:${installationId}`;
}

/** Operator choices on the D107 axes and the runtime; the profile's values otherwise. */
export interface DesiredOverrides {
  homeEnvironment?: HomeEnvironment;
  instanceScope?: InstanceScope;
  environmentScope?: 'global' | 'user';
  sandbox?: string;
}

/**
 * One desired-configuration record (installation scope, or one user's
 * values). Secrets are D56 vault handles by field name, never values.
 */
export interface DesiredConfig {
  v: 1;
  /** `setup.version` the values were written for (renames/`onMigrateConfig` on a newer one). */
  setupVersion: number;
  /** Selected operating profile; null for an app without profiles. Installation record only. */
  profile: string | null;
  values: ConfigValues;
  /** field → vault handle. */
  secrets: Record<string, string>;
  overrides: DesiredOverrides;
  updatedAt: string;
  /** `user:<id>`, `operator` or `kernel` (generated secrets, migrations). */
  updatedBy: string;
}

// ── resolution ──────────────────────────────────────────────────────────────

/** The service template after the overlay (only the overlay keys can differ from the base). */
export interface EffectiveService {
  name: string;
  env: Record<string, EnvValue>;
  home: SidecarHome;
  network?: 'instance' | 'shared';
  limits?: { memory?: string; cpus?: number };
  readiness?: { path?: string; timeoutMs?: number };
}

/**
 * The privilege-bearing part of a configuration: what approvals bind
 * (`grantDigest`). A change here needs a new `app.setup.apply`; a change to
 * plain values does not (decision 9).
 */
export interface GrantBearing {
  permissions: string[];
  tools: string[];
  context: string[];
  homeEnvironment: HomeEnvironment;
  /** Sidecars that get the owner environment (each needs `home.private.sidecar:<name>` when private). */
  ownerEnvironmentSidecars: string[];
  instanceScope: InstanceScope;
  environmentScope: 'global' | 'user';
  sandbox: string | null;
  /** service name → network. */
  networks: Record<string, 'instance' | 'shared'>;
  resources: { memory?: string; cpus?: number } | null;
}

/** The effective configuration an instance starts with (the gate passes only on its `configDigest`). */
export interface EffectiveConfig extends GrantBearing {
  appId: string;
  installationId: string;
  profile: string | null;
  setupVersion: number;
  /** The active fields' plain values (after `when`). */
  values: ConfigValues;
  /** Active secret fields → handle. Names count in the digest; handle identities do not. */
  secrets: Record<string, string>;
  services: EffectiveService[];
  degraded: DegradedRequirement[];
  configDigest: string;
  grantDigest: string;
}

/** An unmet optional requirement: reported, never satisfied by weakening (§2.4 rule 7). */
export interface DegradedRequirement {
  requirement: SetupRequirement;
  reason: string;
}

/** One requirement's evaluation. */
export interface RequirementResult {
  requirement: SetupRequirement;
  /** `inactive`: its `when` is false. */
  status: 'met' | 'unmet' | 'inactive';
  /** For `unmet`: the D105 reason. */
  error?: SetupErrorBody;
}

/** The resolver's whole answer (P1 `resolveEffective()`; pure, deterministic). */
export interface Resolution {
  appId: string;
  installationId: string;
  profile: string | null;
  /** The fields that exist for this desired state (base ∪ profile, tightened, `when` applied). */
  fields: Record<string, ConfigField>;
  requested: Omit<EffectiveConfig, 'configDigest' | 'grantDigest' | 'degraded'>;
  policy: { ok: boolean; refusals: SetupErrorBody[] };
  authorized: { ok: boolean; missing: SetupErrorBody[] };
  feasible: { ok: boolean; requirements: RequirementResult[] };
  values: { ok: boolean; fieldErrors: Record<string, string>; missing: string[] };
  /** null whenever anything above is not ok: never a fallback. */
  effective: EffectiveConfig | null;
  /** Every reason the effective configuration is NONE (D105 bodies). */
  blocking: SetupErrorBody[];
  degraded: DegradedRequirement[];
  /** Digests of `requested` (also when blocked: approvals bind them). */
  configDigest: string;
  grantDigest: string;
}

/**
 * What the resolver asks the rest of the kernel (P1 ports; the engine wires
 * them in the composition root). All synchronous reads of already-loaded
 * state, so `resolveEffective()` stays pure and testable.
 */
export interface ResolverPorts {
  /** The ARI features of a runtime id (`support` per feature id); null when the runtime is unknown or disabled. */
  runtimeFeatures(runtimeId: string): Readonly<Record<string, 'supported' | 'conditional' | 'unsupported'>> | null;
  /** The default runtime id (Runtime Settings) for an app that names none. */
  defaultRuntime(): string;
  /** Does a counting grant authorize this request for the installation (and user)? */
  isAuthorized(request: AuthorizationRequest): boolean;
  /** Is a capability (tool) installed and granted to the app? */
  capability(name: string): { installed: boolean; granted: boolean };
  /** A D64 policy value (`app-private-home`, `app-root-execution`, …). */
  policy(optionId: string): string | boolean | null;
}

/** A privileged request the resolver asks `isAuthorized` about. */
export type AuthorizationRequest =
  | { kind: 'permission'; permission: string }
  | { kind: 'tool'; tool: string }
  | { kind: 'context'; key: string }
  | { kind: 'grant'; grant: string; userId?: string }
  | { kind: 'home-private'; userId: string }
  | { kind: 'home-private-sidecar'; sidecar: string; userId: string };

/** The resolver's input. */
export interface SetupResolveInput {
  appId: string;
  installationId: string;
  /** The user whose user-scope values and grants count (alpha: the owner). */
  userId: string;
  /** The parsed base manifest (structural: the fields the resolver reads). */
  manifest: SetupManifestView;
  desired: DesiredConfig | null;
  userDesired: DesiredConfig | null;
}

/** What of a parsed manifest the setup module reads (structural; `AppManifest` satisfies it). */
export interface SetupManifestView {
  id: string;
  permissions: string[];
  tools: string[];
  context: string[];
  sandbox?: string;
  environmentScope: 'global' | 'user';
  setup?: SetupDeclaration;
  profiles?: ProfileDeclaration[];
  homeEnvironments?: HomeEnvironmentsDeclaration;
  services: Array<{
    name: string; env: Record<string, EnvValue>; home?: SidecarHome; inheritHome?: boolean;
    network?: 'instance' | 'shared'; limits?: { memory?: string; cpus?: number }; readiness?: { path?: string; timeoutMs?: number };
  }>;
}

/** Does this manifest take part in D108 at all? Apps without both blocks never get a record. */
export function declaresSetup(manifest: { setup?: unknown; profiles?: unknown }): boolean {
  return (manifest.setup !== undefined && manifest.setup !== null) || (Array.isArray(manifest.profiles) && manifest.profiles.length > 0);
}

export type { ServiceOverlay };

// ── errors (D105) ───────────────────────────────────────────────────────────

/**
 * The D105 codes of the setup module (§5.10). `needs-setup` is the new
 * category: the owner (or the CLI, an agent) completes or repairs the setup;
 * nothing else makes the app startable.
 */
export const SETUP_ERROR_CODES = [
  'setup-required', 'setup-blocked', 'setup-failed', 'repair-required',
  'config-invalid', 'requirement-unsupported', 'requirement-unauthorized', 'policy-refused',
  'profile-required', 'profile-unavailable', 'unknown-profile', 'hook-failed', 'approval-denied',
] as const;
export type SetupErrorCode = (typeof SETUP_ERROR_CODES)[number];

/** The D105 category a setup refusal carries; `needs-setup` joins the `ErrorCategory` union (errors/contracts.ts) at the R1 rebase. */
export type SetupErrorCategory = 'needs-setup' | 'unsupported-feature' | 'needs-approval' | 'not-grantable' | 'invalid-request' | 'missing-permission';

export const CATEGORY_OF_SETUP_CODE: Readonly<Record<SetupErrorCode, SetupErrorCategory>> = Object.freeze({
  'setup-required': 'needs-setup',
  'setup-blocked': 'needs-setup',
  'setup-failed': 'needs-setup',
  'repair-required': 'needs-setup',
  'config-invalid': 'invalid-request',
  'requirement-unsupported': 'unsupported-feature',
  'requirement-unauthorized': 'missing-permission',
  'policy-refused': 'not-grantable',
  'profile-required': 'needs-setup',
  'profile-unavailable': 'unsupported-feature',
  'unknown-profile': 'invalid-request',
  'hook-failed': 'needs-setup',
  'approval-denied': 'needs-approval',
});

/**
 * A setup refusal as a D105 body (the `AuraErrorBody` shape of
 * errors/contracts.ts, narrowed). Reader-aware like Pass A: never another
 * user's values, never a secret, never the owner's grants to an app.
 */
export interface SetupErrorBody {
  error: SetupErrorCode;
  category: SetupErrorCategory;
  message: string;
  hint?: string;
  /** `setup.fields.<f>`, `profiles[<id>].overlay.<key>`, `setup.requirements[<i>]`. */
  manifestField?: string;
  /** Features, grants or capabilities that are missing. */
  missing?: string[];
  /** Other feasible profiles: named, never picked (decision 3). */
  suggest?: string[];
  /** A D64 option id. */
  policy?: string;
  approvalId?: string;
  /** The operational state the refusal reports. */
  state?: OperationalState;
  target?: string;
  /** field → why (`config-invalid`), never the value. */
  fieldErrors?: Record<string, string>;
}

export function setupError(error: SetupErrorCode, message: string, extra: Omit<SetupErrorBody, 'error' | 'category' | 'message'> = {}): SetupErrorBody {
  return { error, category: CATEGORY_OF_SETUP_CODE[error], message, ...extra };
}

// ── approval (D102 action `app.setup.apply`, decision 9) ────────────────────

export const SETUP_APPLY_ACTION = 'app.setup.apply' as const;

/**
 * What the owner approves, built by the engine from the resolution (never
 * from the requester's words). Bound to both digests: a changed
 * privilege-bearing part needs a new approval; a stale one is refused at
 * consumption (D102 revalidation).
 */
export interface SetupApplyPayload {
  appId: string;
  installationId: string;
  profile: string | null;
  configDigest: string;
  grantDigest: string;
  /** The privileges this setup adds over what the installation already holds. */
  adds: {
    permissions: string[];
    tools: string[];
    context: string[];
    homePrivate: boolean;
    homePrivateSidecars: string[];
    instanceScope?: InstanceScope;
    networks?: Record<string, 'instance' | 'shared'>;
    resources?: { memory?: string; cpus?: number };
    runAsRoot?: boolean;
  };
}

/**
 * The class of an `app.setup.apply` request: the strictest contained part.
 * Forced (and the handler asks `fresh`) with the Private Home, a home
 * sidecar or root; deferrable otherwise. Derived from the server-built
 * payload, never chosen by the requester.
 */
export function setupApplyClass(payload: unknown): 'forced' | 'deferrable' {
  const adds = (payload && typeof payload === 'object' ? (payload as { adds?: Partial<SetupApplyPayload['adds']> }).adds : undefined) ?? {};
  const forced = adds.homePrivate === true || (Array.isArray(adds.homePrivateSidecars) && adds.homePrivateSidecars.length > 0) || adds.runAsRoot === true;
  return forced ? 'forced' : 'deferrable';
}

/** Does this payload need the password (`fresh`)? Same parts as `forced`. */
export const setupApplyNeedsFresh = (payload: unknown): boolean => setupApplyClass(payload) === 'forced';

// ── D107-a owner subset (P9) ────────────────────────────────────────────────

/** The grant that authorizes `homeEnvironment: private` for (installation, user). */
export const HOME_PRIVATE_PERMISSION = 'home.private';
/** The per-sidecar grant for a `home: owner-environment` sidecar of a private instance. */
export const homePrivateSidecarPermission = (sidecar: string): string => `${HOME_PRIVATE_PERMISSION}.sidecar:${sidecar}`;
/** D64: may apps run with a user's Private Home at all (`off | grant`, default `grant`). */
export const APP_PRIVATE_HOME_OPTION = 'app-private-home';
export type AppPrivateHomePolicy = 'off' | 'grant';

// ── API and SDK views (plain data) ──────────────────────────────────────────

/** One profile as the API, CLI and wizard list it. */
export interface ProfileOption {
  id: string;
  title: string;
  description?: string;
  recommended: boolean;
  /** Feasible and allowed here; an unavailable one carries its reasons and is never picked. */
  available: boolean;
  reasons: SetupErrorBody[];
}

/** A field as presented (no value for secrets: `hasSecret` only). */
export interface FieldView {
  name: string;
  field: ConfigField;
  value?: ConfigValue;
  hasSecret?: boolean;
  error?: string;
}

/** One step of the plan the wizard and the CLI walk (dynamic: unnecessary steps are skipped). */
export interface SetupPlanStep {
  step: SetupStep;
  title: string;
  status: 'todo' | 'done' | 'skipped' | 'blocked';
}

/** `GET /api/apps/<id>/setup`: where the app stands. */
export interface SetupStateView {
  appId: string;
  installationId: string;
  /** `ready` and no record for an app without setup/profiles. */
  declares: boolean;
  state: OperationalState;
  profile: string | null;
  step: SetupStep | null;
  configDigest: string | null;
  approvalId?: string;
  error?: SetupErrorBody;
  degraded: DegradedRequirement[];
}

/** `GET|POST /api/apps/<id>/setup/plan`: the steps for a (proposed) desired state. */
export interface SetupPlan {
  appId: string;
  state: SetupStateView;
  steps: SetupPlanStep[];
  profiles: ProfileOption[];
  fields: FieldView[];
  requirements: RequirementResult[];
  /** What `apply` would ask the owner to approve, or null when nothing privileged is added. */
  approval: SetupApplyPayload | null;
  blocking: SetupErrorBody[];
  degraded: DegradedRequirement[];
  configDigest: string;
  grantDigest: string;
}

/**
 * `GET /api/setup/self` (instance token) → SDK `osClient.setup.config()`:
 * the app's own effective values; secrets as handles (read with
 * `credentials.get`). Never another installation's or user's values.
 */
export interface SetupConfigView {
  appId: string;
  installationId: string;
  profile: string | null;
  values: ConfigValues;
  secrets: Record<string, string>;
  degraded: DegradedRequirement[];
  configDigest: string;
}

// ── app hooks (maintenance start, reason `setup`; decision 8) ───────────────

/** The hook paths under the app's lifecycle base (`lifecyclePath()`). */
export const SETUP_HOOKS = { setup: 'setup', validate: 'validate', migrateConfig: 'migrate-config' } as const;

/** `onSetup` input. Must be idempotent: the kernel may call it again with the same digest. */
export interface SetupHookInput {
  configDigest: string;
  previousDigest: string | null;
  attempt: number;
  reason: SetupReason;
}

/** `onValidate` answer: field checks and connection tests; it cannot change state. */
export interface ValidateResult {
  ok: boolean;
  fieldErrors?: Record<string, string>;
  checks?: Array<{ id: string; ok: boolean; message?: string }>;
}

/** `onMigrateConfig` input and answer (after declarative renames). */
export interface MigrateConfigInput { fromVersion: number; toVersion: number; values: ConfigValues }
export interface MigrateConfigResult { values: ConfigValues }

// ── audit and events ────────────────────────────────────────────────────────

export const SETUP_AUDIT_ACTIONS = {
  stateChanged: 'app.setup.state',
  applied: 'app.setup.applied',
  blocked: 'app.setup.blocked',
  recordTampered: 'app.setup.record-tampered',
} as const;

/** The kernel event of an operational-state change (`app:*`: emitted by the kernel only). */
export const SETUP_STATE_EVENT = 'app:setup-state' as const;
export interface SetupStateEvent {
  appId: string;
  installationId: string;
  state: OperationalState;
  previous: OperationalState | null;
  step: SetupStep | null;
}
