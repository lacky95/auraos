/**
 * D75: the runtime migration of existing installations (Phase 5 plan,
 * stream R; §11.3). Before the runtime release an omitted `sandbox` meant
 * PRoot, and PRoot ran an app unwrapped in the master when `AURA_USE_PROOT`
 * was off, the rootfs was missing or the app said `useProot: false`. After
 * it, an omitted `sandbox` means the Runtime Settings default (`container`).
 *
 * Once, in kernel init (D78: no Shell, session or request dependency), this
 * records every installation's legacy effective runtime and:
 *   - keeps it through a `source: 'migration'` override where it is secure
 *     (an open or own app on PRoot in the master, `sandbox` omitted);
 *   - marks it pending, failing closed until the owner decides, where it is
 *     not (`master-direct`; a closed app on PRoot, ARI-4). No override, no
 *     fallback, no silent switch to `container`;
 *   - leaves everything else unchanged (a `container` app; a manifest that
 *     names `proot` keeps naming it).
 * It writes a report (`/data/aura/runtime-migration/<ts>.json`) and the
 * audit row `runtime.migration-recorded`. It is idempotent: the record keeps
 * `migrations.d75`, and a second run changes nothing. The capability check
 * still runs at every start, whatever the source (no grandfathering).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { RuntimeRegistry } from './registry.js';
import { runtimeNeeds } from './registry.js';
import { RuntimeChangeError, type RuntimeChange, type RuntimeSettingsStore } from './settingsStore.js';
import {
  missingCapabilities, type LegacyRuntime, type RuntimeMigrationPending, type RuntimeOverride, type RuntimeSettingsRecord,
} from './types.js';

/** What an omitted `sandbox` meant before the runtime release. */
const LEGACY_OMITTED_SANDBOX = 'proot';

export interface MigrationApp {
  appId: string;
  manifest: Pick<AppManifest, 'id' | 'sandbox' | 'useProot' | 'services' | 'ports' | 'warmPool'>;
  installationId: string | null;
  sourceMode: 'open' | 'closed';
}

export interface MigrationRow {
  installationId: string | null;
  appId: string;
  sandbox: 'explicit' | 'omitted';
  legacy: LegacyRuntime | 'unknown';
  decision: 'unchanged' | 'override' | 'incompatible';
  reason: string;
}

export interface LegacyEnv {
  /** `AURA_USE_PROOT` as the kernel sees it. */
  useProotEnv: string | undefined;
  rootfsPresent: boolean;
}

/** The runtime an installation effectively ran in before the release (ProotRunner `prooted`, AppManager's old fallback). */
export function legacyRuntime(m: MigrationApp['manifest'], env: LegacyEnv): LegacyRuntime | 'unknown' {
  const sandbox = m.sandbox ?? LEGACY_OMITTED_SANDBOX;
  if (sandbox === 'container') return 'container';
  if (sandbox !== 'proot') return 'unknown';
  return env.useProotEnv === 'true' && m.useProot !== false && env.rootfsPresent ? 'proot-master' : 'master-direct';
}

/** One installation's D75 row (the plan's table, step 3). */
export function classify(app: MigrationApp, env: LegacyEnv): MigrationRow {
  const sandbox = app.manifest.sandbox ? 'explicit' : 'omitted';
  const legacy = legacyRuntime(app.manifest, env);
  const row = { installationId: app.installationId, appId: app.appId, sandbox, legacy } as const;
  if (legacy === 'container') return { ...row, decision: 'unchanged', reason: 'container' };
  if (legacy === 'unknown') return { ...row, decision: 'unchanged', reason: `names runtime ${app.manifest.sandbox}: a start needs it installed (no fallback)` };
  if (legacy === 'master-direct') {
    return { ...row, decision: 'incompatible', reason: 'ran unwrapped in the kernel\'s container (no AURA_USE_PROOT, useProot: false or no rootfs): owner decision needed' };
  }
  if (app.sourceMode === 'closed') {
    return { ...row, decision: 'incompatible', reason: 'a closed app on PRoot: read-only binds are not enforced (ARI-4): owner decision needed' };
  }
  if (sandbox === 'explicit') return { ...row, decision: 'unchanged', reason: 'the manifest names proot' };
  return { ...row, decision: 'override', reason: 'kept on PRoot in the master (sandbox omitted, open app)' };
}

export interface MigrationResult {
  /** False: already recorded (idempotent) or not possible yet. */
  ran: boolean;
  /** Not every installation is known yet: nothing written, retried later. */
  incomplete?: string[];
  rows: MigrationRow[];
  reportFile?: string;
}

export interface MigrationDeps {
  store: Pick<RuntimeSettingsStore, 'read' | 'update'>;
  env: LegacyEnv;
  dataDir: string;
  now?: () => Date;
  audit?: (rows: MigrationRow[], reportFile: string) => Promise<void>;
}

