/**
 * App installation lifecycle (5.13): what each install, update, uninstall and
 * discovery does to the app's installation record and App Hosts. The files
 * are the Installer's job; nothing here reads or writes a manifest's content
 * beyond what the caller passes in.
 *
 *   update, restart, confirmed move   keep the installation
 *   keep-data uninstall               reserved: routes off, labels held
 *   delete app data                   retired: labels tombstoned for good
 *   clone, copy, another publisher    a new installation with fresh hosts
 *
 * Grants follow the installation (Hotfix 2, S1, until grants are bound to the
 * installation id): deleting an app's data, and any new installation that
 * replaces an earlier one of the same id and scope, revoke the grants given
 * to that id in that scope, before the new installation exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanInstalledIdentities } from '../app-manager/AppIdentity.js';
import type { ScopeDefinition, ScopeId } from '../scopes/types.js';
import type { AppHostRecord, AppInstallation, AppInstanceScope, AppSourceFingerprint } from './contracts.js';
import { APP_HOST_DEFAULT_USER, sameAppSource, type AppHostStore } from './AppHostRegistry.js';
import { manifestHostClaim, type ManifestHostGuard } from './manifestHostGuard.js';
import { isProtectedHostName } from './hostRules.js';

export interface AppIdentityFacts {
  appId: string;
  originId: string | null;
  scope: ScopeId;
  source: AppSourceFingerprint;
}

/** May an install take over what a previous installation left behind? */
export type AppRestoreCheck =
  /** Nothing retained. */
  | { kind: 'none' }
  /** Same origin and source: restore. */
  | { kind: 'restore'; installation: AppInstallation }
  /** The operator must confirm. `installation` is null for data with no record. */
  | { kind: 'confirm'; installation: AppInstallation | null; reason: 'source-changed' | 'unrecorded' }
  /** Another app: its install must not see this data. */
  | { kind: 'deny'; installation: AppInstallation };

const userScope = (userId: string): AppInstanceScope => ({ kind: 'user', userId });

/** Where an installed app came from, from its Nexus record when it has one. */
export function appSourceFingerprint(scope: ScopeDefinition, appId: string): AppSourceFingerprint {
  if (scope.id === 'system') return { kind: 'system', ref: appId };
  const recordPath = join(scope.dataDir, 'nexus', 'installed', `${appId}.json`);
  if (existsSync(recordPath)) {
    try {
      const r = JSON.parse(readFileSync(recordPath, 'utf-8')) as { source?: AppSourceFingerprint['kind']; ref?: string; digest?: string };
      if (r.source && typeof r.ref === 'string') {
        return { kind: r.source, ref: r.ref, ...(r.digest ? { digest: r.digest } : {}) };
      }
    } catch { /* unreadable record: treated as a local app */ }
  }
  return { kind: 'local', ref: join(scope.appsDir, appId) };
}

/** A manifest's raw `hosts[].name`, shadowed copies included. Read-only. */
function readManifestHostNames(manifestPath: string): string[] {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { hosts?: unknown };
    if (!Array.isArray(m.hosts)) return [];
    return m.hosts.flatMap((h) => (typeof (h as { name?: unknown })?.name === 'string' ? [(h as { name: string }).name] : []));
  } catch { return []; }
}

export interface AppHostLifecycleOpts {
  /** Revoke the grants given to `appId` in install scope `scope` (GrantStore `revokeAppScope`). */
  revokeAppGrants?: (appId: string, scope: ScopeId) => Promise<unknown>;
}

export class AppHostLifecycle {
  /** `<scope>/<appId>` whose files an install is landing right now. */
  private readonly landing = new Set<string>();
  /**
   * App id → installation id of its approved user-scope overlay (Track P),
   * for the synchronous access checks (`trustedOverlay`). Filled by every
   * sync (the boot migration included) and install; emptied for an app while
   * an install lands, so the checks fail closed until it is decided again.
   */
  private readonly overlays = new Map<string, string>();

