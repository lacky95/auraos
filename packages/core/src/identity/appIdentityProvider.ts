/**
 * The spawn identity of an app process (P5-3, stream A): the kernel's
 * `SpawnIdentityProvider` behind `AppManager.spawnContext`.
 *
 *   runAs root (or no record)  today's root, unchanged
 *   runAs app                  the installation's app identity from the one
 *                              registry (`ensureApp`, 200000-299999, never
 *                              reused), allocated on its first start
 *
 * Fail closed: an `app` installation whose identity can't be allocated, or is
 * retired, does not start; nothing falls back to root.
 */
import type { LinuxIdentityStore } from './LinuxIdentityStore.js';
import { ROOT_SPAWN_IDENTITY, type SpawnIdentity, type SpawnIdentityProvider, type SpawnIdentityRequest } from './types.js';

export class AppIdentityError extends Error {
  constructor(readonly appId: string, message: string) {
    super(message);
    this.name = 'AppIdentityError';
  }
}

export function appIdentityProvider(store: () => Promise<Pick<LinuxIdentityStore, 'ensureApp'>>): SpawnIdentityProvider {
  return {
    async identityFor(req: SpawnIdentityRequest): Promise<SpawnIdentity> {
      if ((req.runAs ?? 'root') !== 'app') return { ...ROOT_SPAWN_IDENTITY };
      if (!req.installationId) {
        throw new AppIdentityError(req.appId, `${req.appId} runs as its app identity but has no recorded installation; not started (no root fallback)`);
      }
      let rec;
      try { rec = await (await store()).ensureApp(req.installationId, req.appId); }
      catch (err) {
        throw new AppIdentityError(req.appId, `${req.appId}: its app identity could not be allocated (${(err as Error).message}); not started (no root fallback)`);
      }
      if (rec.state !== 'active') throw new AppIdentityError(req.appId, `${req.appId}: its app identity is ${rec.state}; not started`);
      return { uid: rec.uid, gid: rec.gid, range: 'app' };
    },
  };
}
