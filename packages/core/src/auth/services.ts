/**
 * Shell-wide auth singletons on globalThis (like AppManager / the
 * notification service), on the central Valkey (`defaultRedis()`).
 *
 * The Authorizer reads app manifests and install scopes from the live
 * AppManager registry, lazily, so this module never forces AppManager init.
 */
import { defaultRedis } from '@aura/kv-store';
import { getAppManager } from '../app-manager/AppManager.js';
import { AdminAudit } from './AdminAudit.js';
import { AdminAuth } from './AdminAuth.js';
import { defaultAdminKeyFile } from './adminCredential.js';
import { ApiKeyStore } from './ApiKeyStore.js';
import { ClientSessionStore } from './ClientSessions.js';
import { Authorizer } from './Authorizer.js';
import { GrantStore } from './GrantStore.js';

/** Bump when the shape changes, so a singleton made by an older module copy is replaced. */
export const AUTH_SERVICES_VERSION = 2;

export interface AuthServices {
  version: number;
  grants: GrantStore;
  apiKeys: ApiKeyStore;
  admin: AdminAuth;
  audit: AdminAudit;
  authorizer: Authorizer;
  /** Phase 5: lock state per shell client (tab). Not a credential. */
  clientSessions: ClientSessionStore;
}

const GLOBAL_KEY = '__auraAuthServices';
type G = typeof globalThis & { [GLOBAL_KEY]?: AuthServices };

function registry() {
  try { return getAppManager().registry; } catch { return null; }
}

export function getAuthServices(): AuthServices {
  const g = globalThis as G;
  const cur = g[GLOBAL_KEY];
  if (cur && cur.version >= AUTH_SERVICES_VERSION) return cur;

  const redis = () => defaultRedis();
  const grants = new GrantStore(redis);
  const audit = new AdminAudit(redis);
  const admin = new AdminAuth({
    keyFile: defaultAdminKeyFile(),
    redis,
    onRotated: (purged) => {
      console.log(`[auth] admin credential changed on disk (rotation) — ${purged} admin session(s) revoked`);
      void audit.record({ by: { kind: 'system' }, action: 'credential.rotated', detail: { sessionsRevoked: purged } }).catch(() => undefined);
    },
  });
  const authorizer = new Authorizer({
    grants,
    declared: (appId) => registry()?.getById(appId)?.permissions,
    appScope: (appId) => registry()?.getScopeId(appId),
  });
  const svc: AuthServices = {
    version: AUTH_SERVICES_VERSION, grants, apiKeys: new ApiKeyStore(redis), admin, audit, authorizer,
    clientSessions: new ClientSessionStore({ redis }),
  };
  g[GLOBAL_KEY] = svc;
  return svc;
}

/** Tests / soft-restart. */
export function resetAuthServices(): void {
  delete (globalThis as G)[GLOBAL_KEY];
}
