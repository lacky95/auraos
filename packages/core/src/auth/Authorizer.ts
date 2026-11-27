/**
 * Authorizer — the ONE place that decides "may this principal do that".
 *
 *   authorize(principal, action, resource?) → { allow, reason }
 *
 * Rules:
 *   system     everything (in-process `SYSTEM_PRINCIPAL` only, by identity)
 *   instance   the app's manifest-declared permissions (strict for
 *              ENFORCED ones, MVP auto-grant for the rest, as PermissionManager),
 *              PLUS the owner's grant (GrantStore) for privileged ones
 *              (notifications.locked / .popup / .read / .systemModal). A grant only counts
 *              while the app still resolves to the install scope it was given for,
 *              and to the installation it was given to (S1, `appGrantCounts`).
 *              `readGrant()` returns the SCOPE of a `notifications.read` grant.
 *   apiKey     its scopes (fixed by the owner at creation) or a GrantStore
 *              grant to the key; nothing else
 *   anonymous  phase-1 compatibility: basic sending only (an unverified Simple
 *              notification); never privileged
 *   user       a member's own app permissions only (I.2, C7): a `user` grant of
 *              `app.use:<installationId>` / `app.jump:<installationId>`. An
 *              instance acting for a user holds those of that user too. The
 *              owner's authority is a route level (shell decide.ts), never a
 *              permission here.
 *   foreign    D85 A1: a principal whose `systemId` is set and is not this
 *              system's is refused before any rule; its role is never read.
 *              An absent `systemId` means local.
 *   `admin.*`  never a permission: the owner's management routes decide who
 *              may manage (shell `lib/approvals/admin.ts`, D50)
 *
 * Delegation hook (ready for verified agents later):
 *   effective = principal's permissions ∩ actor's scope
 * Today the only actor is a self-declared, UNVERIFIED display name; its scope
 * is "unrestricted", so a name can never widen OR narrow a result. When
 * verified agent identities exist, `actorScopeAllows` intersects for real.
 */
import { ENFORCED_PERMISSIONS } from '../permissions/PermissionManager.js';

const warnedLegacy = new Set<string>();
function warnLegacy(appId: string, legacy: string, current: string): void {
  const k = `${appId}|${legacy}`;
  if (warnedLegacy.has(k)) return;
  warnedLegacy.add(k);
  console.warn(`[auth] ${appId} requests the deprecated permission '${legacy}' — treated as '${current}'; rename it in app.manifest.json`);
}
import {
  GrantStore, NOTIFICATIONS_READ_PERMISSION, USER_APP_PERMISSION_RE, appGrantCounts, isPrivilegedPermission, canonicalPermission,
} from './GrantStore.js';
import { localSystemId } from '../system/systemIdentity.js';
import type { ReadGrant } from '../notifications/access.js';
import {
  isSystemPrincipal, type AppGrantBinding, type DeclaredActor, type GrantSubject, type Principal,
} from './types.js';

export const BASIC_NOTIFICATION_PERMISSION = 'system.notifications';

export interface AuthzDecision {
  allow: boolean;
  /** Human-readable, safe to return to the caller. */
  reason: string;
}

export interface AuthorizerDeps {
  grants: GrantStore;
  /** The app's manifest permissions[] (undefined: unknown app). */
  declared(appId: string): string[] | undefined;
  /** The install scope the app id resolves to now (system|global|user) and its installation there (S1). */
  appBinding(appId: string): Promise<AppGrantBinding>;
  /** This system's id (D47); default `localSystemId()`. Unreadable: every principal naming a system is refused. */
  localSystemId?: () => string;
}

/**
 * D85 A1: whether `principal` names another Aura. Checked before any role or
 * grant rule; a principal without `systemId` is local (today's behaviour).
 * When this system's own id can't be read, any named system counts as foreign.
 */
export function isForeignPrincipal(principal: { systemId?: unknown }, local: () => string = localSystemId): boolean {
  if (principal.systemId === undefined) return false;
  try { return principal.systemId !== local(); } catch { return true; }
}

const ENFORCED = new Set(ENFORCED_PERMISSIONS);

/**
 * Delegation hook. An actor's scope is "unrestricted" until verified agent
 * identities exist — deliberately NOT keyed on the declared name.
 */
function actorScopeAllows(_actor: DeclaredActor | undefined, _action: string): boolean {
  return true;
}

const allow = (reason: string): AuthzDecision => ({ allow: true, reason });
const deny = (reason: string): AuthzDecision => ({ allow: false, reason });

export class Authorizer {
  constructor(private readonly deps: AuthorizerDeps) {}

  get grants(): GrantStore {
    return this.deps.grants;
  }

