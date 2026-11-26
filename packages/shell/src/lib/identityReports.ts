/**
 * Phase 5 stream I: the read-only identity and home reports, on the live
 * system. This module only gathers inputs (accounts, identities, installed
 * apps, running instances) and hands them to core, which measures and
 * decides. Nothing here allocates, chowns, copies or writes.
 *
 *   ownershipReport()  the dry-run ownership report (P5-2, D70): what stream
 *                      H would chown, per row, with counts and a digest
 *   homesPlan()        the Home Resolver in report mode: today's `/home/aura`
 *                      source against the Phase 5 target, per instance
 *   importReport()     the home import report (Q15): what each app may want
 *                      from today's shared home
 *   identityCheck()    the registry and account invariants, for
 *                      `diagnose/identity-registry` and `diagnose/identity-accounts`
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { OwnershipRowSpec } from '@aura/core';

const dataDir = (): string => process.env['AURA_DATA_DIR'] ?? '/data';
/** The live checkout: the Developer Mode tree (P5-2). */
const WORKSPACE_DIR = '/workspace';

type Mgr = ReturnType<typeof core.getAppManager>;

/** A scope's data directory, by the one scope table (ScopeRegistry). */
function scopeDataDir(mgr: Mgr, scopeId: string): string | null {
  try {
    return new core.ScopeRegistry({ systemAppsDir: mgr.registry.getAppsDir(), dataDir: dataDir() }).getById(scopeId as never).dataDir;
  } catch {
    return null;
  }
}

async function installationOf(appId: string, scopeId: string): Promise<string | null> {
  try { return (await core.getAppHostServices().registry.findInstallation(appId, scopeId))?.installationId ?? null; } catch { return null; }
}

function subdirs(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}

/** The candidate rows of the live system (read-only: identities are looked up, never allocated). */
export async function liveOwnershipSpecs(): Promise<OwnershipRowSpec[]> {
  const svc = core.getAuthServices();
  const mgr = core.getAppManager();
  const root = dataDir();
  const specs: OwnershipRowSpec[] = [];
  const ownerIdentity = await svc.identity.getUser(core.DEFAULT_OWNER_ID);
  const ownerTo = ownerIdentity ? { uid: ownerIdentity.uid, gid: ownerIdentity.gid } : null;

  for (const u of await svc.users.listUsers()) {
    const id = await svc.identity.getUser(u.id);
    const to = id ? { uid: id.uid, gid: id.gid } : null;
    specs.push({ section: 'planned', path: core.userHomeDir(root, u.id), kind: 'private-home', owner: u.id, to, mode: '0700', recursive: true });
    specs.push({ section: 'planned', path: join(root, 'aura', 'workspaces', u.id), kind: 'user-workspaces', owner: u.id, to, recursive: true });
  }

  specs.push({
    section: 'plannedUserPaths', path: WORKSPACE_DIR, kind: 'developer-mode-tree', owner: core.DEFAULT_OWNER_ID, to: ownerTo,
    recursive: true, exclude: ['node_modules'], only: 'when Developer Mode is on', splitGit: true,
  });
  const patches = join(root, 'aura', 'patches');
  for (const name of subdirs(patches)) {
    specs.push({ section: 'plannedUserPaths', path: join(patches, name), kind: 'patch-repo', owner: core.DEFAULT_OWNER_ID, to: ownerTo, recursive: true });
  }

  for (const m of mgr.registry.getAll()) {
    const scopeDir = scopeDataDir(mgr, m.scopeId);
    const installationId = await installationOf(m.id, m.scopeId);
    const app = installationId ? await svc.identity.getApp(installationId) : null;
    if (scopeDir) {
      // Instance data is `<scope>/apps/<appId>/<appId>[-N]` (AppManager). For global and user
      // scopes `<scope>/apps/<appId>` is also the app's source tree, so the rows name the
      // instance directories, never the whole tree.
      const appData = join(scopeDir, 'apps', m.id);
      const instanceDir = new RegExp(`^${m.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`);
      for (const dir of subdirs(appData).filter((d) => instanceDir.test(d))) {
        specs.push({
          section: 'plannedAppPaths', path: join(appData, dir), kind: 'app-data', owner: installationId ?? m.id,
          to: app ? { uid: app.uid, gid: app.gid } : null, recursive: true,
          note: app ? 'applied with this installation\'s runAs flip (P5-3)' : 'app identity not allocated yet (stream A allocates it at the runAs flip)',
        });
      }
    }
    let mode: 'open' | 'closed' = 'closed';
    try {
      const scope = new core.ScopeRegistry({ systemAppsDir: mgr.registry.getAppsDir(), dataDir: root }).getById(m.scopeId as never);
      mode = core.effectiveSourceMode(scope, m).mode;
    } catch { mode = 'closed'; }
    if (mode === 'open' && m.scopeId === 'user') {
      specs.push({
        section: 'plannedUserPaths', path: m.appDir, kind: 'own-app-source', owner: installationId ?? m.id,
        to: ownerTo && app ? { uid: ownerTo.uid, gid: app.gid } : null, mode: 'g+rX, setgid dirs', recursive: true, exclude: ['node_modules'],
      });
    } else {
      specs.push({
        section: 'reportOnly', path: m.appDir, kind: 'app-source', owner: installationId ?? m.id, to: null, recursive: false,
        note: 'closed source stays 0:0 (read-only bind); node_modules and dist are written by the builder',
      });
    }
  }
  return specs;
}

