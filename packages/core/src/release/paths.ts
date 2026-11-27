/**
 * The Normal-mode release layout on the data volume: FROZEN (Phase 6 Stage 1b, 6B.0).
 *
 * The one path list of the release builder, the Normal runtime (L), the settings overlay (O),
 * the updater (U), the patch engines (Track P, Phase 7) and the kernel (D36: nothing else
 * spells these paths). It is the typed twin of `os/release/layout.mjs`, which the builder and
 * install.sh run before any core is built; `test/release-contracts.test.mjs` compares every
 * constant and every `layout()` path of both. Change them together.
 *
 * Every path is relative to the DATA ROOT (`/data`, `AURA_DATA_DIR`); see layout.mjs for the map.
 * A leaf: no core module imports.
 */
import { join } from 'node:path';

export const RELEASES_DIR = 'releases';
export const RELEASE_DIR = 'aura/release';
export const POINTER_FILE = `${RELEASE_DIR}/pointer.json`;
export const LOCK_FILE = `${RELEASE_DIR}/lock`;
export const SOURCE_FILE = `${RELEASE_DIR}/source.json`;
export const MIRROR_DIR = `${RELEASE_DIR}/mirror.git`;
export const JOBS_DIR = `${RELEASE_DIR}/jobs`;
export const SNAPSHOTS_DIR = `${RELEASE_DIR}/snapshots`;
export const TRUSTED_KEYS_DIR = `${RELEASE_DIR}/trusted-keys`;
export const WRITES_HELD_FILE = 'aura/boot/writes-held';
export const PNPM_STORE_DIR = 'aura/pnpm-store';
export const OVERLAY_DIR = 'aura/overlay';
export const OVERLAY_APPS_DIR = `${OVERLAY_DIR}/apps`;
export const OVERLAY_CAPABILITIES_FILE = `${OVERLAY_DIR}/capabilities.yaml`;
export const APP_WORKSPACES_DIR = 'aura/workspaces';
export const APP_PATCHES_DIR = 'aura/patches';
export const SYSTEM_SERIES_DIR = 'patches/system';
export const SYSTEM_SERIES_FILE = `${SYSTEM_SERIES_DIR}/aura-patches.yaml`;
export const RELEASE_RECORD = 'release.json';
export const COMPLETE_MARKER = '.complete';
export const STAGING_PREFIX = '.staging-';

/** Same shape as SelfUpdater's job ids (its UPDATE_JOB_ID_RE): a start time, never a path. */
export const JOB_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
/** A release id: `<version or "main">-<commit12>-<inputs8>`; a directory name, never a path. */
export const RELEASE_ID_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,100}$/;
/** An app id as a file name (reverse-domain); never a path. */
export const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const newJobId = (now: Date = new Date()): string => now.toISOString().replace(/[:.]/g, '-');

export interface ReleaseLayout {
  root: string;
  releases: string;
  release(id: string): string;
  staging(job: string): string;
  pointer: string;
  lock: string;
  source: string;
  mirror: string;
  jobs: string;
  job(job: string): string;
  jobFiles(job: string): string;
  snapshots: string;
  trustedKeys: string;
  writesHeld: string;
  pnpmStore: string;
  overlayApps: string;
  overlayApp(appId: string): string;
  overlayCapabilities: string;
  appWorkspaces: string;
  appPatches: string;
  series: string;
}

/** Absolute paths under one data root. */
export function layout(dataRoot: string): ReleaseLayout {
  const p = (rel: string) => join(dataRoot, rel);
  return {
    root: dataRoot,
    releases: p(RELEASES_DIR),
    release: (id) => { assertReleaseId(id); return p(`${RELEASES_DIR}/${id}`); },
    staging: (job) => { assertJobId(job); return p(`${RELEASES_DIR}/${STAGING_PREFIX}${job}`); },
    pointer: p(POINTER_FILE),
    lock: p(LOCK_FILE),
    source: p(SOURCE_FILE),
    mirror: p(MIRROR_DIR),
    jobs: p(JOBS_DIR),
    job: (job) => { assertJobId(job); return p(`${JOBS_DIR}/${job}.json`); },
    jobFiles: (job) => { assertJobId(job); return p(`${JOBS_DIR}/${job}.d`); },
    snapshots: p(SNAPSHOTS_DIR),
    trustedKeys: p(TRUSTED_KEYS_DIR),
    writesHeld: p(WRITES_HELD_FILE),
    pnpmStore: p(PNPM_STORE_DIR),
    overlayApps: p(OVERLAY_APPS_DIR),
    overlayApp: (appId) => { assertAppId(appId); return p(`${OVERLAY_APPS_DIR}/${appId}.json`); },
    overlayCapabilities: p(OVERLAY_CAPABILITIES_FILE),
    appWorkspaces: p(APP_WORKSPACES_DIR),
    appPatches: p(APP_PATCHES_DIR),
    series: p(SYSTEM_SERIES_FILE),
  };
}

/** The layout of this process's data root (`AURA_DATA_DIR`, default `/data`). */
export const dataLayout = (env: Record<string, string | undefined> = process.env): ReleaseLayout => layout(env['AURA_DATA_DIR'] ?? '/data');

/** The data-volume subpath of a layout path, for `--mount …,volume-subpath=` (no leading slash). */
export const subpathOf = (dataRoot: string, abs: string): string => {
  const rel = abs.startsWith(`${dataRoot}/`) ? abs.slice(dataRoot.length + 1) : null;
  if (!rel || rel.split('/').includes('..')) throw new Error(`${abs} is not under the data root ${dataRoot}`);
  return rel;
};

export function assertJobId(job: unknown): asserts job is string {
  if (typeof job !== 'string' || !JOB_ID_RE.test(job)) throw new Error(`bad job id ${JSON.stringify(job)}`);
}
export function assertReleaseId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !RELEASE_ID_RE.test(id) || id.startsWith(STAGING_PREFIX)) throw new Error(`bad release id ${JSON.stringify(id)}`);
}
export function assertAppId(appId: unknown): asserts appId is string {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId) || appId.includes('..')) throw new Error(`bad app id ${JSON.stringify(appId)}`);
}
