/**
 * AuraOS central authentication / authorization — principal model.
 *
 * Identity (WHO is calling: a `Principal`) is kept apart from permissions
 * (WHAT it may do: `Authorizer` + `GrantStore`). The shell turns a request
 * into a Principal (`packages/shell/src/lib/auth.ts`); everything that
 * decides goes through `Authorizer.authorize()`.
 *
 *   instance   verified AURA_INSTANCE_TOKEN (an app backend or OS sidecar)
 *   apiKey     verified admin-issued API key (`aura_k1_…`), external REST
 *   admin      verified admin session (`aura-admin1.…`) unlocked with the
 *              SHARED operator credential. It is never an individual user.
 *   anonymous  no credentials; referer / instance-id headers are hints only
 *   system     in-process only — the frozen `SYSTEM_PRINCIPAL`, by identity
 *
 * Typed for the access policy, NOT returned by `authenticate()` yet:
 *   user       a logged-in human account
 *   operator   the host operator, in access reports only
 *
 * Reserved for later (delegation), NOT implemented:
 *   agent      a verified agent identity acting for a principal
 *
 * `actor` is a self-declared display name (e.g. the MCP agent's name). It is
 * metadata for display and audit ONLY, always `unverified`, and never changes
 * an authorization result (see `Authorizer`, delegation hook).
 */
import type {
  AdminCaller, AnonymousCaller, ApiKeyCaller, InstanceCaller, SystemCaller,
} from '../notifications/types.js';
import { SYSTEM_CALLER } from '../notifications/types.js';

export type Verification = 'verified' | 'unverified' | 'internal';

/** A self-declared, unverified display actor (delegation metadata). */
export interface DeclaredActor {
  name: string;
  verification: 'unverified';
}

interface WithActor { actor?: DeclaredActor }

export type InstancePrincipal = InstanceCaller & WithActor;
export type ApiKeyPrincipal = ApiKeyCaller & WithActor & {
  /** The key's scopes (permission names), fixed by the admin at creation. */
  scopes: string[];
};
/**
 * Holder of a valid admin session. Management actions only. `credential` is
 * always `'shared'` — the one operator credential; there are no user accounts yet.
 */
export type AdminPrincipal = AdminCaller & WithActor;
export type AnonymousPrincipal = AnonymousCaller & WithActor;
export type SystemPrincipal = SystemCaller;

export type Principal =
  | InstancePrincipal
  | ApiKeyPrincipal
  | AdminPrincipal
  | AnonymousPrincipal
  | SystemPrincipal;

/** Kinds reserved for multi-user / delegation. Not produced anywhere yet. */
export type ReservedPrincipalKind = 'user' | 'agent';

export type UserRole = 'owner';

/** A logged-in human. Outside `Principal` until `authenticate()` produces it. */
export type UserPrincipal = WithActor & {
  kind: 'user';
  userId: string;
  role: UserRole;
  sessionId: string;
  verification: 'verified';
};

/** The host operator, as a report-level class. It never authenticates a request. */
export interface OperatorPrincipal {
  kind: 'operator';
  verification: 'verified';
}

/** What the access policy can be asked about. `Authorizer` still takes `Principal`. */
export type AccessPrincipal = Principal | UserPrincipal | OperatorPrincipal;
export type PrincipalClass = AccessPrincipal['kind'];

/**
 * The ONLY system principal: the same frozen object as notifications'
 * `SYSTEM_CALLER`, checked by object identity.
 */
export const SYSTEM_PRINCIPAL: SystemPrincipal = SYSTEM_CALLER;

export function isSystemPrincipal(p: AccessPrincipal): p is SystemPrincipal {
  return p === SYSTEM_PRINCIPAL;
}

/** How every admin change is attributed. Never an individual user. */
export const ADMIN_AUDIT_LABEL = 'admin (shared credential)';

/** Subjects a grant can be given to. `user` / `agent` come with multi-user. */
export type GrantSubjectKind = 'app' | 'apiKey';
export interface GrantSubject {
  kind: GrantSubjectKind;
  id: string;
}

/**
 * Where a grant applies. Every grant today is OS-wide (one shared admin, no
 * users). Multi-user adds e.g. `{ kind: 'user', userId }` without changing
 * the subject or the permission.
 */
export type GrantScope = { kind: 'os' };
export const OS_SCOPE: GrantScope = Object.freeze({ kind: 'os' }) as GrantScope;

/** Admin attribution stored with a grant / key / audit entry. */
export interface AdminAttribution {
  kind: 'admin';
  credential: 'shared';
  label: typeof ADMIN_AUDIT_LABEL;
  /** Short prefix of the session id (not secret: the token also needs the HMAC). */
  session?: string;
}

export function adminAttribution(p?: AdminPrincipal): AdminAttribution {
  return {
    kind: 'admin', credential: 'shared', label: ADMIN_AUDIT_LABEL,
    ...(p ? { session: p.sessionId.slice(0, 8) } : {}),
  };
}
