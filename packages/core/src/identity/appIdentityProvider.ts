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

/**
 * Stream T (D69): a user environment (`isUserEnvironment`, D107 S1; the
 * System Terminal today) is not an app identity. Each such instance is the
 * session host of one user and runs as that user's uid/gid (the owner 1000,
 * members from 100000; D70), with no capability, never as root and never as
 * an app uid. Every other instance keeps `base`.
 *
 * Fail closed: an instance with no user, a user without an enabled account,
 * or one whose identity can't be allocated or is retired does not start.
 */
export interface SessionHostIdentityDeps {
  /** Whether the instance hosts a user's environment (system/systemApps.ts `isUserEnvironment`, D107 S1). */
  isUserEnvironment(instance: { appId: string }): boolean;
  /** The user's account: its username (the passwd name) and whether it is disabled; null when unknown. */
  account(userId: string): Promise<{ username: string; disabled: boolean } | null>;
  /** The user's Linux identity, allocated on first use (LinuxIdentityStore `ensureUser`). */
  identity(userId: string): Promise<{ uid: number; gid: number; state: string }>;
  /** The owner's user id (`default`, D47): its range is `owner`. */
  ownerId: string;
}

export class SessionIdentityError extends Error {
  constructor(readonly appId: string, message: string) {
    super(message);
    this.name = 'SessionIdentityError';
  }
}

export function sessionHostIdentityProvider(base: SpawnIdentityProvider, deps: SessionHostIdentityDeps): SpawnIdentityProvider {
  return {
    async identityFor(req: SpawnIdentityRequest): Promise<SpawnIdentity> {
      if (!deps.isUserEnvironment(req)) return base.identityFor(req);
      const userId = req.userId;
      if (!userId) throw new SessionIdentityError(req.appId, `${req.appId} hosts a user's sessions and was asked to start for nobody; not started`);
      let account;
      try { account = await deps.account(userId); }
      catch (err) { throw new SessionIdentityError(req.appId, `${req.appId}: user ${userId}'s account can't be read (${(err as Error).message}); not started`); }
      if (!account) throw new SessionIdentityError(req.appId, `${req.appId}: user ${userId} has no account; not started`);
      if (account.disabled) throw new SessionIdentityError(req.appId, `${req.appId}: user ${userId} is disabled; not started`);
      let rec;
      try { rec = await deps.identity(userId); }
      catch (err) { throw new SessionIdentityError(req.appId, `${req.appId}: user ${userId}'s identity could not be allocated (${(err as Error).message}); not started (no root fallback)`); }
      if (rec.state !== 'active') throw new SessionIdentityError(req.appId, `${req.appId}: user ${userId}'s identity is ${rec.state}; not started`);
      if (!(rec.uid > 0 && rec.gid > 0)) throw new SessionIdentityError(req.appId, `${req.appId}: user ${userId} has no non-root identity; not started`);
      return {
        uid: rec.uid, gid: rec.gid, range: userId === deps.ownerId ? 'owner' : 'user', userId, account: account.username,
      };
    },
  };
}
