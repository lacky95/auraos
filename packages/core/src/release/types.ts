/**
 * The release contracts: FROZEN (Phase 6 Stage 1b, 6B.0). Every Phase 6b stream (B builder,
 * L Normal runtime, O overlay, U updates, S signing, I installer) and Phase 7 (system patches)
 * builds against these shapes; changing one is a contract change: coordinate with all of them.
 *
 * The shapes are the ones the dependency-free side already writes and reads:
 *   release.json v1          os/release/builder.mjs (stream B, `RELEASE_RECORD_VERSION`)
 *   release-meta.json v1     os/release-verify.mjs (stream S; + the detached release-meta.sig)
 *   pointer.json v1          builder.mjs `writeFirstPointer`; stream U switches it
 *   source.json v1           install.sh / os/install/installer.mjs (stream I)
 * `test/release-contracts.test.mjs` compares the value lists below with those modules.
 * Paths: `./paths.ts` (the twin of os/release/layout.mjs).
 *
 * A leaf: type-only imports.
 */
import type { Composition } from '../system/types.js';

// ── value lists (twins of os/release-verify.mjs) ────────────────────────────

/** Trust channels (owner 2026-11-27): `signed` = signed release tags (default), `main` = unsigned head (owner opt-in). */
export const RELEASE_CHANNELS = ['signed', 'main'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = 'signed';

/** Maturity: a signed label on the tag, separate from trust (Phase 8 decision 5). */
export const RELEASE_MATURITIES = ['alpha', 'beta', 'stable'] as const;
export type ReleaseMaturity = (typeof RELEASE_MATURITIES)[number];
/** The maturity floor of fresh installs (owner 2026-11-27: alpha until beta/stable releases exist). */
export const DEFAULT_MATURITY_FLOOR: ReleaseMaturity = 'alpha';

/** Never shown as maintainer-signed unless `upstream-signed` (D71, owner answer a). */
export const RELEASE_PROVENANCES = ['upstream-signed', 'upstream-unsigned', 'locally-modified'] as const;
export type ReleaseProvenance = (typeof RELEASE_PROVENANCES)[number];

export const SECURITY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

/** D64 `security-update-policy`: follow a signed `securityUpdate`, or hold it (the owner's audited override). */
export const SECURITY_UPDATE_POLICIES = ['follow-signed', 'hold'] as const;
export type SecurityUpdatePolicy = (typeof SECURITY_UPDATE_POLICIES)[number];

export const RELEASE_RECORD_VERSION = 1;
export const RELEASE_META_VERSION = 1;

// ── release-meta.json v1 + release-meta.sig (stream S) ──────────────────────

/** Signed metadata of one release tag. Unknown fields are refused by the verifier (a new field is v2). */
export interface ReleaseMeta {
  v: 1;
  product: 'auraos';
  version: string;
  /** The exact commit and its git tree: the signature binds both (D71). */
  commit: string;
  gitTree: string;
  maturity: ReleaseMaturity;
  /** ISO 8601 UTC. */
  publishedAt: string;
  securityUpdate: boolean;
  /** Required when `securityUpdate`. */
  severity?: SecuritySeverity;
  advisories?: string[];
  /** Versions this release supersedes (U's "no reintroduced vulnerability" rollback rule). */
  supersedes?: string[];
  /** The oldest version an update may start from. */
  minFrom?: string;
  notes?: string;
  /** First 16 hex digits of sha256 over the raw Ed25519 key. */
  keyId: string;
}

/** The detached signature over `AURAOS-RELEASE-META-V1\n` + the exact release-meta.json bytes. */
export interface ReleaseMetaSignature {
  v: 1;
  alg: 'ed25519';
  keyId: string;
  /** base64 */
  sig: string;
}

// ── the system patch series slot (D68) ──────────────────────────────────────

export interface SeriesEntry {
  file: string;
  sha256: string;
  subject?: string;
}

/**
 * The series a release was built with: the empty series in Phase 6 (`base: null, order: []`),
 * Phase 7 fills it. `digest` = series-slot.mjs `seriesDigest({base, order})` (`sha256:<hex>`,
 * over `base` and each entry's `file` + `sha256`).
 */
export interface SeriesRef {
  digest: string;
  base: { commit: string; version: string | null } | null;
  order: SeriesEntry[];
}

// ── release.json v1 (stream B) ──────────────────────────────────────────────

export type ReleaseSourceComponent =
  | { name: string; kind: 'package' | 'app' | 'os'; path: string; tree: string }
  | { name: '_root'; kind: 'root'; files: string[]; sha256: string };

export type ReleaseBuiltComponent =
  | { name: string; kind: 'package' }
  | { name: 'shell-bundle'; kind: 'shell'; composition: Composition; outDir: string }
  | { name: string; kind: 'app'; via: 'astro' | 'build.release'; fingerprint?: string; outputs?: string[] };

export interface ReleaseComponents {
  source: ReleaseSourceComponent[];
  built: ReleaseBuiltComponent[];
  /** What this composition serves (`server` drops the desktop pages once stream W splits them). */
  deployed: ReleaseBuiltComponent[];
  skipped: Array<{ name: string; reason: string }>;
}

export type ReleaseMetaSummary =
  | { signed: true; keyId: string; metaDigest: string; securityUpdate: boolean; severity?: SecuritySeverity }
  /** `main`: unsigned, so a `securityUpdate` claim is never honoured (D71). */
  | { signed: false; metaDigest: null; securityUpdate: false };

/** A data migration a release declares (U snapshots its paths before the switch, Q35). Reserved: none yet. */
export interface ReleaseMigration {
  id: string;
  /** Paths under the data root. */
  paths: string[];
}

/** `releases/<id>/release.json`: what a finished release is. */
export interface ReleaseManifest {
  v: 1;
  id: string;
  version: string | null;
  commit: string;
  gitTree: string;
  channel: ReleaseChannel;
  maturity: ReleaseMaturity | null;
  meta: ReleaseMetaSummary;
  provenance: ReleaseProvenance;
  /** `locally-modified` only: the signed base it derives from. */
  base?: { commit: string; version: string | null };
  series: SeriesRef;
  composition: Composition;
  components: ReleaseComponents;
  images: { shell: string; base: string; target: string };
  node: { required: string | null; base: string; shell: string };
  lockfileHash: string | null;
  /** The D94 render digest of the build inputs, or null without an infrastructure config. */
  infraDigest: string | null;
  auraContract: number | null;
  ari: number | null;
  builtAt: string;
  builderJob: string;
  /** `sha256:` git-tree-shaped digest of the finalized tree without release.json and .complete. */
  treeDigest: string;
  migrations?: ReleaseMigration[];
}

// ── pointer.json, source.json ───────────────────────────────────────────────

/** `aura/release/pointer.json`: the one switch (written temp + fsync + rename). */
export interface ReleasePointer {
  v: 1;
  current: string;
  previous: string | null;
  switchedAt: string;
  jobId: string;
}

/** `aura/release/source.json`: where releases come from and what was installed (install.sh). */
export interface ReleaseSource {
  v: 1;
  /** The git source, without userinfo. */
  url: string;
  channel: ReleaseChannel;
  /** The maturity of the installed release (`''` for `main`). */
  maturity: ReleaseMaturity | '';
  ref: string;
  commit: string;
  gitTree: string;
  version: string;
  signed: boolean;
  keyId: string;
  metaDigest: string;
  provenance: ReleaseProvenance;
  mode: 'normal' | 'developer';
  installedAt: string;
  installer: string;
}

// ── snapshots (stream U, Q35) ───────────────────────────────────────────────

/** `aura/release/snapshots/<fromId>-<ts>/snapshot.json`: the data copied before a switch. */
export interface SnapshotRecord {
  v: 1;
  /** The directory name `<fromId>-<ts>`. */
  id: string;
  fromRelease: string;
  toRelease: string;
  jobId: string;
  createdAt: string;
  valkeyVersion: string | null;
  /** Each copied file, relative to the data root. */
  files: Array<{ path: string; sha256: string }>;
  /** sha256 over the sorted `files` list. */
  sha256: string;
}

// ── build ───────────────────────────────────────────────────────────────────

/** What to build: the one entry `build(commit, series)` of updates, install.sh and system patches. */
export interface BuildRequest {
  channel: ReleaseChannel;
  /** `signed`: the floor of the newest release to pick (default `alpha`). */
  maturity?: ReleaseMaturity;
  /** A tag or commit; absent = the newest of the channel. */
  ref?: string;
  /** Refuse unless the selection resolves to it (the installer or an approval verified it already). */
  expectCommit?: string;
  composition: Composition;
  /** Phase 7; Phase 6 refuses a non-empty series. */
  series?: SeriesRef | null;
  firstInstall?: boolean;
}

/**
 * The resolved inputs of a build (lockfile, package manager, Node, images): what an approved
 * build must resolve to again (owner 2026-11-27, Phase 7b `system.patch.activate`).
 */
export interface BuildInputs {
  lockfileHash: string | null;
  packageManager: string | null;
  node: { base: string | null; shell: string | null };
  images: { base: string | null; shell: string | null };
  rebuildsImage: boolean;
  /** External base images of the Dockerfile → digest. */
  from: Record<string, string | null>;
}

// ── the approval binding (D102: forced) ─────────────────────────────────────

/**
 * The payload of the approval `system.release.activate`: recomputed from the built release and
 * compared before the switch; any difference refuses. `infraDigest` binds the D94 config the build
 * used, so a changed infrastructure config cannot ride an old approval.
 */
export interface ReleaseActivationBinding {
  releaseId: string;
  commit: string;
  treeDigest: string;
  metaDigest: string | null;
  provenance: ReleaseProvenance;
  composition: Composition;
  series: SeriesRef;
  infraDigest: string | null;
}
