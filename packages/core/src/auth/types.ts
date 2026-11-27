/**
 * AuraOS central authentication / authorization — principal model.
 *
 * Identity (WHO is calling: a `Principal`) is kept apart from permissions
 * (WHAT it may do: `Authorizer` + `GrantStore`). The shell turns a request
 * into a Principal (`packages/shell/src/lib/auth.ts`); everything that
 * decides goes through `Authorizer.authorize()`.
 *
 *   instance   verified AURA_INSTANCE_TOKEN (an app backend or OS sidecar) or a
 *              signed App Host gateway claim; `userId` when it acts for a user
 *   apiKey     verified owner-issued API key (`aura_k1_…`), external REST
 *   user       a logged-in human: a verified login session (cookie or
 *              `aura-sess1.` bearer), or that session acting through an app
 *              (an App Host cookie, or a trusted system UI's claim, D45)
 *   anonymous  no credentials; referer / instance-id headers are hints only
 *   system     in-process only — the frozen `SYSTEM_PRINCIPAL`, by identity
 *
 * Phase 3 Stage 0 resolves `user`, and `instance` acting for a user, and only
 * reports them: routes still act on what they acted on before.
 *
 * Typed for the access policy only:
 *   operator   the host operator (a one-time ticket, shell `identify.ts`)
 *
 * The shared admin credential and its sessions are gone (D50): the owner
 * manages grants and keys, and the host operator stands above the owner.
 *
 * Reserved for later (delegation), NOT implemented:
 *   agent      a verified agent identity acting for a principal
 *
 * `actor` is a self-declared display name (e.g. the MCP agent's name). It is
 * metadata for display and audit ONLY, always `unverified`, and never changes
 * an authorization result (see `Authorizer`, delegation hook).
 */
import type {
  AnonymousCaller, ApiKeyCaller, InstanceCaller, SystemCaller,
} from '../notifications/types.js';
import { SYSTEM_CALLER } from '../notifications/types.js';

export type Verification = 'verified' | 'unverified' | 'internal';

/** A self-declared, unverified display actor (delegation metadata). */
export interface DeclaredActor {
  name: string;
  verification: 'unverified';
}

interface WithActor { actor?: DeclaredActor }

/**
 * The Aura a principal belongs to (D47, `userId@systemId`). The shell's
 * resolver sets it to the local `systemId` (system/systemIdentity.ts); absent
 * still means this system, for principals built elsewhere.
 */
interface WithSystem { systemId?: string }

/**
 * An app instance or OS sidecar. `userId` is the user it acts for (5.8), from
 * a verified source only: the instance token's `u` claim, the instance's
 * server-side owner, or the gateway claim of an App Host session.
 */
export type InstancePrincipal = InstanceCaller & WithActor & WithSystem & {
  userId?: string;
  /**
   * D85 A9: which spawn of the instance this is (InstanceTokens `lifetimeId`,
   * a hash of the per-spawn nonce), when the resolver could read it. Instance
   * ids are reused, so a record that must not reach the next instance with
   * the same id (an approval) binds this as well.
   */
  lifetime?: string;
};
export type ApiKeyPrincipal = ApiKeyCaller & WithActor & {
  /** The key's scopes (permission names), fixed by the owner at creation. */
  scopes: string[];
};
export type AnonymousPrincipal = AnonymousCaller & WithActor;
export type SystemPrincipal = SystemCaller;

/**
 * From the verified user record (D82, I.2), never from the session or a
 * claim: one `owner` (break-glass, D5/D16) and `member` accounts. A member
 * holds no `owner` level and acts only through its own grants.
 */
export type UserRole = 'owner' | 'member';

/** A logged-in human, verified from a live login session. */
export type UserPrincipal = WithActor & WithSystem & {
  kind: 'user';
  userId: string;
  role: UserRole;
  sessionId: string;
  verification: 'verified';
  /**
   * The app this human acts through: a trusted system UI (D45, from a signed
   * gateway claim), or any app whose App Host cookie carried the session.
   * Audit records it next to the user. No `instanceId` while the App Host
   * slot has no running instance.
   */
  through?: { appId: string; instanceId?: string };
};

export type Principal =
  | InstancePrincipal
  | ApiKeyPrincipal
  | UserPrincipal
  | AnonymousPrincipal
  | SystemPrincipal;