  constructor(
    private readonly registry: AppHostStore,
    private readonly guard: ManifestHostGuard | null = null,
    private readonly opts: AppHostLifecycleOpts = {},
  ) {}

  /**
   * The app under `appId` in `scope` is gone or another app now: what was
   * granted to that id there must not pass on. Throws when it cannot, so the
   * caller stops before the next app is installed under the id.
   */
  async revokeGrants(appId: string, scope: ScopeId): Promise<void> {
    await this.opts.revokeAppGrants?.(appId, scope);
  }

  /**
   * An install owns the app's record from its restore check until
   * `completeInstall`. A file-watcher event in that window must not decide the
   * restore on its own, so `syncDiscovered` skips it.
   */
  beginInstall(appId: string, scope: ScopeId): void {
    this.landing.add(`${scope}/${appId}`);
    if (scope === 'user') this.overlays.delete(appId);
  }
  endInstall(appId: string, scope: ScopeId): void { this.landing.delete(`${scope}/${appId}`); }

  /** `sync` for an app found by a registry event (clone, scaffold, copied dir). */
  async syncDiscovered(app: AppIdentityFacts): Promise<void> {
    if (this.landing.has(`${app.scope}/${app.appId}`)) return;
    await this.sync(app);
  }

  /**
   * Make the app's installation match what is on disk and give it its host.
   * Idempotent: the boot migration and every discovery run through here.
   */
  async sync(app: AppIdentityFacts): Promise<{ installation: AppInstallation; record: AppHostRecord }> {
    const installation = await this.resolveActive(app);
    await this.noteOverlay(installation);
    const record = await this.registry.allocate({
      installation, instanceScope: userScope(installation.userId), isSystemApp: app.scope === 'system',
    });
    return { installation, record };
  }

  private async resolveActive(app: AppIdentityFacts): Promise<AppInstallation> {
    const bound = await this.registry.findInstallation(app.appId, app.scope);
    if (!bound) {
      const reserved = await this.matchingReserved(app);
      if (reserved && sameAppSource(reserved.source, app.source)) return this.reactivated(reserved, app);
      // The first installation keeps what was granted before installations
      // existed; one after an earlier (retired) installation does not.
      if ((await this.registry.listInstallations(app.appId)).some((i) => i.scope === app.scope)) {
        await this.revokeGrants(app.appId, app.scope);
      }
      return this.registry.createInstallation({ ...app, userId: APP_HOST_DEFAULT_USER });
    }
    if (bound.state === 'reserved') {
      if (bound.originId === app.originId && sameAppSource(bound.source, app.source)) return this.reactivated(bound, app);
      await this.revokeGrants(app.appId, app.scope);
      return this.registry.createInstallation({ ...app, userId: bound.userId, replaces: bound.installationId });
    }
    // Active. Two different known origins are two different apps.
    if (bound.originId && app.originId && bound.originId !== app.originId) {
      await this.revokeGrants(app.appId, app.scope);
      await this.registry.reserve(bound.installationId);
      return this.registry.createInstallation({ ...app, userId: bound.userId, replaces: bound.installationId });
    }
    const originId = app.originId ?? bound.originId;
    const sourceChanged = bound.source.kind !== app.source.kind || bound.source.ref !== app.source.ref
      || bound.source.digest !== app.source.digest;
    if (originId === bound.originId && !sourceChanged) return bound;
    return this.registry.updateInstallation(bound.installationId, { originId, source: app.source });
  }

  private async reactivated(installation: AppInstallation, app: AppIdentityFacts): Promise<AppInstallation> {
    await this.registry.reactivate({ installationId: installation.installationId, originId: app.originId, source: app.source });
    return (await this.registry.getInstallation(installation.installationId))!;
  }

  private async matchingReserved(app: AppIdentityFacts): Promise<AppInstallation | null> {
    if (!app.originId) return null;
    const all = await this.registry.listInstallations(app.appId);
    return all.find((i) => i.state === 'reserved' && i.scope === app.scope && i.originId === app.originId) ?? null;
  }

