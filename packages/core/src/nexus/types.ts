/**
 * Shared types for the Nexus distribution layer. All interfaces here are
 * stable: shell HTTP API, CLI, and the Nexus GUI app all import from this
 * file so a change to a field name ripples through the whole system in one
 * compile cycle.
 */
import type { AppManifest } from '../types/manifest.js';
import type { ScopeId } from '../scopes/types.js';
import type { AppSourceInfo, SourceMode } from './AppSource.js';
import type { AuraErrorBody } from '../errors/contracts.js';

/** Where an app came from. Stored in the install record per app. */
export type NexusSource = 'oci' | 'git' | 'index' | 'local';

/**
 * The resolver's output. Concrete (source, address, digest) tuple plus a
 * manifest preview so the permission gate can run without a full pull.
 */
export interface ResolvedRef {
  source:    NexusSource;
  /** Original ref the user typed — kept verbatim for diagnostics. */
  rawRef:    string;
  /** Resolved address (registry/tag, https URL, filesystem path). */
  address:   string;
  /** sha256 for OCI, commit SHA for Git, '' for local. */
  digest:    string;
  /** Optional channel label, populated when ref came through an index entry. */
  channel?:  string;
  /** The registered source that provided it (catalog entry or OCI host). */
  sourceName?: string;
  /**
   * Best-effort manifest preview. Populated from OCI annotations or a
   * shallow git ls-tree where cheap; otherwise null and the validator
   * reads it post-fetch.
   */
  manifestPreview: AppManifest | null;
}

/**
 * Per-app install record persisted at `data/nexus/installed/<id>.json`.
 * Source of truth for `aura nexus list`, the Nexus app's /installed view,
 * and the update flow (re-resolve the same ref + channel).
 */
export interface InstallRecord {
  id:          string;
  version:     string;
  source:      NexusSource;
  ref:         string;
  digest:      string;
  channel:     string | null;
  installedAt: string;   // ISO-8601
  updatedAt:   string;   // ISO-8601
  /** Which scope this app is installed in. Absent in pre-scope records → treat as 'system'. */
  scope?:      ScopeId;
  /** The source it came from, so an update asks the same (possibly private)
   *  source again. Absent in older records → resolved as at install time. */
  sourceName?: string;
  /** The app's originId when installed (see core AppIdentity). */
  originId?:   string;
  /** The app's id in its source, when it is installed under another local id
   *  ("install as" / "update existing") — updates from that source land here. */
  remoteId?:   string;
  /** Installed as an independent copy: no originId link to its source, so
   *  the store never updates it from there. */
  detached?:   boolean;
  /** Source repo + commit the release was built from (its publish marker,
   *  else manifest.repository) — what `aura dev checkout` uses. */
  upstream?:   AppSourceInfo;
  /** The owner's source-mode choice for this installation (`aura dev open`).
   *  Absent: the release's `source.defaultMode` (AppSource `effectiveSourceMode`).
   *  Kept across updates and patch activations. */
  sourceMode?: SourceMode;
}

/** How the user resolved an identity conflict (re-sent with the install). */
export interface IdentityDecision {
  action: import('../app-manager/AppIdentity.js').IdentityAction;
  /** The local id to install under (install-as / install-copy); default suggested. */
  appId?: string;
}

/** An install the user must decide about (scenarios A, B, D). */
export interface IdentityConflict {
  kind:     import('../app-manager/AppIdentity.js').IdentityConflictKind;
  incoming: { appId: string; originId: string | null; version: string; name: string; sourceName?: string; ref: string };
  existing: { appId: string; originId: string | null; scope: ScopeId; sourceName?: string; ref?: string };
  choices:  import('../app-manager/AppIdentity.js').IdentityAction[];
  /** A free local id for install-as / install-copy. */
  suggestedAppId: string;
}

/**
 * What changed between the currently-installed manifest (or null on first
 * install) and the incoming one. Single source of truth for both the CLI
 * approval prompt and the Nexus app modal.
 */
export interface PermissionDiff {
  appId:               string;
  versionFrom:         string | null;
  versionTo:           string;
  toolsAdded:          string[];
  toolsRemoved:        string[];
  permissionsAdded:    string[];
  permissionsRemoved:  string[];
  /** Whether the incoming manifest declares a data provider that the
   *  previous version did not. */
  dataProviderAdded:   boolean;
  /** Whether the incoming manifest removes the previously-declared
   *  data provider entirely. */
  dataProviderRemoved: boolean;
  /** New intent filters added by the incoming manifest. Each formatted
   *  as `<action> [mime…] [scheme…]` for display. */
  intentFiltersAdded:  string[];
  /** Context keys the incoming manifest declares that the previous did not
   *  (stream C: an approved install or update grants them). */
  contextAdded:        string[];
  contextRemoved:      string[];
}

/**
 * One entry in the curated index.yaml. The Nexus app's home page +
 * search read these. The resolver consumes them when the user installs
 * a bare reverse-domain id.
 */
export interface IndexEntry {
  id:          string;
  /** The app's originId — the same app across registries (see AppIdentity). */
  originId?:   string;
  name:        string;
  description?: string;
  icon?:       string;
  publisher?:  string;
  homepage?:   string;
  categories?: string[];
  tags?:       string[];
  screenshots?: string[];
  sources: {
    git?: {
      ref:           string;           // 'github.com/user/foo'
      'default-branch'?: string;
    };
    oci?: {
      ref: string;                     // 'ghcr.io/user/aura-foo' (no tag)
    };
  };
  channels?: Record<string, {
    'git-tag'?: string;
    'oci-tag'?: string;
  }>;
}