  async authorize(principal: Principal, action: string, _resource?: unknown): Promise<AuthzDecision> {
    if (!isSystemPrincipal(principal) && isForeignPrincipal(principal as { systemId?: unknown }, this.deps.localSystemId)) {
      return deny('foreign-system: a principal of another Aura has no authority here (D85)');
    }
    const base = await this.base(principal, action);
    if (!base.allow) return base;
    const actor = (principal as { actor?: DeclaredActor }).actor;
    if (!actorScopeAllows(actor, action)) return deny(`the acting agent's scope does not include '${action}'`);
    return base;
  }

  /**
   * Phase 5: the read scope a principal was granted (`notifications.read`),
   * or null. Apps need the manifest request AND the grant (same rules as
   * `authorize`); API keys a grant to the key. Everyone else: null.
   */
  async readGrant(principal: Principal): Promise<ReadGrant | null> {
    if (principal.kind !== 'instance' && principal.kind !== 'apiKey') return null;
    const d = await this.authorize(principal, NOTIFICATIONS_READ_PERMISSION);
    if (!d.allow) return null;
    const subject: GrantSubject = principal.kind === 'instance'
      ? { kind: 'app', id: principal.appId }
      : { kind: 'apiKey', id: principal.keyId };
    const g = await this.deps.grants.get(subject, NOTIFICATIONS_READ_PERMISSION);
    return g?.read ?? null;
  }

  private async base(principal: Principal, action: string): Promise<AuthzDecision> {
    if (isSystemPrincipal(principal)) return allow('AuraOS core (in-process)');
    if ((principal as { kind: string }).kind === 'system') return deny('only the in-process SYSTEM_PRINCIPAL may act as system');

    if (action.startsWith('admin.')) return deny('managing AuraOS is the owner\'s, through its routes: never an app permission');

    switch (principal.kind) {
      case 'anonymous':
        if (action === BASIC_NOTIFICATION_PERMISSION) return allow('unverified caller: basic Simple notifications only (phase-1 compatibility)');
        return deny(`'${action}' needs a verified caller (Authorization: Bearer $AURA_INSTANCE_TOKEN or an API key) and the owner's grant`);

      case 'apiKey': {
        if (principal.scopes.includes(action)) return allow(`API key '${principal.name}' has scope '${action}'`);
        if (isPrivilegedPermission(action) && await this.deps.grants.get({ kind: 'apiKey', id: principal.keyId }, action)) {
          return allow(`granted to API key '${principal.name}' by the owner`);
        }
        return deny(`API key '${principal.name}' has no scope '${action}'`);
      }

      case 'user': {
        if (!USER_APP_PERMISSION_RE.test(action)) return deny(`'${action}' is not a user permission`);
        if (await this.deps.grants.get({ kind: 'user', id: principal.userId }, action)) return allow(`granted to user ${principal.userId} by the owner`);
        return deny(`user ${principal.userId} holds no '${action}' grant`);
      }

      case 'instance': {
        const appId = principal.appId;
        // An app permission of the user this instance acts for (C7): the user's grant, never the app's.
        if (USER_APP_PERMISSION_RE.test(action)) {
          if (!principal.userId) return deny(`'${action}' is a user's permission; this instance acts for no user`);
          if (await this.deps.grants.get({ kind: 'user', id: principal.userId }, action)) return allow(`granted to user ${principal.userId} by the owner`);
          return deny(`user ${principal.userId} holds no '${action}' grant`);
        }
        const declared = this.deps.declared(appId);
        if (!declared) return deny(`unknown app ${appId}`);
        // Deprecated names in permissions[] still count (phase 6: desktopModal → systemModal).
        const legacy = declared.find((p) => p !== action && canonicalPermission(p) === action);
        if (legacy) warnLegacy(appId, legacy, action);
        const has = declared.includes(action) || !!legacy;
        if (isPrivilegedPermission(action)) {
          if (!has) return deny(`${appId} does not request '${action}' in app.manifest.json permissions[]`);
          const subject: GrantSubject = { kind: 'app', id: appId };
          const g = await this.deps.grants.get(subject, action);
          const short = action.startsWith('notifications.') ? action.split('.')[1] : action;
          if (!g) return deny(`'${action}' is requested by ${appId} but not granted — the owner must grant it (aura grant notif-perms ${appId} ${short})`);
          const current = await this.deps.appBinding(appId);
          if (g.appScope && current.scope && g.appScope !== current.scope) {
            return deny(`'${action}' was granted to ${appId} in scope '${g.appScope}', but the app now resolves to scope '${current.scope}' — grant it again`);
          }
          if (!appGrantCounts(g, current)) {
            return deny(`'${action}' was granted to another installation of ${appId}, not to this one — the owner must grant it again`);
          }
          return allow(`requested by ${appId} and granted by the owner`);
        }
        if (has) return allow(`declared by ${appId}`);
        if (ENFORCED.has(action)) {
          return deny(`${appId} does not declare '${action}' in app.manifest.json permissions[] (aura grant perms ${appId} ${action})`);
        }
        return allow(`'${action}' is not enforced yet (MVP auto-grant)`);
      }
    }
    return deny('unknown principal');
  }
}