  /** The restore check, run BEFORE an install may carry retained data over. */
  async checkRestore(app: AppIdentityFacts, hasRetainedData: boolean): Promise<AppRestoreCheck> {
    const bound = await this.registry.findInstallation(app.appId, app.scope);
    if (bound?.state === 'active') return { kind: 'none' };
    const candidate = bound?.state === 'reserved' ? bound : await this.matchingReserved(app);
    if (!candidate) return hasRetainedData ? { kind: 'confirm', installation: null, reason: 'unrecorded' } : { kind: 'none' };
    if (candidate.originId !== app.originId) return { kind: 'deny', installation: candidate };
    if (sameAppSource(candidate.source, app.source)) return { kind: 'restore', installation: candidate };
    return { kind: 'confirm', installation: candidate, reason: 'source-changed' };
  }

  /**
   * The installation id of `appId`'s approved user-scope overlay of its
   * system app, or null (synchronous; see `overlays`). The access rules give
   * such an overlay its system app's trust (AppManager `isTrustedSystemCopy`).
   */
  trustedOverlay(appId: string): string | null {
    return this.overlays.get(appId) ?? null;
  }

  private async noteOverlay(installation: AppInstallation): Promise<void> {
    if (installation.scope !== 'user') return;
    if (await this.registry.approvedOverlay(installation)) this.overlays.set(installation.appId, installation.installationId);
    else if (this.overlays.get(installation.appId) === installation.installationId) this.overlays.delete(installation.appId);
  }

  /**
   * The system installation an approved patch activation into `scope` links
   * to (Track P): the existing overlay's link when the copy it replaces is an
   * approved overlay, the system app's installation when no copy is in that
   * scope yet; null otherwise (a store or local copy stays what it is).
   */
  async overlayLinkFor(appId: string, scope: ScopeId, copyInScope: boolean): Promise<string | null> {
    if (scope !== 'user') return null;
    if (copyInScope) {
      const current = await this.registry.findInstallation(appId, scope);
      return current && await this.registry.approvedOverlay(current) ? current.overlay!.of : null;
    }
    const system = await this.registry.findInstallation(appId, 'system');
    return system?.state === 'active' ? system.installationId : null;
  }

  /**
   * After the files landed: record the outcome of the restore check.
   * `overlayOf`: an owner-approved patch activation of a system app (or of its
   * overlay) links this installation to that system installation; any other
   * install removes such a link.
   */
  async completeInstall(
    app: AppIdentityFacts, check: AppRestoreCheck, manifestHosts: readonly string[], opts: { overlayOf?: string | null } = {},
  ): Promise<void> {
    if (check.kind === 'restore' || (check.kind === 'confirm' && check.installation)) {
      await this.registry.reactivate({
        installationId: check.installation!.installationId, originId: app.originId, source: app.source,
        confirmedSourceChange: check.kind === 'confirm',
      });
    }
    await this.acceptManifestHosts(app.appId, manifestHosts);
    const { installation } = await this.sync(app);
    let linked = installation;
    if (opts.overlayOf) {
      linked = await this.registry.updateInstallation(installation.installationId, {
        overlay: { of: opts.overlayOf, approvedAt: Date.now(), source: installation.source },
      });
    } else if (installation.overlay) {
      linked = await this.registry.updateInstallation(installation.installationId, { overlay: null });
    }
    await this.noteOverlay(linked);
  }

  /** The installation `appId` is bound to in `scope` (any state), or null. */
  boundInstallation(appId: string, scope: ScopeId): Promise<AppInstallation | null> {
    return this.registry.findInstallation(appId, scope);
  }

  /** Keep-data uninstall. */
  async reserveApp(appId: string, scope: ScopeId): Promise<void> {
    const i = await this.registry.findInstallation(appId, scope);
    if (scope === 'user') this.overlays.delete(appId);
    if (i && i.state !== 'retired') await this.registry.reserve(i.installationId);
  }

