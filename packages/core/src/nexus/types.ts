/**
 * Shared types for the Nexus distribution layer. All interfaces here are
 * stable: shell HTTP API, CLI, and the Nexus GUI app all import from this
 * file so a change to a field name ripples through the whole system in one
 * compile cycle.
 */
import type { AppManifest } from '../types/manifest.js';
import type { ScopeId } from '../scopes/types.js';

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
}

/**
 * One entry in the curated index.yaml. The Nexus app's home page +
 * search read these. The resolver consumes them when the user installs
 * a bare reverse-domain id.
 */
export interface IndexEntry {
  id:          string;
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
  | { type: 'permission.needed';  diff: PermissionDiff }
  | { type: 'permission.approved' }
  | { type: 'permission.denied' }
  | { type: 'install.start' }
  | { type: 'install.provision'; message: string }
  | { type: 'install.done';       record: InstallRecord }
  | { type: 'publish.start' }
  | { type: 'publish.progress';   message: string }
  | { type: 'publish.done';       ref: string }
  | { type: 'error';              code: string; message: string };
