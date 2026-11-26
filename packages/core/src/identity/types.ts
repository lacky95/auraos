/**
 * Linux identities (D70, D84): the contract stream I implements.
 *
 * One authoritative, transactional registry hands out logical uid/gid pairs
 * from fixed ranges and never reuses one (a tombstone per uid is kept
 * forever). Logical ids are independent of host ids: a runtime maps them to
 * its effective ids (`--user`, a user namespace, subuid, or emulation) and
 * reports how in `RuntimeCapabilities.identity`.
 *
 * Phase 5 Stage 1 defines the shapes only. Nothing allocates yet: every
 * process still runs as root (`ROOT_SPAWN_IDENTITY`) until streams I and A.
 */

/**
 * The logical id ranges (owner-confirmed D84, 2026-11-26). The allocator takes
 * its ranges from this table, never from constants of its own, so a new kind
 * is a new row and no existing assignment moves.
 */
export const LINUX_ID_RANGES = {
  /** The owner, fixed (D70): `node` in the base image, the host user. */
  owner: { first: 1000, last: 1000 },
  /** Other human users (D82 member accounts). */
  user: { first: 100_000, last: 199_999 },
  /** App identities, one per installation (P5-3). */
  app: { first: 200_000, last: 299_999 },
  /** Reserved for ARI runtimes (subuid maps). No allocator state in Phase 5. */
  ari: { first: 300_000, last: 399_999 },
  /** Reserved for future non-human principals (D84). No allocator state in Phase 5. */
  principal: { first: 400_000, last: 499_999 },
} as const satisfies Record<string, { first: number; last: number }>;

export type LinuxIdRange = keyof typeof LINUX_ID_RANGES;
/** The ranges stream I allocates from in Phase 5. */
export type AllocatedLinuxIdRange = 'user' | 'app';

export const OWNER_UID = LINUX_ID_RANGES.owner.first;
export const OWNER_GID = OWNER_UID;

/** Which range a logical uid belongs to; null outside every range (e.g. 0). */
export function linuxIdRangeOf(uid: number): LinuxIdRange | null {
  for (const [name, r] of Object.entries(LINUX_ID_RANGES) as Array<[LinuxIdRange, { first: number; last: number }]>) {
    if (uid >= r.first && uid <= r.last) return name;
  }
  return null;
}

/** A logical uid/gid pair. */
export interface LinuxIdentity {
  uid: number;
  gid: number;
}

export type LinuxIdentityState = 'active' | 'retired';

/** `ident:linux:user:<userId>` (stream I). */
export interface UserIdentityRecord extends LinuxIdentity {
  userId: string;
  allocatedAt: string;
  state: LinuxIdentityState;
}

/** `ident:linux:app:<installationId>` (stream I). Keyed by installation, never by instance (D85 A7). */
export interface AppIdentityRecord extends LinuxIdentity {
  installationId: string;
  appId: string;
  allocatedAt: string;
  state: LinuxIdentityState;
}

/**
 * `ident:linux:uid:<uid>`: the tombstone, a generic principal ref without a
 * system (`<kind>:<id>`, see `formatPrincipalRef`). The kind is an open
 * string, so a later principal kind (D84) needs no schema change.
 */
export type UidTombstone = string;

/** `/data/aura/identity/hwm.json`: the high-water marks that survive a Valkey restore. */
export interface IdentityHighWaterMark {
  user: number;
  app: number;
}

/**
 * A generic principal reference (D47, D84): `kind:id`, qualified as
 * `kind:id@systemId` once it leaves its system. `kind` is open (`user`, `app`,
 * later `agent`); `id` never contains `@` (grant ids stay local, D85 A3).
 * Absent `systemId` means the local system.
 */
export interface PrincipalRef {
  kind: string;
  id: string;
  systemId?: string;
}

const REF_KIND = /^[a-z][a-zA-Z0-9-]*$/;

export function formatPrincipalRef(ref: PrincipalRef): string {
  if (!REF_KIND.test(ref.kind)) throw new Error(`invalid principal kind '${ref.kind}'`);
  if (!ref.id || ref.id.includes('@')) throw new Error(`invalid principal id '${ref.id}'`);
  if (ref.systemId !== undefined && (!ref.systemId || /[@:]/.test(ref.systemId))) throw new Error(`invalid systemId '${ref.systemId}'`);
  return `${ref.kind}:${ref.id}${ref.systemId !== undefined ? `@${ref.systemId}` : ''}`;
}

/** Inverse of `formatPrincipalRef`; null for anything it would not produce. */
export function parsePrincipalRef(text: string): PrincipalRef | null {
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const kind = text.slice(0, colon);
  let id = text.slice(colon + 1);
  let systemId: string | undefined;
  const at = id.indexOf('@');
  if (at >= 0) {
    systemId = id.slice(at + 1);
    id = id.slice(0, at);
  }
  try {
    const ref: PrincipalRef = systemId !== undefined ? { kind, id, systemId } : { kind, id };
    formatPrincipalRef(ref);
    return ref;
  } catch {
    return null;
  }
}

/**
 * The identity a process is spawned with, as the kernel decided it (ARI §2.2
 * `RuntimeIdentity`). `range: 'root'` is today's behaviour, every process as
 * uid 0, kept until stream A flips an installation to `runAs: app`.
 */
export interface SpawnIdentity extends LinuxIdentity {
  range: AllocatedLinuxIdRange | 'owner' | 'root';
  /** The user the process acts for, when it acts for one. */
  userId?: string;
}

export const ROOT_SPAWN_IDENTITY: Readonly<SpawnIdentity> = Object.freeze({ uid: 0, gid: 0, range: 'root' as const });

/** What the spawn seam asks the identity provider (stream I/A implement it). */
export interface SpawnIdentityRequest {
  appId: string;
  /** Null until the spawn seam resolves installations (stream H/A). */
  installationId: string | null;
  userId?: string;
}

export interface SpawnIdentityProvider {
  identityFor(req: SpawnIdentityRequest): Promise<SpawnIdentity>;
}

/** Today's behaviour: every app process is root. */
export const ROOT_IDENTITY_PROVIDER: SpawnIdentityProvider = {
  identityFor: async () => ({ ...ROOT_SPAWN_IDENTITY }),
};
