/**
 * Configuration and change management (D108 P8, review §3.5, §5.5; owner
 * decision 13). Pure functions over the resolver's plain data, plus the
 * contract of the change operations the engine (service.ts) implements:
 *
 *   grantDiff          what a change adds to and removes from the
 *                      privilege-bearing part (`GrantBearing`, the part the
 *                      `grantDigest` binds). Display only: whether the owner
 *                      is asked is the engine's `setupApplyPayload` (only
 *                      added privileges ask; a plain value change never does)
 *   compatibilityIssues the §5.5 rules: per-user values and user-scope
 *                      secrets never become installation values; a switch to
 *                      `shared` refuses while a user-scope secret is bound
 *   dataStaysBehind    what stays where it is when the home environment, the
 *                      environment scope or the instance identity changes
 *                      (D65 §14, D107 §3.4): never copied, moved or chowned
 *                      automatically; copying is a separate explicit action
 *   migrateDesired     a `setup.version` change: the declarative renames
 *                      (`setup.renames`, in `since` order) within ONE record;
 *                      `onMigrateConfig` follows in the maintenance start
 *                      (service.ts), fail closed (`repair-required`)
 *   AppliedSnapshot    decision 13: the last successfully applied
 *                      configuration, kept for explicit recovery
 *                      (`restoreLast`), which revalidates like any change
 *
 * Secrets: handles only (never a value); nothing here logs.
 */
import type { ConfigValues } from '../config/schema.js';
import type { SetupRename } from '../types/setupManifest.js';
import {
  setupError, type DesiredConfig, type GrantBearing, type Resolution, type SetupActor, type SetupApplyPayload, type SetupErrorBody,
  type SetupOutcome, type SetupProposal, type SetupStateView,
} from './contracts.js';

// ── the privilege diff ──────────────────────────────────────────────────────

/** One privilege-bearing item as a stable key (`permission:<p>`, `home:private`, `network:<svc>=<net>`, …). */
export function grantItems(g: GrantBearing): string[] {
  const out = [
    ...g.permissions.map((p) => `permission:${p}`),
    ...g.tools.map((t) => `tool:${t}`),
    ...g.context.map((c) => `context:${c}`),
    `home:${g.homeEnvironment}`,
    ...g.ownerEnvironmentSidecars.map((s) => `home-sidecar:${s}`),
    `instance-scope:${g.instanceScope}`,
    `environment-scope:${g.environmentScope}`,
    ...(g.sandbox ? [`sandbox:${g.sandbox}`] : []),
    ...Object.entries(g.networks).map(([s, n]) => `network:${s}=${n}`),
    ...(g.resources?.memory !== undefined ? [`resources:memory=${g.resources.memory}`] : []),
    ...(g.resources?.cpus !== undefined ? [`resources:cpus=${g.resources.cpus}`] : []),
  ];
  return [...new Set(out)].sort();
}

export interface GrantDiff {
  /** Items the new configuration has and the current one has not. */
  added: string[];
  removed: string[];
  /** True when the privilege-bearing part differs at all (`grantDigest` changes). */
  changed: boolean;
}

