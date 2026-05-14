import type { AppManifest, DataProviderEntry } from '../types/manifest.js';
import type { AppInstance } from '../types/instance.js';

export interface ResolvedProvider {
  /** The app that owns this provider (manifest.id). */
  appId: string;
  /** The running instance serving the request. */
  instance: AppInstance;
  /** The matched provider entry (path + required perms). */
  entry: DataProviderEntry;
}

/**
 * Tracks which authority is currently served by which running instance.
 * Looking up a provider also matches the URL against the manifest's declared
 * provider paths, so we know which permission is required (if any).
 *
 * The registry is populated by AppManager when an instance reaches the
 * 'resumed' state and cleared when it stops.
 */
export class ContentProviderRegistry {
  /** authority → app instance that currently serves it */
  private byAuthority = new Map<string, AppInstance>();
  /** appId → manifest (cached for fast path-matching) */
  private manifestsByApp = new Map<string, AppManifest>();

  registerInstance(instance: AppInstance, manifest: AppManifest): void {
    if (!manifest.dataProvider) return;
    this.byAuthority.set(manifest.dataProvider.authority, instance);
    this.manifestsByApp.set(manifest.id, manifest);
  }

  unregisterInstance(instance: AppInstance, manifest: AppManifest | undefined): void {
    if (!manifest?.dataProvider) return;
    // Only clear if THIS instance is the registered one (paranoia for race conditions).
    if (this.byAuthority.get(manifest.dataProvider.authority)?.instanceId === instance.instanceId) {
      this.byAuthority.delete(manifest.dataProvider.authority);
    }
  }

  /**
   * Look up the provider serving `authority` AND match `requestPath` against
   * its declared paths. The path matches when:
   *   - requestPath equals an entry's path (exact)
   *   - OR requestPath starts with entry.path + '/' (sub-resource)
   * Returns `null` if either the authority isn't running or no entry matches.
   */
  resolveProvider(authority: string, requestPath: string): ResolvedProvider | null {
    const instance = this.byAuthority.get(authority);
    if (!instance || instance.port === null) return null;
    const manifest = this.manifestsByApp.get(instance.appId);
    if (!manifest?.dataProvider) return null;

    const normalized = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    const entry = manifest.dataProvider.providers.find(
      (p) => normalized === p.path || normalized.startsWith(p.path + '/'),
    );
    if (!entry) return null;
    return { appId: manifest.id, instance, entry };
  }

  /** Returns all currently-registered authorities (debug). */
  list(): Array<{ authority: string; appId: string; instanceId: string }> {
    return Array.from(this.byAuthority.entries()).map(([authority, inst]) => ({
      authority,
      appId: inst.appId,
      instanceId: inst.instanceId,
    }));
  }
}
