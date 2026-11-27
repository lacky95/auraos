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
/** BuildKit secret ids the Dockerfile consumes (os/infra/adapters `BUILD_SECRET_IDS`), plus `infra_mtls_<name>_key` (IC-8). */
export const BUILD_SECRET_IDS = ['infra_apt_auth', 'infra_git', 'infra_npm_basic', 'infra_npmrc', 'infra_proxy', 'infra_proxy_http'] as const;
export type BuildSecretId = (typeof BUILD_SECRET_IDS)[number] | `infra_mtls_${string}_key`;

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
  /** A seed for the D64 `infra-*` options only (O2); not kept after the first-boot import. */
  policy?: { publicFallback?: 'allow' | 'deny'; proxy?: 'off' | 'configured' };
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

// ── propagation (IC-5, ./propagate.ts) ──────────────────────────────────────

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