/** The full deserialized index.yaml. */
export interface IndexDocument {
  schema:   number;
  apps:     IndexEntry[];
  featured: string[];
  categories: Array<{ slug: string; label: string; description?: string }>;
}

/**
 * What an install or update approval binds (D31, 5.10): the exact artifact,
 * where it goes and what it may do. The shell hashes it (`payloadHash`) into
 * the approval it consumes, so a moved tag, another scope or another tool or
 * permission needs a new approval.
 */
export interface InstallBinding {
  /** `app.patch.activate`: a prepared app tree from a patch workspace (or
   *  its rollback tree) installed through the same pipeline (Track P). */
  action:      'nexus.install' | 'nexus.update' | 'app.patch.activate';
  appId:       string;
  name:        string;
  version:     string;
  source:      NexusSource;
  address:     string;
  /** The resolved digest: sha256 for OCI, the commit for git, a tree hash for a local path. */
  digest:      string;
  scope:       'global' | 'user';
  identity:    IdentityDecision | null;
  /** Everything the app declares, sorted; the diff is shown, this is bound. */
  tools:       string[];
  permissions: string[];
  /** The Context keys it declares (`context[]`), sorted: the approval grants them (stream C, Q7). */
  context:     string[];
  /** It replaces a dev checkout (`force`): the owner's working tree, uncommitted work included (M1). */
  replaceCheckout: boolean;
  /**
   * The manifest's root request (`execution`, identity/execution.ts), bound
   * by its digest; null when it requests none. The approval of this binding
   * is what grants it (at `fresh`); `renew` is false only when the
   * installation already holds an approval of exactly this digest.
   */
  execution: import('../identity/execution.js').ExecutionBinding | null;
  /** What the manifest asks of the host beyond tools and permissions, for the dialog's high-risk section. */
  exposure: InstallExposure;
}

/**
 * Host-facing facts of a manifest (`installExposure`, PermissionDiff.ts):
 * what its sidecar templates and port settings ask for. Derived from the
 * bound artifact; the shell's dialog classifies them (lib/approvals/display.ts).
 */
export interface InstallExposure {
  /** Sidecar templates that ask for more than an unprivileged container. */
  sidecars: Array<{
    name: string;
    image: string;
    privileged: boolean;
    capabilities: string[];
    devices: string[];
    /** `host:container` publishes. */
    publish: string[];
    dockerSocket: boolean;
    /** No `user`, or uid 0 / root: the image's root. */
    root: boolean;
  }>;
  /** `ports.hostPublish`: this app's ports on the host (127.0.0.1). */
  hostPublish: number[];
  /** `ports.exposes`: other apps' ports pulled onto its loopback, `<app>:<port>`. */
  portExposes: string[];
  /** `hosts[]` names: its own App Host origins. */
  hosts: string[];
}

/**
 * Streaming progress event for install / update / publish. Both the CLI
 * (over SSE) and the Nexus app (also SSE) render these.
 */
export type NexusProgressEvent =
  | { type: 'resolve.start';      ref: string }
  | { type: 'resolve.done';       resolved: ResolvedRef }
  | { type: 'fetch.start';        bytes?: number }
  | { type: 'fetch.progress';     bytesDownloaded: number; bytesTotal?: number }
  | { type: 'fetch.done';         stagingDir: string }
  | { type: 'validate.done';      manifest: AppManifest }
  | { type: 'identity.choice';    conflict: IdentityConflict }
  | { type: 'identity.resolved';  action: string; appId: string }
  | { type: 'permission.needed';  diff: PermissionDiff; binding: InstallBinding }
  | { type: 'permission.approved' }
  | { type: 'permission.denied' }
  | { type: 'install.start' }
  | { type: 'install.provision'; message: string }
  | { type: 'install.done';       record: InstallRecord }
  | { type: 'publish.start' }
  | { type: 'publish.progress';   message: string }
  | { type: 'publish.done';       ref: string }
  | { type: 'error';              code: string; message: string; /** A D105 body (`AuraErrorBody`) to answer as is (the start gate). */ body?: AuraErrorBody;
                                  /** With `body`: the install action it refused (`nexus.install`, `nexus.update`, `app.patch.activate`). */ action?: string };

/**
 * A registry credential for pulling one image on behalf of one installed app
 * (RegistryAuth `resolvePullCredential`). An opaque, short-lived handle: the
 * secret is not a field, it only goes into a throwaway auth file that the
 * runtime that pulls (docker today, another ARI runtime later) asks for and
 * disposes right after the pull. Never handed to the app or its sidecars.
 */
export interface PullCredential {
  /** The Nexus source whose login this is (named in errors). */
  readonly source:     string;
  /** Registry host of the image (== the source's registry host). */
  readonly host:       string;
  /** Repository path of the image on that host (inside the app's own artifact repository). */
  readonly repository: string;
  /**
   * Write the login as an OCI registry auth file (the `{"auths": …}` JSON that
   * docker `--config`, podman/skopeo `--authfile` and oras `--registry-config`
   * read), holding only this host, in a private temp dir. Call `dispose()` in
   * a finally.
   */
  authFile(): { dir: string; file: string; dispose(): void };
  /** `text` (registry output) with the secret masked. */
  redact(text: string): string;
}
