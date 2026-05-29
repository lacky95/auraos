import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import chokidar from 'chokidar';
import { AppManifestSchema, type AppManifest } from '../types/manifest.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import type { ScopeDefinition, ScopedManifest } from '../scopes/types.js';

export class AppRegistry {
  private manifests = new Map<string, ScopedManifest>();
  /** Scopes sorted ascending by priority (0=system, 1=global, 2=user). */
  private readonly scopes: ScopeDefinition[];

  constructor(scopes: ScopeDefinition[]) {
    this.scopes = scopes.slice().sort((a, b) => a.priority - b.priority);
  }

  async init(): Promise<void> {
    // Initial scan of all scope dirs in priority order (lower first so higher
    // priority overwrites on conflict when calling mergeForApp).
    for (const scope of this.scopes) {
      await this.scanScope(scope);
    }

    // One chokidar watcher per scope dir.
    for (const scope of this.scopes) {
      const watcher = chokidar.watch(`${scope.appsDir}/*/app.manifest.json`, {
        ignoreInitial: true,
        depth: 1,
      });

      watcher.on('add',    (path) => this.loadManifestFile(path, scope));
      watcher.on('change', (path) => this.loadManifestFile(path, scope));
      watcher.on('unlink', (path) => this.handleUnlink(path, scope));
    }
  }

  private async scanScope(scope: ScopeDefinition): Promise<void> {
    const { readdirSync } = await import('node:fs');
    if (!existsSync(scope.appsDir)) return;
    const entries = readdirSync(scope.appsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.loadManifestFile(join(scope.appsDir, entry.name, 'app.manifest.json'), scope);
      }
    }
  }

  private loadManifestFile(manifestPath: string, scope: ScopeDefinition): void {
    if (!existsSync(manifestPath)) return;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const base = AppManifestSchema.parse(raw);
      const candidate: ScopedManifest = {
        ...base,
        scopeId: scope.id,
        appDir:  join(scope.appsDir, base.id),
      };

      const existing = this.manifests.get(base.id);
      // Higher priority scope wins; only update if incoming priority is >= current.
      if (!existing || scope.priority >= this.scopePriority(existing.scopeId)) {
        if (existing && existing.scopeId !== scope.id) {
          console.log(`[AppRegistry] ${base.id}: scope ${scope.id} (priority ${scope.priority}) shadows ${existing.scopeId}`);
        }
        const isNew = !existing || existing.scopeId !== scope.id;
        this.manifests.set(base.id, candidate);
        if (isNew) OsEventBus.emit('app:installed', { appId: base.id });
        console.log(`[AppRegistry] Loaded: ${base.id} v${base.version} (scope=${scope.id})`);
      }
    } catch (err) {
      console.error(`[AppRegistry] Invalid manifest at ${manifestPath}:`, err);
    }
  }

  private handleUnlink(manifestPath: string, scope: ScopeDefinition): void {
    // Find if this scope was the winner for the appId in this path.
    const appId = this.appIdFromPath(manifestPath, scope);
    if (!appId) return;
    const current = this.manifests.get(appId);
    if (!current || current.scopeId !== scope.id) return;

    // Winner was removed — try to unmask the next-best entry from lower scopes.
    this.manifests.delete(appId);
    const lowerScope = this.findLowerScopeEntry(appId, scope.priority);
    if (lowerScope) {
      this.manifests.set(appId, lowerScope);
      OsEventBus.emit('app:installed', { appId });
      console.log(`[AppRegistry] ${appId}: unmasked from scope ${lowerScope.scopeId}`);
    } else {
      OsEventBus.emit('app:removed', { appId });
      console.log(`[AppRegistry] Removed: ${appId}`);
    }
  }

  /** Scan all lower-priority scope dirs for appId and return the highest entry found. */
  private findLowerScopeEntry(appId: string, abovePriority: number): ScopedManifest | null {
    const candidates = this.scopes
      .filter((s) => s.priority < abovePriority)
      .sort((a, b) => b.priority - a.priority); // highest first

    for (const scope of candidates) {
      const manifestPath = join(scope.appsDir, appId, 'app.manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const base = AppManifestSchema.parse(raw);
        return { ...base, scopeId: scope.id, appDir: join(scope.appsDir, base.id) };
      } catch { /* skip corrupt */ }
    }
    return null;
  }

  private scopePriority(id: string): number {
    return this.scopes.find((s) => s.id === id)?.priority ?? 0;
  }

  private appIdFromPath(manifestPath: string, scope: ScopeDefinition): string | null {
    // Extract `<appId>` from `<scope.appsDir>/<appId>/app.manifest.json`
    const prefix = scope.appsDir + '/';
    if (!manifestPath.startsWith(prefix)) return null;
    const rest = manifestPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    return slash > 0 ? rest.slice(0, slash) : null;
  }

  /**
   * Force a re-parse of an app's manifest across all scopes. Used by
   * `/api/admin/manifest-edit` after a direct file write.
   */
  public reloadFromDisk(appId: string): void {
    // Re-scan all scope dirs for this appId and re-apply priority merge.
    this.manifests.delete(appId);
    const candidates: ScopedManifest[] = [];
    for (const scope of this.scopes) {
      const manifestPath = join(scope.appsDir, appId, 'app.manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const base = AppManifestSchema.parse(raw);
        candidates.push({ ...base, scopeId: scope.id, appDir: join(scope.appsDir, base.id) });
      } catch { /* skip */ }
    }
    if (candidates.length === 0) return;
    // Pick the highest-priority candidate.
    const winner = candidates.sort((a, b) => this.scopePriority(b.scopeId) - this.scopePriority(a.scopeId))[0]!;
    this.manifests.set(appId, winner);
  }

  getAll(): ScopedManifest[] {
    return Array.from(this.manifests.values());
  }

  getById(id: string): ScopedManifest | undefined {
    return this.manifests.get(id);
  }

  has(id: string): boolean {
    return this.manifests.has(id);
  }

  /** Pre-computed absolute path to the app's source directory. */
  getAppDir(id: string): string {
    const m = this.manifests.get(id);
    if (m) return m.appDir;
    // Fallback: system scope (keeps backward compat for callers before init).
    return join(this.scopes[0]!.appsDir, id);
  }

  getScopeId(id: string): ScopedManifest['scopeId'] | undefined {
    return this.manifests.get(id)?.scopeId;
  }

  /**
   * Returns the system scope's appsDir for backward-compatible callers
   * (Nexus preview, installed.ts fallback ref) that predate scopes.
   */
  getAppsDir(): string {
    return this.scopes.find((s) => s.id === 'system')?.appsDir ?? this.scopes[0]!.appsDir;
  }
}
