import type { AppManifest } from '../types/manifest.js';
import type { ResolvedHome } from '../homes/types.js';
import type { SpawnIdentity } from '../identity/types.js';
import type { InfraSpawnView } from '../infra/types.js';

export type ScopeId = 'system' | 'global' | 'user';

export interface ScopeDefinition {
  id:        ScopeId;
  appsDir:   string;
  dataDir:   string;
  immutable: boolean;
  priority:  0 | 1 | 2;
}

/** In-memory only — NOT persisted to app.manifest.json. */
export interface ScopedManifest extends AppManifest {
  scopeId: ScopeId;
  /** Absolute path: <scope.appsDir>/<appId> */
  appDir:  string;
}

/** Passed to runner.spawn() so scope-aware paths flow from AppManager. */
export interface SpawnContext {
  /** Absolute path: <scope.appsDir>/<appId> */
  appDir:          string;
  /** Absolute path: <scope.dataDir>/apps/<appId>/<instanceId> */
  instanceDataDir: string;
  /**
   * The workload token (D89; mandatory since 5b): the bearer token for the
   * token-gated OS routes (see InstanceTokens), minted by the kernel on every
   * spawn and injected by every runtime as AURA_INSTANCE_TOKEN; its nonce is
   * recorded on the container (`aura.token.nonce`) so it survives a shell
   * restart. A workload without it is anonymous, never identified by address.
   */
  instanceToken: { token: string; nonce: string };
  /**
   * The app's effective source mode (nexus/AppSource.ts). A closed agent
   * workspace gets its own source read-only (ContainerRunner). Absent: open.
   */
  sourceMode?: 'closed' | 'open';
  /** A preview instance (Track P): `appDir` is this workspace (relative to dataDir); labelled on the container. */
  preview?: string;
  /**
   * Phase 5 (ARI §9.4): what the kernel decided, from AppManager's
   * `spawnContext` seam. Runners ignore these until their stream lands
   * (home: H, identity: A, env: the kernel-built app env) and keep computing
   * today's values; the golden spawn-args test pins that.
   */
  home?: ResolvedHome;
  identity?: SpawnIdentity;
  env?: Record<string, string>;
  /** The app's installation (names its account in the generated passwd, stream A). */
  installationId?: string;
  /**
   * Stream C (Q7): the Context keys this start may see, as the kernel
   * resolved them: declared in `context[]` AND granted, from the instance
   * user's vault first, then the system Context (context/grantedContext.ts).
   * Runners put exactly these into the env; absent means none.
   */
  contextEnv?: Record<string, string>;
  /**
   * D94 IC-5: the non-secret infrastructure defaults for this start (the rendered config, when
   * D64 `infra-inherit` is `defaults`); runtimes/spawn/infraArgs.ts turns it into argv. Absent = none.
   */
  infra?: InfraSpawnView;
}
