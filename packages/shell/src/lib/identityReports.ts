/**
 * Phase 5 stream I: the read-only identity and home reports, on the live
 * system. This module only gathers inputs (accounts, identities, installed
 * apps, running instances) and hands them to core, which measures and
 * decides. Nothing here allocates, chowns, copies or writes.
 *
 *   ownershipReport()  the dry-run ownership report (P5-2, D70): what stream
 *                      H would chown, per row, with counts and a digest
 *   homesPlan()        each instance's `/home/aura` against the Home
 *                      Resolver's target, per instance
 *   importReport()     the home import report (Q15): what each app may want
 *                      from today's shared home
 *   identityCheck()    the registry and account invariants, for
 *                      `diagnose/identity-registry` and `diagnose/identity-accounts`
 *   privilegeReview()  per installation: runAs, app identity, last app start
 *                      and every "needs elevated privileges" reason (P5-3, A)
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
      // Stream A's rows (core appOwnershipSpecs), the same ones a `runAs: app` start applies:
      // the instance directories `<scope>/apps/<appId>/<appId>[-N]` (never the whole tree, which
      // is the source for global and user scopes) and, for an app served by astro dev, its caches.
      specs.push(...core.appOwnershipSpecs({
        appId: m.id, installationId, appDataRoot: join(scopeDir, 'apps', m.id), appDir: m.appDir,
        devServed: m.runtime !== 'raw' && core.serveState(m.appDir, m).mode !== 'prod',
        identity: app ? { uid: app.uid, gid: app.gid } : null,
      }));
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
      currentHostPath: (await mgr.appHomeOf(inst.instanceId))?.hostPath ?? null,
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

/** The privilege review (P5-3, stream A): per installed app, how it runs and what it would need. */
export async function privilegeReview(): Promise<core.PrivilegeReview> {
  const svc = core.getAuthServices();
  const mgr = core.getAppManager();
  const hosts = core.getAppHostServices().registry;
  const inputs: core.PrivilegeReviewInput[] = [];
  const instances = mgr.getAllInstances();
  for (const m of mgr.registry.getAll()) {
    let inst: core.AppInstallation | null = null;
    try { inst = await hosts.findInstallation(m.id, m.scopeId); } catch { inst = null; }
    const app = inst ? await svc.identity.getApp(inst.installationId) : null;
    let runtime: { id: string | null; identity: 'none' | 'emulated' | 'enforced' | null } = { id: null, identity: null };
    try {
      const r = await mgr.resolveRuntime(m.id, m, { sourceMode: mgr.sourceModeOf(m.id)?.mode ?? 'closed' });
      runtime = { id: r.runtime, identity: r.capabilities.identity };
    } catch { /* an unresolvable runtime is the runtimes report's finding */ }
    const last = mgr.lastAppStart(m.id);
    inputs.push({
      appId: m.id, scope: m.scopeId, installationId: inst?.installationId ?? null,
      runAs: inst ? inst.runAs ?? 'root' : null,
      identity: app ? { uid: app.uid, gid: app.gid } : null,
      needs: core.manifestPrivilegeNeeds(m, runtime, core.BASE_IMAGE),
      instances: instances.filter((i) => i.appId === m.id && !i.inPool)
        .map((i) => ({ instanceId: i.instanceId, uid: typeof i.uid === 'number' ? i.uid : null })),
      ...(last ? { lastAppStart: last } : {}),
      rootRequest: (() => {
        const c = core.executionConfigOf(m);
        return c ? { digest: core.executionDigest(c), reason: String((m as { execution?: { reason?: string } }).execution?.reason ?? '') } : null;
      })(),
      rootApproval: inst?.execution ?? null,
    });
  }
  return core.buildPrivilegeReview(inputs);
}
