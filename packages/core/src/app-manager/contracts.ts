/**
 * App-manager contracts other modules use (a contract leaf, D97 A1: imports
 * no other core module at runtime): the mount roots of a consumer, and the
 * source-mode policy of an installed copy (Execution enforces it at spawn and
 * mount; the install record it reads is written by nexus).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Canonical mount root inside a consumer container: one definition, the runtimes' spawn paths (a leaf). */
export { MOUNT_ROOT_PATH } from '../runtimes/spawn/paths.js';
/** Where `work` mounts appear under a consumer's mount root. */
export const WORK_DIR_NAME = 'work';
/** Where `patches` mounts appear under a consumer's mount root. */
export const PATCHES_DIR_NAME = 'patches';
/**
 * The `work` mount target of a SYSTEM patch workspace (Phase 7b, D68, D80:
 * writable source mounts only for authorized patch workspaces): appears at
 * `/mnt/aura/work/system`. App ids always contain a dot, so it names no app.
 */
export const SYSTEM_WORK_TARGET = 'system';
/** A system patch workspace, relative to the root dataDir (nexus workspaceSubpath, installation `system`). */
export const SYSTEM_WORKSPACE_SUBPATH = /^aura\/workspaces\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/system\/[1-9]\d{0,3}$/;

/** An app dir that is a git work tree (`aura dev checkout`). */
export function isDevCheckout(appDir: string): boolean {
  return existsSync(join(appDir, '.git'));
}

export type SourceMode = 'closed' | 'open';

export interface SourceModeInfo {
  mode:        SourceMode;
  /** The release's default (`manifest.source.defaultMode`, else closed). */
  defaultMode: SourceMode;
  /**
   * What decided `mode`: a system app (always closed), an app built here
   * with no install record (its author's own checkout, always open), the
   * owner's choice on the install record, a developer checkout made before
   * (`aura dev checkout`, has `.git`: open), or the release's default.
   */
  from:        'system' | 'local' | 'record' | 'checkout' | 'manifest' | 'default';
}

/** The install record path of an app in a scope (what Installer writes). */
export function installRecordPath(scopeDataDir: string, appId: string): string {
  return join(scopeDataDir, 'nexus', 'installed', `${appId}.json`);
}

/**
 * Who may change this installed copy's source. `scope` is the scope the copy
 * lives in; `manifest` its manifest (only `source` is read).
 */
export function effectiveSourceMode(
  scope: { id: string; immutable?: boolean; dataDir: string; appsDir?: string },
  manifest: { id: string; source?: { defaultMode?: SourceMode } },
): SourceModeInfo {
  const declared = manifest.source?.defaultMode;
  const defaultMode: SourceMode = declared ?? 'closed';
  if (scope.immutable || scope.id === 'system') return { mode: 'closed', defaultMode, from: 'system' };
  let record: { sourceMode?: unknown } | null = null;
  try { record = JSON.parse(readFileSync(installRecordPath(scope.dataDir, manifest.id), 'utf-8')) as { sourceMode?: unknown }; }
  catch { record = null; }
  if (!record) return { mode: 'open', defaultMode, from: 'local' };
  if (record.sourceMode === 'open' || record.sourceMode === 'closed') return { mode: record.sourceMode, defaultMode, from: 'record' };
  // A checkout needs an open install since Track P; one made before stays the owner's working tree.
  if (scope.appsDir && isDevCheckout(join(scope.appsDir, manifest.id))) return { mode: 'open', defaultMode, from: 'checkout' };
  return { mode: defaultMode, defaultMode, from: declared ? 'manifest' : 'default' };
}

/**
 * Built-in (system-scope) apps are read-only: they are changed with system
 * patches (Phase 7b) or in Developer Mode, never by a same-id copy in another
 * scope (Q6, D68: the overlay design is removed). Every path that would make
 * one writable refuses with this code and message: R4 answers 409, the install
 * pipeline refuses such an activation, and `aura dev` says so.
 */
export const SYSTEM_APP_LATER = 'system-app-later';
export const SYSTEM_APP_LATER_MESSAGE = 'Built-in apps are changed with system patches (`aura system patch start`, Normal mode) or in Developer Mode';

