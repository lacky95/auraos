// Release GC (Phase 6 stream B; Q34, Q35, D7): what stays on the data volume
// after a build or a switch. Keeps `current` and `previous` (pointer.json) plus
// what the caller names (the new release until U activates it), and removes:
//   - every other release (and its images, unless a kept release uses them);
//   - staging leftovers and per-job file dirs of other jobs;
//   - data snapshots (aura/release/snapshots/<fromId>-<ts>/, stream U) whose
//     record names a release that is no longer kept: the one kept snapshot is
//     the switch previous → current, the only one a data restore may use
//     (U refuses older ones). A snapshot dir without a readable record is left
//     alone and reported (`unknown`): only U knows whether it is a leftover;
//   - unreferenced pnpm store content (`pnpm store prune`), at most every
//     STORE_PRUNE_INTERVAL_MS, after the releases are gone (their hardlinks
//     keep what a kept release uses). It runs in a throwaway container of the
//     current release's shell image (--network none, the store mount only).
// Call it under the `system` activation lock only: the builder's own job, or
// U's switch job through `builder.mjs gc --held-by <job>` (the lock stays U's).
// Dependency-free.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonDurable } from './durable.mjs';
import { throwawayArgs, volumeSubpath } from './container.mjs';
import { COMPLETE_MARKER, RELEASE_RECORD, STAGING_PREFIX, layout } from './layout.mjs';
import { RELEASE_BUILD_LIMITS } from './limits.mjs';
import { readJson, removeTree, run } from './proc.mjs';

/** The store's own prune record, inside the store dir (not a layout path: it belongs to the store). */
export const STORE_PRUNE_STAMP = '.aura-prune.json';
/** Owner cadence (phase6-plan §5 B step 9): monthly. */
export const STORE_PRUNE_INTERVAL_MS = 30 * 24 * 60 * 60_000;
export const SNAPSHOT_RECORD = 'snapshot.json';
/** gc's `pruneStore`: `auto` = when due, `now` = always, `never` = skip. */
export const PRUNE_MODES = Object.freeze(['auto', 'now', 'never']);

export const readPointer = (dataRoot) => readJson(layout(dataRoot).pointer);

/** Releases on disk: [{ id, complete, record }] (staging dirs excluded). */
export function listReleases(dataRoot) {
  const L = layout(dataRoot);
  if (!existsSync(L.releases)) return [];
  return readdirSync(L.releases).filter((n) => !n.startsWith('.')).sort().map((id) => ({
    id,
    complete: existsSync(join(L.releases, id, COMPLETE_MARKER)),
    record: readJson(join(L.releases, id, RELEASE_RECORD)),
  }));
}

/** The kept set: current, previous and `keep`. */
export function keptReleases(dataRoot, keep = []) {
  const ptr = readPointer(dataRoot);
  return new Set([ptr?.current, ptr?.previous, ...keep].filter(Boolean));
}

/**
 * Removes the snapshots of switches between releases that are not both kept.
 * Resolves { removed, kept, unknown } (directory names).
 */
export function gcSnapshots({ dataRoot, kept, log = () => {} }) {
  const L = layout(dataRoot);
  const out = { removed: [], kept: [], unknown: [] };
  if (!existsSync(L.snapshots)) return out;
  for (const n of readdirSync(L.snapshots).sort()) {
    const rec = readJson(join(L.snapshots, n, SNAPSHOT_RECORD));
    if (!rec || typeof rec.fromRelease !== 'string' || typeof rec.toRelease !== 'string') {
      out.unknown.push(n);
      log(`gc: snapshot ${n} has no readable record: left for the updater`);
      continue;
    }
    if (kept.has(rec.fromRelease) && kept.has(rec.toRelease)) { out.kept.push(n); continue; }
    removeTree(join(L.snapshots, n));
    out.removed.push(n);
    log(`gc: removed snapshot ${n} (${rec.fromRelease} → ${rec.toRelease})`);
  }
  return out;
}

/** { due, last } for the monthly store prune (no record yet: not due, the clock starts now). */
export function storePruneDue(dataRoot, now = Date.now()) {
  const rec = readJson(join(layout(dataRoot).pnpmStore, STORE_PRUNE_STAMP));
  const last = typeof rec?.at === 'string' ? Date.parse(rec.at) : NaN;
  if (Number.isNaN(last)) return { due: false, last: null, first: true };
  return { due: now - last >= STORE_PRUNE_INTERVAL_MS, last: rec.at, first: false };
}

const writeStamp = (dataRoot, at, extra = {}) =>
  writeJsonDurable(join(layout(dataRoot).pnpmStore, STORE_PRUNE_STAMP), { v: 1, at: new Date(at).toISOString(), ...extra });

