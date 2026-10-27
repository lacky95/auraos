/**
 * Authorizer — the ONE place that decides "may this principal do that".
 *
 *   authorize(principal, action, resource?) → { allow, reason }
 *
 * Rules:
 *   system     everything (in-process `SYSTEM_PRINCIPAL` only, by identity)
 *   admin      management actions (`admin.*`) only — an admin session is not
 *              a sender and has no app permissions
 *   instance   the app's manifest-declared permissions (strict for
 *              ENFORCED ones, MVP auto-grant for the rest, as PermissionManager),
 *              PLUS an admin grant (GrantStore) for privileged ones
 *              (notifications.locked / .popup / .read / .systemModal). A grant only counts
 *              while the app still resolves to the install scope it was given for.
 *              `readGrant()` returns the SCOPE of a `notifications.read` grant.
 *   apiKey     its scopes (fixed by the admin at creation) or a GrantStore
 *              grant to the key; nothing else
 *   anonymous  phase-1 compatibility: basic sending only (an unverified Simple
 *              notification); never privileged, never admin
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
import { GrantStore, NOTIFICATIONS_READ_PERMISSION, isPrivilegedPermission, canonicalPermission } from './GrantStore.js';
import type { ReadGrant } from '../notifications/access.js';
import {
  isSystemPrincipal, type DeclaredActor, type GrantSubject, type Principal,
} from './types.js';

export const BASIC_NOTIFICATION_PERMISSION = 'system.notifications';

/** Management actions an admin session may perform. */
export const ADMIN_ACTIONS = [
  'admin.session', 'admin.grants', 'admin.apiKeys', 'admin.audit', 'admin.manifest', 'admin.apps',
] as const;
export type AdminAction = typeof ADMIN_ACTIONS[number];

export interface AuthzDecision {
  allow: boolean;
  /** Human-readable, safe to return to the caller. */
  reason: string;
}

export interface AuthorizerDeps {
  grants: GrantStore;
  /** The app's manifest permissions[] (undefined: unknown app). */
  declared(appId: string): string[] | undefined;
  /** The install scope the app id currently resolves to (system|global|user). */
  appScope(appId: string): string | undefined;
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

    const isAdminAction = action.startsWith('admin.');
    if (principal.kind === 'admin') {
      return isAdminAction
        ? allow('admin session (shared credential)')
        : deny(`an admin session manages grants and keys; it has no '${action}' permission itself`);
    }
    if (isAdminAction) return deny('admin session required — unlock admin first');

    switch (principal.kind) {
      case 'anonymous':
        if (action === BASIC_NOTIFICATION_PERMISSION) return allow('unverified caller: basic Simple notifications only (phase-1 compatibility)');
        return deny(`'${action}' needs a verified caller (Authorization: Bearer $AURA_INSTANCE_TOKEN or an API key) and an admin grant`);

      case 'apiKey': {
        if (principal.scopes.includes(action)) return allow(`API key '${principal.name}' has scope '${action}'`);
        if (isPrivilegedPermission(action) && await this.deps.grants.get({ kind: 'apiKey', id: principal.keyId }, action)) {
          return allow(`granted to API key '${principal.name}' by an admin`);
        }
        return deny(`API key '${principal.name}' has no scope '${action}'`);
      }

      case 'instance': {
        const appId = principal.appId;
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
          if (!g) return deny(`'${action}' is requested by ${appId} but not granted — an admin must grant it (aura grant notif-perms ${appId} ${action.split('.')[1]})`);
          const scope = this.deps.appScope(appId);
          if (g.appScope && scope && g.appScope !== scope) {
            return deny(`'${action}' was granted to ${appId} in scope '${g.appScope}', but the app now resolves to scope '${scope}' — grant it again`);
          }
          return allow(`requested by ${appId} and granted by an admin`);
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
