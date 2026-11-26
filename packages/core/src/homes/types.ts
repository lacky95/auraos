/**
 * Home Resolver contract (D65, D67, D72, D74, D79; Phase 5 stream H).
 *
 * The kernel decides which directory a process sees as `/home/aura`; a
 * runtime only mounts the `ResolvedHome` it is handed and never computes a
 * home path itself (ARI §2.2, §9.4). The kernel resolver is
 * `kernelHomeResolver` (HomeResolver.ts); streams J (jump) and T (Terminal
 * sessions) call the same `resolve` with their execution context.
 */
import type { RuntimeCapabilities } from '../runtimes/types.js';
import type { LinuxIdentity } from '../identity/types.js';

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
  /**
   * `application`, `sidecar`: the instance's owner (a `user`-scope App Home is
   * theirs). `jump`, `terminal-session`: the session's user, which must be
   * the principal's own id. Required for `user` scope and every session.
   */
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
  /**
   * The identity the installation's processes run as (P5-3): the app uid for
   * `runAs: app`, `0:0` for root. It owns the App Home; for `jump` and
   * `terminal-session` it is the running target instance's identity (a
   * `private` or `ephemeral` jump into a root instance is refused, J.5).
   */
  appIdentity: LinuxIdentity | null;
  /** A preview instance (Track P): its own App Home per user, never the installed app's. */
  preview?: boolean;
}

export interface ResolvedHome {
  kind: HomeKind;
  /** Shell view, e.g. `/data/aura/apphomes/<installationId>/global`; null for `ephemeral` (tmpfs). */
  hostPath: string | null;
  /** Docker `volume-subpath` inside the app-data volume; null for `ephemeral` (tmpfs). */
  volumeSubpath: string | null;
  logicalPath: typeof LOGICAL_HOME_PATH;
  /** The owner and mode the directory is created with (and should have: `diagnose/home-layout`). */
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
  | 'root-instance'
  /** The owner's Linux identity is not allocated: nothing is created under a guessed uid. */
  | 'identity-unresolved'
  /** The home path exists but is a symbolic link or not a directory: never followed, never used. */
  | 'home-unsafe';

export class HomeDeniedError extends Error {
  override readonly name = 'HomeDeniedError';
  constructor(readonly reason: HomeDeniedReason, message: string) {
    super(message);
  }
}