/** Kinds reserved for delegation and registered non-human principals (D84). Not produced anywhere yet. */
export type ReservedPrincipalKind = 'agent';

/** The host operator, from a one-time ticket for exactly one request (shell `identify.ts`). */
export interface OperatorPrincipal {
  kind: 'operator';
  verification: 'verified';
}

/** What the access policy can be asked about. `Authorizer` still takes `Principal`. */
export type AccessPrincipal = Principal | OperatorPrincipal;
export type PrincipalClass = AccessPrincipal['kind'];

/**
 * The ONLY system principal: the same frozen object as notifications'
 * `SYSTEM_CALLER`, checked by object identity.
 */
export const SYSTEM_PRINCIPAL: SystemPrincipal = SYSTEM_CALLER;

export function isSystemPrincipal(p: AccessPrincipal): p is SystemPrincipal {
  return p === SYSTEM_PRINCIPAL;
}

/**
 * Subjects a grant can be given to. `user` is a local user id (D82, I.2), for
 * the app permissions `app.use:<installationId>` and `app.jump:<installationId>`
 * only. Ids never contain `@`: a qualified subject is a federation change
 * (D85 A3), see `ReservedGrantSubject`.
 */
export type GrantSubjectKind = 'app' | 'apiKey' | 'user';
export interface GrantSubject {
  kind: GrantSubjectKind;
  id: string;
}

/**
 * Reserved for federation (D47), types only: nothing grants to them in the
 * alpha, and `GrantStore` takes only `GrantSubject`. A remote Aura as a whole,
 * and a user named by a qualified reference (`userId@systemId`).
 */
export type ReservedGrantSubject =
  | { kind: 'system'; systemId: string }
  | { kind: 'user'; userId: string; systemId: string }
  /** D84: an explicitly registered agent or service identity. Types only: no registration exists. */
  | { kind: 'agent'; id: string }
  | { kind: 'service'; id: string };

/**
 * Reserved (D83), types only in Phase 5: nothing stores or reads it. The
 * future authoritative link from an external identity provider account to a
 * local user. Key: `ident:ext:<sha256(issuer + "\0" + subject)>`. Never keyed
 * by email or a display name; claims never choose `userId`, a uid or a home.
 */
export interface ExternalIdentityLink {
  v: 1;
  /** OIDC `iss`, exact string match. */
  issuer: string;
  /** OIDC `sub`: opaque and stable per provider. */
  subject: string;
  /** The internal Aura user; never derived from claims. */
  userId: string;
  linkedAt: number;
  linkedBy: ChangeAttribution;
  state: 'active' | 'suspended';
}

/**
 * Where a grant applies. Every grant today is OS-wide (one owner, no other
 * users). Multi-user adds e.g. `{ kind: 'user', userId }` without changing
 * the subject or the permission.
 */
export type GrantScope =
  | { kind: 'os' }
  /** One Terminal session (`<instanceId>#<label>`), for `terminal.embed` only (D25). */
  | { kind: 'terminal-session'; id: string }
  /** One user (D56): a `credential.read:<NAME>` grant reads that user's vault entry only. */
  | { kind: 'user'; id: string };

/**
 * What an app grant counts for now (S1, 5-main): the install scope the app id
 * resolves to and that scope's installation (null: none). A grant counts only
 * for the installation it was given to (`GrantStore.appGrantCounts`), so a
 * new app under the same id (delete and recreate, a different-origin
 * reinstall, a replaced origin) inherits nothing.
 */
export interface AppGrantBinding {
  scope: string | undefined;
  installationId: string | null;
}

/** Reserved scopes for federation (D47), types only, like `ReservedGrantSubject`. */
export type ReservedGrantScope = { kind: 'system'; systemId: string };
export const OS_SCOPE: GrantScope = Object.freeze({ kind: 'os' as const });

/**
 * Who made a change, as a grant, an API key or the audit trail records it
 * (D50): the owner, or the host operator above the owner. A change an app
 * asked for and the owner approved names the owner who approved it.
 */
export interface UserAttribution {
  kind: 'user';
  userId: string;
  /** Short prefix of the session id. */
  session?: string;
}
export interface OperatorAttribution { kind: 'operator' }
export type ChangeAttribution = UserAttribution | OperatorAttribution;

/**
 * A record written before D50 by the retired shared admin credential. Read
 * only: nothing writes it any more.
 */
export interface LegacyAdminAttribution { kind: 'admin'; label?: string; session?: string }