  /** Delete app data: every installation of this app in this scope, for good. */
  async retireApp(appId: string, scope: ScopeId): Promise<string[]> {
    const ids: string[] = [];
    if (scope === 'user') this.overlays.delete(appId);
    await this.revokeGrants(appId, scope);
    for (const i of await this.registry.listInstallations(appId)) {
      if (i.scope !== scope || i.state === 'retired') continue;
      await this.registry.retire(i.installationId);
      ids.push(i.installationId);
    }
    return ids;
  }

  /** Why each of `hosts` may not be claimed by `appId`, for the install check. */
  async manifestHostProblems(appId: string, hosts: readonly string[], heldBySameApp: ReadonlySet<string>): Promise<string[]> {
    const problems: string[] = [];
    for (const name of hosts) {
      if (isProtectedHostName(name) && !heldBySameApp.has(name)) {
        problems.push(`hosts: '${name}' is reserved for the OS`);
        continue;
      }
      if (await this.isForeignLabel(appId, name)) problems.push(`hosts: '${name}' is an allocated app host`);
    }
    return problems;
  }

  /** `name`, or the base of its `xN` slot form, is a label `appId` does not own. */
  async isForeignLabel(appId: string, name: string): Promise<boolean> {
    const slotForm = /^(.+)x\d+$/.exec(name)?.[1];
    for (const candidate of slotForm ? [name, slotForm] : [name]) {
      const r = await this.registry.resolveLabel(candidate);
      if (r.status === 'retired') return true;
      if ((r.status === 'active' || r.status === 'reserved') && r.record.appId !== appId) return true;
    }
    return false;
  }

  async acceptManifestHosts(appId: string, hosts: readonly string[]): Promise<void> {
    const claims = hosts.map((h) => manifestHostClaim(appId, h));
    if (claims.length === 0) return;
    await this.registry.addKnownManifestHosts(claims);
    this.guard?.addKnown(claims);
  }

  /**
   * Boot migration: every app on disk in every scope, shadowed copies and apps
   * without an originId included, gets an installation and host. Reads
   * manifests only, so it can't dirty a git tree. Existing `hosts[]` become
   * known claims on the first run, so they keep routing.
   */
  async migrate(scopes: readonly ScopeDefinition[]): Promise<{ apps: number; failed: string[] }> {
    if ((await this.registry.getKnownManifestHosts()) === null) {
      const claims = scopes.flatMap((s) => scanInstalledIdentities(s.appsDir, s.id).flatMap((a) =>
        readManifestHostNames(join(s.appsDir, a.appId, 'app.manifest.json')).map((name) => manifestHostClaim(a.appId, name))));
      await this.registry.addKnownManifestHosts(claims);
      this.guard?.setKnown(new Set(claims));
    }
    let apps = 0;
    const failed: string[] = [];
    for (const scope of scopes) {
      for (const a of scanInstalledIdentities(scope.appsDir, scope.id)) {
        try {
          await this.sync({ appId: a.appId, originId: a.originId, scope: scope.id, source: appSourceFingerprint(scope, a.appId) });
          apps++;
        } catch (err) {
          failed.push(`${scope.id}/${a.appId}: ${(err as Error).message}`);
        }
      }
    }
    return { apps, failed };
  }

  /** Free slots whose instance no longer exists (after a crash or restart). */
  async releaseDeadSlots(appId: string, isLive: (instanceId: string) => boolean): Promise<void> {
    for (const record of await this.registry.listForApp(appId)) {
      for (const s of record.slots) {
        if (s.instanceId && !isLive(s.instanceId)) {
          await this.registry.releaseSlot(record.installationId, record.instanceScope, s.instanceId);
        }
      }
    }
  }

  /** Give a claimed instance its slot. */
  async claimSlot(appId: string, scope: ScopeId, instanceId: string): Promise<void> {
    const i = await this.registry.findInstallation(appId, scope);
    if (i?.state !== 'active') return;
    await this.registry.assignSlot(i.installationId, userScope(i.userId), instanceId);
  }

  async releaseSlot(appId: string, scope: ScopeId, instanceId: string): Promise<void> {
    const i = await this.registry.findInstallation(appId, scope);
    if (i) await this.registry.releaseSlot(i.installationId, userScope(i.userId), instanceId);
  }
}
