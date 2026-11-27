/**
 * The D94 infrastructure configuration contracts: FROZEN (Phase 6 Stage 1b, 6B.0).
 *
 * The implementation is dependency-free and lives in `os/infra/` (IC-1, IC-3, IC-4: install.sh,
 * os/boot.sh and the release builder need it before any core exists): `config.mjs` (schema,
 * validator), `store.mjs` (`aura/infra/config.yaml`), `render.mjs` (`aura/infra/generated/<digest>/`
 * with the atomic `current` link), `secrets.mjs`, `adapters/`. These are its typed shapes for the
 * kernel, the builder (B), the updater (U), the installer (I) and the propagation (IC-5,
 * `./propagate.ts`). `test/release-contracts.test.mjs` compares the constants with os/infra.
 *
 * A leaf: no core module imports.
 */

export const INFRA_CONFIG_VERSION = 1;
export const RENDER_VERSION = 1;
/** The store under the data root (os/infra/store.mjs `infraDir`). */
export const INFRA_DIR = 'aura/infra';
/** The rendered dir of the stored config: `generated/<sha256 hex>/`, `current` links to it. */
export const INFRA_GENERATED_DIR = `${INFRA_DIR}/generated`;
export const INFRA_CURRENT_LINK = `${INFRA_GENERATED_DIR}/current`;
/** Where consumers see the rendered dir (read-only mount; os/infra/adapters `INFRA_ROOT`). */
export const INFRA_ROOT = '/etc/aura/infra';
/**
 * BuildKit secret ids the Dockerfile consumes (os/infra/adapters `BUILD_SECRET_IDS`). `infra_mtls`
 * (IC-8) holds every install-time client key in one secret: a Dockerfile can mount fixed ids only.
 */
export const BUILD_SECRET_IDS = ['infra_apt_auth', 'infra_git', 'infra_mtls', 'infra_npm_basic', 'infra_npmrc', 'infra_proxy', 'infra_proxy_http'] as const;
export type BuildSecretId = (typeof BUILD_SECRET_IDS)[number];

// ── the config (version 1, D94 §4.2) ────────────────────────────────────────

/** Secrets never live in the config: only a reference (D94 §4.3). */
export type InfraCredentialRef = `bootstrap:${string}` | `system:${string}`;
export interface InfraRef { ref: InfraCredentialRef }

export interface InfraConfig {
  version: 1;
  network?: {
    proxy?: { http?: string; https?: string; noProxy?: string[]; credential?: InfraRef };
    dns?: 'host' | 'default' | string[] | { servers?: string[]; search?: string[] };
  };
  trust?: {
    caCertificates?: Array<{ name: string; file: string }>;
    publicRoots?: 'keep' | 'replace';
  };
  clientCertificates?: Array<{ name: string; hosts: string[]; certificate: { file: string }; key: InfraRef; identity?: 'system' }>;
  registries?: {
    npm?: { url: string; scopes?: Record<string, string>; credential?: InfraRef };
    python?: { index: string; credential?: InfraRef };
    apt?: { mirrors: Record<string, string>; credential?: InfraRef };
    oci?: { mirrors?: Record<string, string>; credentials?: Record<string, InfraRef> };
    git?: { rewrites?: Record<string, string>; credential?: InfraRef };
    artifacts?: { rewrites?: Record<string, string> };
  };
  /** AuraOS's own default endpoints (philosophy audit #7); a missing key keeps the built-in public default. */
  endpoints?: Partial<InfraEndpoints>;
  /** A seed for the D64 `infra-*` options only (O2); not kept after the first-boot import. */
  policy?: { publicFallback?: 'allow' | 'deny'; proxy?: 'off' | 'configured' };
}

/** The official store and the GitHub it lives on (`generated/current/endpoints.json` over the built-in defaults). */
export interface InfraEndpoints {
  /** The official Nexus store's `index.yaml`. */
  nexusIndex: string;
  /** `owner/repo` behind it (where `aura nexus app submit` opens its pull request). */
  nexusStoreRepo: string;
  /** GitHub's web base (fork and pull-request URLs). */
  github: string;
  /** GitHub's REST API base (GitHub Enterprise: `https://<host>/api/v3`). */
  githubApi: string;
}

/** A validator finding: a field path and plain words, never a value. */
export interface InfraConfigIssue { path: string; message: string }

// ── the rendered dir (render.mjs) ───────────────────────────────────────────

/** `generated/<digest>/manifest.json`: non-secret by construction. */
export interface InfraRenderManifest {
  v: 1;
  /** `sha256:<hex>`; the directory name is the hex. */
  digest: string;
  /** Non-secret env (proxy without credentials, NO_PROXY, CA and config file paths). */
  env: Record<string, string>;
  /** System paths the rendered files replace or extend, by adapter. */
  systemPaths: Record<string, string>;
  files: string[];
}

/**
 * `status.json.infra` (IC-5, IC-7): what the kernel applied at boot step 0, in categories, never a
 * value. `none` = no configuration (today's behaviour); `degraded` names what is not applied.
 */
export interface InfraBootStatus {
  configured: boolean;
  /** `sha256:<hex>` of the rendered dir, or null. */
  digest: string | null;
  state: 'none' | 'ok' | 'degraded' | 'failed';
  /** Corporate CAs in the shell's trust (0 without). */
  corporateCas: number;
  proxy: 'off' | 'configured';
  /** The kernel's own outbound requests (fetch) go through the configured proxy. */
  kernelProxy: boolean;
  /** A change the running shell cannot take without `aura restart os`. */
  restartRequired: boolean;
  /** Plain words, no values. */
  issues: string[];
  appliedAt: string | null;
  /** No `bootstrap:` ref is left in the config (install.sh deletes its copies then, O3). Absent before the seed step. */
  credentialsImported?: boolean;
}

// ── propagation (IC-5, ./propagate.ts) ──────────────────────────────────────

/**
 * What one workload start gets of the infrastructure config (`SpawnContext.infra`): plain data the
 * kernel resolved (the rendered dir and D64 `infra-inherit`), turned into argv by the runtimes
 * (runtimes/spawn/infraArgs.ts). Absent = nothing (no config, or `infra-inherit=none`).
 */
export interface InfraSpawnView {
  digest: string;
  /** The rendered dir under the data root (`aura/infra/generated/<hex>`): a volume subpath for containers. */
  subpath: string;
  /** The non-secret env (proxy without credentials, NO_PROXY, CA and config pointers). */
  env: Record<string, string>;
}

/** Who an environment is for: each consumer gets the non-secret layer; secrets only per operation. */
export type InfraConsumer =
  | 'kernel' | 'release-build' | 'updater' | 'installer' | 'cap-installer' | 'nexus' | 'app' | 'sidecar' | 'terminal';

/** The D94 inputs of a release build (os/release/builder.mjs `infraInputs`, the `--infra FILE` JSON). */
export interface BuildInfraInputs {
  digest: string | null;
  buildArgs: Record<string, string>;
  env: Record<string, string>;
  /** BuildKit secret id → a 0400 file for this one build (never args, env or layers). */
  secrets: Partial<Record<BuildSecretId, string>>;
  publicContext: string | null;
  caBundle: string | null;
  gitConfig: string | null;
}

/** Secret files rendered for one build; `dispose()` removes them (in a `finally`). */
export interface BuildSecrets {
  secrets: Partial<Record<BuildSecretId, string>>;
  dispose(): Promise<void>;
}