/** Record the legacy runtimes once (see the file comment). Idempotent; throws on a Valkey error. */
export async function migrateLegacyRuntimes(apps: MigrationApp[], deps: MigrationDeps): Promise<MigrationResult> {
  if ((await deps.store.read()).record.migrations?.d75) return { ran: false, rows: [] };
  const missing = apps.filter((a) => !a.installationId).map((a) => a.appId);
  const rows = apps.map((a) => classify(a, deps.env));
  if (missing.length) return { ran: false, incomplete: missing, rows };

  const at = (deps.now ?? (() => new Date()))().toISOString();
  const change = await deps.store.update((cur) => {
    if (cur.migrations?.d75) return { next: cur };
    const overrides = { ...cur.overrides };
    const pending = { ...cur.pending };
    for (const r of rows) {
      const id = r.installationId!;
      if (overrides[id] || pending[id]) continue;
      if (r.decision === 'override') {
        overrides[id] = { runtime: 'proot', settings: { placement: 'master' }, source: 'migration', recordedAt: at, legacy: r.legacy as LegacyRuntime, appId: r.appId };
      } else if (r.decision === 'incompatible') {
        pending[id] = {
          appId: r.appId, legacy: r.legacy as LegacyRuntime, sandbox: r.sandbox, recordedAt: at,
          reason: r.legacy === 'master-direct' ? 'master-direct' : 'closed-on-proot',
        };
      }
    }
    const next: RuntimeSettingsRecord = { ...cur, overrides, migrations: { ...cur.migrations, d75: at } };
    if (Object.keys(pending).length) next.pending = pending;
    return { next };
  });
  if (!change.ok) return { ran: false, rows };

  const dir = join(deps.dataDir, 'aura', 'runtime-migration');
  mkdirSync(dir, { recursive: true });
  const reportFile = join(dir, `${at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportFile, JSON.stringify({ migration: 'd75', recordedAt: at, env: deps.env, installations: rows }, null, 2) + '\n');
  await deps.audit?.(rows, reportFile);
  return { ran: true, rows, reportFile };
}

export type MigrationDecision = { adoptDefault: true } | { keep: string };

/**
 * The owner's decision for a pending installation (D75 step 5): adopt the
 * default (recommended) or keep a runtime it can run on securely (`proot`
 * for an open app). Non-destructive: only the runtime selector changes.
 * Checked against the target runtime's capabilities before it is written.
 */
export function decideMigration(
  store: Pick<RuntimeSettingsStore, 'update'>,
  registry: RuntimeRegistry,
  app: MigrationApp & { installationId: string },
  decision: MigrationDecision,
  now: () => Date = () => new Date(),
): Promise<RuntimeChange<{ runtime: string; pending: RuntimeMigrationPending }>> {
  return store.update((cur) => {
    const pending = cur.pending?.[app.installationId];
    if (!pending) throw new RuntimeChangeError('not-found', `${app.appId} has no runtime migration decision open`);
    const runtime = 'keep' in decision ? decision.keep : cur.default;
    const module = registry.get(runtime);
    if (!module) throw new RuntimeChangeError('unknown-runtime', `runtime ${runtime} is not installed`);
    if (!registry.isEnabled(runtime, cur)) throw new RuntimeChangeError('not-enabled', `runtime ${runtime} is disabled`);
    const missing = missingCapabilities(registry.capabilitiesOf(runtime, cur), runtimeNeeds(app.manifest, app.sourceMode));
    if (missing.length) {
      throw new RuntimeChangeError('invalid-decision', `${app.appId} cannot run on ${runtime}: missing ${missing.join(', ')}`
        + (missing.includes('readOnlyBinds') ? ' (closed apps need enforced read-only binds, ARI-4)' : ''));
    }
    const rest = { ...cur.pending };
    delete rest[app.installationId];
    const overrides = { ...cur.overrides };
    const at = now().toISOString();
    if ('keep' in decision) {
      overrides[app.installationId] = {
        runtime, source: 'migration', recordedAt: at, legacy: pending.legacy, appId: app.appId,
        ...(runtime === 'proot' ? { settings: { placement: 'master' } } : {}),
      } satisfies RuntimeOverride;
    } else if (app.manifest.sandbox && app.manifest.sandbox !== runtime) {
      // The manifest names another runtime: adopting the default needs an override to win over it.
      overrides[app.installationId] = { runtime, source: 'override', recordedAt: at, appId: app.appId };
    }
    const next: RuntimeSettingsRecord = { ...cur, overrides };
    if (Object.keys(rest).length) next.pending = rest; else delete next.pending;
    return { next, result: { runtime, pending } };
  });
}

/** For the kernel: the legacy environment of this process. */
export function processLegacyEnv(baseRootfs: string, env: Record<string, string | undefined> = process.env): LegacyEnv {
  return { useProotEnv: env['AURA_USE_PROOT'], rootfsPresent: existsSync(baseRootfs) };
}