/** The privilege diff from the current configuration (null: none yet) to a proposed one. */
export function grantDiff(from: GrantBearing | null, to: GrantBearing): GrantDiff {
  const a = new Set(from ? grantItems(from) : []);
  const b = new Set(grantItems(to));
  const added = [...b].filter((x) => !a.has(x)).sort();
  const removed = [...a].filter((x) => !b.has(x)).sort();
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

// ── compatibility (§5.5) ────────────────────────────────────────────────────

/** Field name → its scope, over the fields of the resolution (and every declared one). */
export type FieldScopes = Readonly<Record<string, 'installation' | 'user'>>;

/**
 * The §5.5 compatibility refusals of a proposed change. Per-user values and
 * user-scope secrets never become installation values: an installation
 * record that holds a user-scope field is refused (the engine routes a
 * proposal by the field's scope, so this catches a manifest whose field
 * changed scope, and any writer that tried). A switch to `shared` refuses
 * while user-scope secret fields are bound: they must be re-entered as
 * installation secrets by an authorized admin (in the alpha `shared` is
 * refused anyway, BT-M2).
 */
export function compatibilityIssues(i: {
  to: Pick<GrantBearing, 'instanceScope'>;
  desired: Pick<DesiredConfig, 'values' | 'secrets'> | null;
  userDesired: Pick<DesiredConfig, 'values' | 'secrets'> | null;
  scopes: FieldScopes;
}): SetupErrorBody[] {
  const out: SetupErrorBody[] = [];
  const crossed = [
    ...Object.keys(i.desired?.values ?? {}), ...Object.keys(i.desired?.secrets ?? {}),
  ].filter((k) => i.scopes[k] === 'user');
  if (crossed.length) {
    const fieldErrors = Object.fromEntries([...new Set(crossed)].sort().map((k) => [k, 'a per-user value: never an installation value']));
    out.push(setupError('config-invalid', `per-user values never become installation values (${Object.keys(fieldErrors).join(', ')})`, {
      fieldErrors, manifestField: 'setup.fields',
    }));
  }
  const userSecrets = Object.keys(i.userDesired?.secrets ?? {}).filter((k) => i.scopes[k] === 'user').sort();
  if (i.to.instanceScope === 'shared' && userSecrets.length) {
    out.push(setupError('profile-unavailable', `a shared instance can't keep per-user secrets (${userSecrets.join(', ')}): `
      + 'they are never turned into installation secrets; an authorized admin enters installation secrets instead', {
      missing: userSecrets.map((k) => `user-secret:${k}`), manifestField: 'profiles',
    }));
  }
  return out;
}

// ── data stays behind (D65 §14, D107 §3.4) ──────────────────────────────────

export interface DataStaysBehind {
  /** `app-home`: the app's App Home; `private-home`: the user's Private Home; `environment`: the environmentScope's data; `instance-data`: the instance's own data dir. */
  kind: 'app-home' | 'private-home' | 'environment' | 'instance-data';
  /** Where the data stays, in words. */
  where: string;
  /** Why the app no longer sees it (or sees it with another owner). */
  why: string;
  /**
   * The instance data's file owner after an app ↔ private switch: the files
   * stay owned by the uid that wrote them. Never chowned silently; there is
   * no app ↔ user-uid ownership migration in this release (the reviewed one,
   * identity/runAsOwnership.ts, covers root ↔ app only), so the change only
   * lists it.
   */
  ownership?: { writtenAs: 'app' | 'user'; runsAs: 'app' | 'user'; migrated: false };
}

/** Copying is never part of a change; the plan says so in one sentence. */
export const DATA_STAYS_NOTE = 'Data stays where it is: nothing is copied, moved or re-owned by this change. Copying is a separate, explicit action.';
/** Decision 13: recovery restores a configuration, not data. */
export const RESTORE_NOTICE = 'Restoring the last applied configuration does not roll back app data or anything the app did outside AuraOS.';

/** What stays behind when the configuration goes from `from` to `to` (empty when neither home nor scope changes). */
export function dataStaysBehind(appId: string, from: Pick<GrantBearing, 'homeEnvironment' | 'environmentScope'> | null, to: Pick<GrantBearing, 'homeEnvironment' | 'environmentScope'>): DataStaysBehind[] {
  if (!from) return [];
  const out: DataStaysBehind[] = [];
  if (from.homeEnvironment !== to.homeEnvironment) {
    if (from.homeEnvironment === 'app') {
      out.push({ kind: 'app-home', where: `${appId}'s App Home`, why: 'the app now runs with your Private Home; its App Home is kept, not copied' });
    } else {
      out.push({ kind: 'private-home', where: 'your Private Home', why: `files ${appId} wrote there stay yours; with its App Home the app no longer sees them` });
    }
    out.push({
      kind: 'instance-data', where: `${appId}'s instance data`,
      why: from.homeEnvironment === 'app'
        ? 'written as the app\'s own user; a private instance runs as your user: the files keep their owner (no silent ownership change)'
        : 'written as your user; an App Home instance runs as the app\'s user: the files keep their owner (no silent ownership change)',
      ownership: { writtenAs: from.homeEnvironment === 'app' ? 'app' : 'user', runsAs: to.homeEnvironment === 'app' ? 'app' : 'user', migrated: false },
    });
  }
  if (from.environmentScope !== to.environmentScope) {
    out.push({
      kind: 'environment', where: from.environmentScope === 'global' ? 'the shared (global) environment' : 'your own (user) environment',
      why: `the app now uses the ${to.environmentScope} environment; what it kept in the ${from.environmentScope} one stays there`,
    });
  }
  return out;
}

// ── setup.version migration ─────────────────────────────────────────────────

export interface DesiredMigration {
  desired: DesiredConfig;
  /** Applied renames (`from → to`). */
  renamed: Array<{ from: string; to: string }>;
  /** A rename whose target already held a value: the target is kept, the old value dropped (named, never merged). */
  conflicts: string[];
}

/**
 * The declarative part of a `setup.version` change for ONE record: every
 * rename with `since` in (stored version, new version], in `since` order,
 * moves a value (or a secret handle) to its new name inside the same record.
 * Values never cross records (an installation value never becomes a user
 * value or the reverse). The record's `setupVersion` becomes the new one.
 */
export function migrateDesired(desired: DesiredConfig, setup: { version: number; renames: readonly SetupRename[] }, at: string): DesiredMigration {
  const next: DesiredConfig = structuredClone(desired);
  const renamed: DesiredMigration['renamed'] = [];
  const conflicts: string[] = [];
  const steps = [...setup.renames].filter((r) => r.since > desired.setupVersion && r.since <= setup.version)
    .sort((a, b) => a.since - b.since);
  for (const r of steps) {
    for (const bag of [next.values, next.secrets] as Array<Record<string, unknown>>) {
      if (!(r.from in bag)) continue;
      if (r.to in bag) conflicts.push(`${r.from}→${r.to}`);
      else bag[r.to] = bag[r.from];
      delete bag[r.from];
      renamed.push({ from: r.from, to: r.to });
    }
  }
  next.setupVersion = setup.version;
  next.updatedAt = at;
  next.updatedBy = 'kernel';
  return { desired: next, renamed, conflicts };
}

/** `onMigrateConfig`'s answer for the installation values: only known plain fields of the installation scope are taken. */
export function takeMigratedValues(values: ConfigValues, scopes: FieldScopes, secretFields: ReadonlySet<string>): ConfigValues {
  const out: ConfigValues = {};
  for (const [k, v] of Object.entries(values)) if (scopes[k] === 'installation' && !secretFields.has(k)) out[k] = v;
  return out;
}

// ── decision 13: the last applied configuration ─────────────────────────────

/**
 * The configuration of the last run that reached `ready` (kernel-owned,
 * sealed: `app:config:<installationId>:applied`, store.ts). Handles only.
 */
export interface AppliedSnapshot {
  v: 1;
  desired: DesiredConfig;
  userDesired: DesiredConfig | null;
  /** The user whose user-scope record this holds (alpha: the owner). */
  userId: string;
  profile: string | null;
  configDigest: string;
  grantDigest: string;
  appliedAt: string;
}

/** The snapshot's record key (beside `app:config:<installationId>` and `…:u:<userId>`). */
export const appliedRecordKey = (installationId: string): string => `app:config:${installationId}:applied`;

/** `GET …/setup/restore`: what a restore would bring back (no value of a secret: names only). */
export interface LastAppliedView {
  appId: string;
  profile: string | null;
  configDigest: string;
  appliedAt: string;
  /** True when it is the configuration the app runs with right now (nothing to restore). */
  current: boolean;
  values: ConfigValues;
  secretFields: string[];
  notice: string;
}

// ── the change plan and the change operations ───────────────────────────────

/** `POST …/setup/change`: what a proposed change does, before anything is written. */
export interface SetupChangePlan {
  appId: string;
  from: { profile: string | null; configDigest: string | null; grantDigest: string | null } | null;
  to: { profile: string | null; configDigest: string; grantDigest: string };
  /** Nothing would change (same digests as the ready configuration). */
  unchanged: boolean;
  /** Only plain values change: no approval, `aura app config set` / `setValues` takes it. */
  valuesOnly: boolean;
  grantDiff: GrantDiff;
  /** The `app.setup.apply` the apply would ask for (added privileges only), or null. */
  approval: SetupApplyPayload | null;
  /** §5.5 refusals and every other reason the change can't be applied as proposed. */
  compatibility: SetupErrorBody[];
  blocking: SetupErrorBody[];
  dataStaysBehind: DataStaysBehind[];
  note: string;
}

/** One `home.private[.sidecar:<n>]` grant the acting user gave this app (their own Private Home). */
export interface HomePrivateGrantView {
  permission: string;
  sidecar?: string;
}

/**
 * The change operations of the engine (P8), beside `SetupServiceContract`.
 * Errors are thrown like the contract's (`body: SetupErrorBody`).
 */
export interface SetupChangeContract {
  changePlan(appId: string, proposal: SetupProposal): Promise<SetupChangePlan>;
  lastApplied(appId: string): Promise<LastAppliedView | null>;
  /** Decision 13: revalidated like any change (current grants, D64 policy, runtime features); a revoked grant asks again, never `ready`. */
  restoreLast(appId: string, actor: SetupActor): Promise<SetupOutcome & { notice: string }>;
  /** The acting user's own Private Home grants to this app. */
  homePrivateGrants(appId: string, actor: SetupActor): Promise<HomePrivateGrantView[]>;
  /** The acting user revokes their own `home.private` (with every sidecar grant) or one `home.private.sidecar:<n>`; the app becomes `blocked`. */
  revokeHomePrivate(appId: string, actor: SetupActor, opts?: { sidecar?: string }): Promise<{ revoked: string[]; state: SetupStateView }>;
  /**
   * The update re-resolution (§3.5): the stored desired configuration against
   * the app's current manifest. 6B.M `updateInstance` calls it after the new
   * manifest is loaded and before `onUpdate`; the registry's `app:installed`
   * (an install or update landed) calls it too.
   */
  onManifestChanged(appId: string): Promise<ManifestChangeOutcome>;
}

/** What the update re-resolution did. */
export interface ManifestChangeOutcome {
  /** `unchanged`: the configuration still validates with its digests; `migrated`: renames applied and re-validated to `ready`; `repair-required` / `blocked`: the app does not start. */
  status: 'unchanged' | 'migrated' | 'repair-required' | 'blocked' | 'not-ready';
  state: SetupStateView | null;
  renamed?: Array<{ from: string; to: string }>;
  error?: SetupErrorBody;
}

/** The scope of every field a resolution and a manifest name (the resolver's fields win). */
export function fieldScopesOf(r: Pick<Resolution, 'fields'>, declared: Record<string, { scope: 'installation' | 'user' }>): FieldScopes {
  const out: Record<string, 'installation' | 'user'> = {};
  for (const [k, d] of Object.entries(declared)) out[k] = d.scope;
  for (const [k, f] of Object.entries(r.fields)) out[k] = f.scope === 'user' ? 'user' : 'installation';
  return out;
}
