/**
 * Home Resolver contract (D65, D67, D72, D74; Phase 5 stream H).
 *
 * The kernel decides which directory a process sees as `/home/aura`; a
 * runtime only mounts the `ResolvedHome` it is handed and never computes a
 * home path itself (ARI §2.2, §9.4). Stage 1 defines the contract and a
 * legacy resolver that reproduces today: every app process gets the one user
 * home. Stream H replaces the implementation behind the spawn seam.
 */
import type { RuntimeCapabilities } from '../runtimes/types.js';

/** Per app (D65, Q21/D72): one App Home for everyone, or one per user. */
export type EnvironmentScope = 'global' | 'user';
/** `aura jump --home` (D67, D74, D79). */
export type JumpHomeMode = 'private' | 'app' | 'ephemeral';
export type ExecutionContext = 'application' | 'sidecar' | 'jump' | 'terminal-session';
export type HomeKind = 'app-global' | 'app-user' | 'private' | 'ephemeral';

export const LOGICAL_HOME_PATH = '/home/aura' as const;

export interface HomeRequest {
  /**
   * The installation the process belongs to. Null only while the spawn seam
   * does not resolve installations yet (Stage 1): the legacy resolver ignores
   * it, and stream H's resolver fails closed on null.
   */
  installationId: string | null;
  /** Required for `user` scope, `jump` and `terminal-session`. */
  userId?: string;
  environmentScope: EnvironmentScope;
  executionContext: ExecutionContext;
  /** `jump` only; default `private`. */
  jumpHomeMode?: JumpHomeMode;
  /**
   * The verified caller, required only for `jump` and `terminal-session`.
   * Private Homes are human-user only (D84): `application` and `sidecar`
   * never carry a principal and never get `private`.
   */
  principal?: { userId: string; role: 'owner' | 'member' };
  /** The target runtime's capabilities: a miss fails closed, never downgrades. */
  runtime: RuntimeCapabilities;
}

export interface ResolvedHome {
  kind: HomeKind;
  /** Shell view, e.g. `/data/aura/apphomes/<installationId>/global`. */
  hostPath: string;
  /** Docker `volume-subpath` inside the app-data volume; null for `ephemeral` (tmpfs). */
  volumeSubpath: string | null;
  logicalPath: typeof LOGICAL_HOME_PATH;
  /** Owner and mode of the directory. */
  uid: number;
  gid: number;
  mode: number;
}

export interface HomeResolver {
  /** Throws `HomeDeniedError` or `RuntimeCapabilityError`; never downgrades. */
  resolve(req: HomeRequest): Promise<ResolvedHome>;
}

export type HomeDeniedReason =
  | 'installation-unresolved'
  | 'private-home-not-allowed'
  | 'not-authorized'
  | 'user-required'
  | 'root-instance';

export class HomeDeniedError extends Error {
  override readonly name = 'HomeDeniedError';
  constructor(readonly reason: HomeDeniedReason, message: string) {
    super(message);
  }
}