/** Paths no row may cover: a blanket chown (D70). */
export const refusedRoots = (): string[] => ['/', dataDir(), join(dataDir(), 'aura'), join(dataDir(), 'scopes')];

export async function ownershipReport(): Promise<core.OwnershipReport> {
  return core.buildOwnershipReport(await liveOwnershipSpecs(), { refuseRoots: refusedRoots() });
}

export async function homesPlan(): Promise<core.HomePlanReport> {
  const mgr = core.getAppManager();
  const current = await core.legacyHomeResolver(dataDir()).resolve({} as never);
  const rows: core.HomePlanInstance[] = [];
  for (const inst of mgr.getAllInstances()) {
    if (inst.inPool) continue;
    const m = mgr.registry.getById(inst.appId);
    if (!m) continue;
    rows.push({
      instanceId: inst.instanceId, appId: inst.appId,
      installationId: await installationOf(inst.appId, m.scopeId),
      environmentScope: m.environmentScope ?? 'global',
      ...((inst as { owner?: string }).owner ? { owner: (inst as { owner?: string }).owner } : {}),
      currentHostPath: current.hostPath,
    });
  }
  return core.homePlan(dataDir(), rows);
}

export async function importReport(): Promise<core.ImportReport> {
  const mgr = core.getAppManager();
  const installations: core.ImportReportInstallation[] = [];
  for (const m of mgr.registry.getAll()) {
    if (m.scopeId === 'system') continue; // built-in apps keep no personal tool state to import
    const installationId = await installationOf(m.id, m.scopeId);
    if (installationId) installations.push({ installationId, appId: m.id, tools: Array.isArray(m.tools) ? m.tools : [] });
  }
  return core.buildImportReport(core.userHomeDir(dataDir()), installations);
}

export interface IdentityCheck {
  registry: core.IdentityRegistryCheck;
  accounts: core.AccountsCheck;
  /** Enabled accounts without a Linux identity (allocated at boot and at `user add`). */
  enabledWithoutIdentity: string[];
  /** Audit targets `user:<x>` where `x` is no account id (C6), counted since the v2 migration. */
  auditUsernameTargets: number;
}

export async function identityCheck(): Promise<IdentityCheck> {
  const svc = core.getAuthServices();
  const users = await svc.users.listUsers();
  const enabledWithoutIdentity: string[] = [];
  for (const u of users) if (!u.disabled && !(await svc.identity.getUser(u.id))) enabledWithoutIdentity.push(u.id);
  const ids = new Set(users.map((u) => u.id));
  const entries = await svc.audit.list(1000);
  // Entries before the boot migration (`auth.record-migrated`) may still name a username.
  const cutoff = entries.find((e) => e.action === 'auth.record-migrated')?.at ?? 0;
  const named = (t: string | undefined) => /^user:([^:@]+)$/.exec(t ?? '')?.[1];
  const auditUsernameTargets = entries.filter((e) => {
    const who = e.at >= cutoff ? named(e.target) : undefined;
    return who !== undefined && !ids.has(who);
  }).length;
  return { registry: await svc.identity.check(), accounts: await svc.users.checkAccounts(), enabledWithoutIdentity, auditUsernameTargets };
}
