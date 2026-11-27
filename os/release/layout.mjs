// The Normal-mode release layout on the data volume (Phase 6, Stage 1b paths).
// One module for the release builder, the installer, the Normal runtime (L),
// the updater (U) and the Phase 7 engine; nothing else spells these paths
// (D36). Dependency-free, so it runs before anything of a release is built.
// Every path is relative to the DATA ROOT: `/data` inside AuraOS, or the
// data volume's mountpoint when install.sh builds from the host.
//
//   releases/<id>/                    a finished release: read-only, `.complete` last
//   releases/<id>/release.json        what it is (builder.mjs, `release.json v1`)
//   releases/.staging-<job>/          a build in progress; never served, removed by GC
//   aura/release/pointer.json         { v, current, previous, switchedAt, jobId }
//   aura/release/lock                 the one activation lock (lock.mjs)
//   aura/release/source.json          where releases come from (install.sh writes it)
//   aura/release/mirror.git           the bare source mirror (never /workspace)
//   aura/release/jobs/<job>.json      a build/activate job checklist
//   aura/release/jobs/<job>.d/        per-job files (build secrets 0400, removed after the run)
//   aura/release/snapshots/           data snapshots before the first write (stream U, Q35)
//   aura/release/trusted-keys/        operator-added release keys (*.pub, revoked.txt; D64 release-trusted-keys)
//   aura/boot/writes-held             the release is verifying: mutating requests answer 503 (stream U)
//   aura/pnpm-store                   the shared pnpm store of the throwaway builds
//   aura/overlay/apps/<appId>.json    the settings overlay of one app (stream O)
//   aura/overlay/capabilities.yaml    the capability registry overlay (stream O)
//   aura/workspaces/, aura/patches/   app patch workspaces and patch repositories (Track P)
//   patches/system/aura-patches.yaml  the system patch series (Phase 7; the D68 slot)
//
// packages/core/src/release/paths.ts is this module's typed twin (core cannot
// import os/ at runtime); packages/core/test/release-contracts.test.mjs
// compares both. Change them together.
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

export const newJobId = (now = new Date()) => now.toISOString().replace(/[:.]/g, '-');

/** Absolute paths under one data root. */
export function layout(dataRoot) {
  const p = (rel) => join(dataRoot, rel);
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

/** The data-volume subpath of a layout path, for `--mount …,volume-subpath=` (no leading slash). */
export const subpathOf = (dataRoot, abs) => {
  const rel = abs.startsWith(`${dataRoot}/`) ? abs.slice(dataRoot.length + 1) : null;
  if (!rel || rel.split('/').includes('..')) throw new Error(`${abs} is not under the data root ${dataRoot}`);
  return rel;
};

export function assertJobId(job) {
  if (typeof job !== 'string' || !JOB_ID_RE.test(job)) throw new Error(`bad job id ${JSON.stringify(job)}`);
}
export function assertReleaseId(id) {
  if (typeof id !== 'string' || !RELEASE_ID_RE.test(id) || id.startsWith(STAGING_PREFIX)) throw new Error(`bad release id ${JSON.stringify(id)}`);
}
export function assertAppId(appId) {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId) || appId.includes('..')) throw new Error(`bad app id ${JSON.stringify(appId)}`);
}