/**
 * `pnpm store prune` on the shared store, in a throwaway container of `image`
 * (--network none, only the store mounted). Resolves { pruned, detail }; never throws
 * for a failed prune (the store is only bigger than needed).
 */
export async function pruneStore({ dataRoot, dataVolume, dataSubpath, image, jobId, docker = 'docker', limits, now = Date.now(), log = () => {} }) {
  const L = layout(dataRoot);
  if (!existsSync(L.pnpmStore)) return { pruned: false, detail: 'no store' };
  if (!image) return { pruned: false, detail: 'no current release image to run pnpm in' };
  if (!dataVolume) return { pruned: false, detail: 'no data volume given' };
  const name = `aura-release-prune-${String(jobId ?? now).toLowerCase()}`;
  const args = throwawayArgs({
    name, image, network: 'none', limits: limits ?? RELEASE_BUILD_LIMITS, workdir: '/pnpm-store',
    mounts: [{ type: 'volume', source: dataVolume, target: '/pnpm-store', subpath: volumeSubpath(dataRoot, dataSubpath, L.pnpmStore) }],
    env: { HOME: '/tmp', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }, entrypoint: 'pnpm',
  });
  const r = await run(docker, [...args, 'store', 'prune', '--store-dir', '/pnpm-store'], { timeoutMs: 30 * 60_000, name });
  if (r.code) {
    const detail = `pnpm store prune failed (exit ${r.code}): ${r.out.trim().split('\n').slice(-3).join(' / ')}`;
    log(`gc: ${detail}`);
    return { pruned: false, detail };
  }
  writeStamp(dataRoot, now, { image });
  log('gc: pnpm store pruned');
  return { pruned: true, detail: `pruned with ${image}` };
}

/**
 * Removes every release that is not current, previous or in `keep`, every
 * staging dir but `activeJob`'s, leftover per-job dirs, the snapshots of
 * removed releases, and (pruneStore) unreferenced store content. Images of
 * removed releases go too unless a kept release uses them (a running image
 * refuses removal; that is fine).
 * Resolves { removed, images, kept, snapshots, store }.
 */
export async function gc({
  dataRoot, keep = [], activeJob = null, docker = 'docker', log = () => {},
  dataVolume = null, dataSubpath, pruneStore: prune = 'auto', limits, now = Date.now(),
}) {
  if (!PRUNE_MODES.includes(prune)) throw new Error(`pruneStore must be one of ${PRUNE_MODES.join('|')}`);
  const L = layout(dataRoot);
  const kept = keptReleases(dataRoot, keep);
  const removed = [];
  const imagesInUse = new Set();
  const imagesOfRemoved = new Set();
  for (const r of listReleases(dataRoot)) {
    const imgs = [r.record?.images?.shell, r.record?.images?.base].filter(Boolean);
    if (kept.has(r.id)) { imgs.forEach((i) => imagesInUse.add(i)); continue; }
    imgs.forEach((i) => imagesOfRemoved.add(i));
    removeTree(join(L.releases, r.id));
    removed.push(r.id);
    log(`gc: removed release ${r.id}`);
  }
  if (existsSync(L.releases)) {
    for (const n of readdirSync(L.releases)) {
      if (!n.startsWith(STAGING_PREFIX) || n === `${STAGING_PREFIX}${activeJob}`) continue;
      removeTree(join(L.releases, n));
      removed.push(n);
      log(`gc: removed stale staging ${n}`);
    }
  }
  if (existsSync(L.jobs)) {
    for (const n of readdirSync(L.jobs)) {
      if (n.endsWith('.d') && n !== `${activeJob}.d`) removeTree(join(L.jobs, n));
    }
  }
  const snapshots = gcSnapshots({ dataRoot, kept, log });
  const images = [];
  for (const img of imagesOfRemoved) {
    if (imagesInUse.has(img)) continue;
    const r = await run(docker, ['image', 'rm', img]);
    if (r.code === 0) images.push(img);
  }
  let store = { pruned: false, detail: 'skipped' };
  if (prune !== 'never') {
    const due = storePruneDue(dataRoot, now);
    if (prune === 'now' || due.due) {
      const ptr = readPointer(dataRoot);
      const image = ptr?.current ? readJson(join(L.releases, ptr.current, RELEASE_RECORD))?.images?.shell : null;
      store = await pruneStore({ dataRoot, dataVolume, dataSubpath, image, jobId: activeJob, docker, limits, now, log });
    } else if (due.first && existsSync(L.pnpmStore)) {
      writeStamp(dataRoot, now, { first: true });
      store = { pruned: false, detail: 'first GC: the monthly prune clock starts now' };
    } else {
      store = { pruned: false, detail: `not due (last ${due.last ?? 'never'})` };
    }
  }
  return { removed, images, kept: [...kept], snapshots, store };
}
