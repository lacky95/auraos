#!/usr/bin/env node
// AuraOS release activation (Phase 6 stream U; D7, D68, D71, Q34, Q35).
//
// The file work of switching a Normal-mode install from one release to
// another, and back: the data snapshot before the first write, the atomic
// pointer switch, the writes-held marker, the health verdict, the "accepting
// writes" point, the rollback (release only, or release + data) and the
// security rule that a rollback never brings back a resolved vulnerability.
// The detached updater (core SelfUpdater modes `release` and `rollback`) runs
// it step by step from the TRUSTED side, the running release's own copy
// (`/data/releases/<current>/os/release/activate.mjs`); the shell imports the
// same module for its preflight and its status (one implementation, D36), and
// the host recovery script (stream L, release-ctl.sh) can call the CLI.
// Dependency-free (node, cp), like the builder and the verifier.
//
//   lock / hold-lock  the one `system` activation lock (lock.mjs), held by a
//                     long-lived process for the whole job, heartbeat 30 s
//   verify            the target is complete, its treeDigest recomputes, its
//                     signed metadata verifies with the CURRENT trust (D71)
//   snapshot          kv/ + every path a declared migration touches →
//                     aura/release/snapshots/<fromId>-<ts>/ (cp -a --reflink=auto)
//   switch            pointer.json {current:new, previous:old}, then
//                     aura/boot/writes-held (the new kernel starts held)
//   health            the new kernel's status.json: a boot after the switch,
//                     kernelReadyAt, no error, every service resumed
//   accept            the operator's accept-writes call (the shell removes the
//                     marker and audits); the marker alone if the API is gone
//   revert            pointer back (current := previous, previous := null)
//   restore           a snapshot back into place (the kernel is stopped); what
//                     it replaces is kept in the snapshot dir, never deleted
//
// CLI (JSON on stdout; exit 0 ok, 1 failed, 3 refused, 64 usage):
//   activate.mjs status   --data D
//   activate.mjs hold-lock --data D --job J [--by B]   prints {"ok":true} once held, then holds until SIGTERM
//   activate.mjs verify   --data D --id R [--trusted T] [--mirror-check]
//   activate.mjs preflight --data D --id R [--trusted T] [--channel signed|main]
//   activate.mjs rollback-check --data D [--confirm-insecure ADVISORIES]
//   activate.mjs snapshot --data D --to R --job J
//   activate.mjs switch   --data D --to R --job J [--snapshot S]
//   activate.mjs health   --data D --since ISO
//   activate.mjs accept   --data D --job J [--trusted T] [--url URL]
//   activate.mjs revert   --data D --job J
//   activate.mjs restore  --data D --snapshot S
//   activate.mjs release-hold --data D
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ReleaseVerifyError, addKeyDir, compareSemver, emptyTrust, gitTreeOfDir, parseArgs, readTagRelease, verifyMeta,
} from '../release-verify.mjs';
import { writeJsonDurable } from './durable.mjs';
import { LockError, acquireLock, lockStatus } from './lock.mjs';
import {
  COMPLETE_MARKER, RELEASE_RECORD, assertJobId, assertReleaseId, layout,
} from './layout.mjs';

export const WRITES_HELD_VERSION = 1;
/** The kernel's KV directory under the data root (kvServer `${dataDir}/kv`): always snapshotted. */
export const KV_DIR = 'kv';
/** The boot status the kernel writes (core system/status.ts `bootStatusFile`). */
export const BOOT_STATUS = 'aura/boot/status.json';
/** The accept-writes route the updater calls with an operator ticket. */
export const ACCEPT_WRITES_PATH = '/api/admin/release/accept-writes';
/** A security update of this severity is never rolled back past, whatever the owner confirms (D95 §14). */
export const UNROLLBACKABLE_SEVERITY = 'critical';

export class ActivateError extends Error {
  constructor(code, message, { exit = 3, detail } = {}) { super(message); this.code = code; this.exit = exit; if (detail) this.detail = detail; }
}
const refuse = (code, message, detail) => { throw new ActivateError(code, message, { detail }); };

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const nowIso = (d = new Date()) => d.toISOString();
const compactTs = (d = new Date()) => d.toISOString().replace(/[-:]/g, '');

// ── reading the layout ──────────────────────────────────────────────────────

export const readPointer = (dataRoot) => readJson(layout(dataRoot).pointer);

/** A finished release's record, or null (incomplete, missing, bad id). */
export function readRelease(dataRoot, id) {
  try { assertReleaseId(id); } catch { return null; }
  const dir = layout(dataRoot).release(id);
  if (!existsSync(join(dir, COMPLETE_MARKER))) return null;
  const rec = readJson(join(dir, RELEASE_RECORD));
  return rec && rec.id === id ? rec : null;
}

/** The writes-held marker: `{ v, jobId, from, to, snapshot, at }`, or null when writes are accepted. */
export function readWritesHeld(dataRoot) {
  const f = layout(dataRoot).writesHeld;
  if (!existsSync(f)) return null;
  return readJson(f) ?? { v: WRITES_HELD_VERSION, jobId: null, from: null, to: null, snapshot: null, at: null, unreadable: true };
}

export function listSnapshots(dataRoot) {
  const dir = layout(dataRoot).snapshots;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().reverse()
    .map((n) => readJson(join(dir, n, 'snapshot.json')))
    .filter((r) => r && r.v === 1 && typeof r.id === 'string');
}

/** Everything the shell, the CLI and About show (read only). */
export function status(dataRoot, { now = Date.now() } = {}) {
  const L = layout(dataRoot);
  const pointer = readPointer(dataRoot);
  const summary = (id) => {
    const r = id ? readRelease(dataRoot, id) : null;
    return r ? {
      id: r.id, version: r.version, commit: r.commit, channel: r.channel, maturity: r.maturity, provenance: r.provenance,
      signed: r.meta?.signed === true, securityUpdate: r.meta?.securityUpdate === true, severity: r.meta?.severity ?? null,
      composition: r.composition, builtAt: r.builtAt, images: r.images,
    } : (id ? { id, missing: true } : null);
  };
  const releases = existsSync(L.releases)
    ? readdirSync(L.releases).filter((n) => !n.startsWith('.')).sort().map((id) => summary(id)).filter(Boolean)
    : [];
  return {
    pointer,
    current: summary(pointer?.current),
    previous: summary(pointer?.previous),
    releases,
    writesHeld: readWritesHeld(dataRoot),
    snapshots: listSnapshots(dataRoot).map(({ id, fromRelease, toRelease, jobId, createdAt, files }) => ({ id, fromRelease, toRelease, jobId, createdAt, files: files.length })),
    lock: lockStatus(L.lock, { now }),
  };
}

// ── trust (D71): the running release's keys + the operator's ────────────────

/**
 * The keys a target is checked with: the TRUSTED tree's `os/release-keys/`
 * (the running release, never the candidate) plus the operator's D64 record
 * `aura/release/trusted-keys/`. Revocations in either win.
 */
export function currentTrust(dataRoot, trustedTree) {
  let t = emptyTrust();
  if (trustedTree && existsSync(join(trustedTree, 'os/release-keys'))) t = addKeyDir(t, join(trustedTree, 'os/release-keys'), 'running release');
  const op = layout(dataRoot).trustedKeys;
  if (existsSync(op)) t = addKeyDir(t, op, 'operator (release-trusted-keys)');
  return t;
}

/** The signed metadata of a release from the mirror's tag, verified with `trust` and bound to the record. */
export function verifiedMetaOf(dataRoot, rec, trust) {
  const tag = `v${rec.version}`;
  const { metaBytes, sigBytes } = readTagRelease(layout(dataRoot).mirror, tag);
  if (!metaBytes) refuse('verify-no-signature', `${tag} carries no signed metadata in the mirror`);
  let r;
  try { r = verifyMeta(metaBytes, sigBytes, trust, { commit: rec.commit, gitTree: rec.gitTree, version: rec.version }); } catch (e) {
    if (e instanceof ReleaseVerifyError) refuse(`verify-${e.code}`, `release ${rec.id}: ${e.message}`);
    throw e;
  }
  if (rec.meta?.metaDigest && r.metaDigest !== rec.meta.metaDigest) refuse('verify-meta-moved', `release ${rec.id}: the signed metadata differs from the one it was built from`);
  return r.meta;
}

/**
 * Re-verify a built release before it runs (owner answer a): complete, the
 * record names it, the finalized tree hashes to the recorded `treeDigest`
 * (a tampered release is refused), and a signed release's metadata verifies
 * with the CURRENT trust. Returns `{ record, meta }` (`meta` null for main).
 */
export function verifyRelease(dataRoot, id, { trustedTree, trust, checkSignature = true } = {}) {
  assertReleaseId(id);
  const dir = layout(dataRoot).release(id);
  if (!existsSync(dir)) refuse('no-release', `release ${id} is not on disk`);
  if (!existsSync(join(dir, COMPLETE_MARKER))) refuse('incomplete', `release ${id} is incomplete (no ${COMPLETE_MARKER})`);
  const record = readJson(join(dir, RELEASE_RECORD));
  if (!record || record.v !== 1 || record.id !== id) refuse('bad-record', `release ${id} has no valid ${RELEASE_RECORD}`);
  const digest = `sha256:${gitTreeOfDir(dir, { algo: 'sha256', skip: [RELEASE_RECORD, COMPLETE_MARKER] })}`;
  if (digest !== record.treeDigest) refuse('tree-digest-mismatch', `release ${id} was changed after it was built (tree ${digest}, recorded ${record.treeDigest})`);
  let meta = null;
  if (checkSignature && record.meta?.signed) meta = verifiedMetaOf(dataRoot, record, trust ?? currentTrust(dataRoot, trustedTree));
  return { record, meta };
}

// ── preflight (the shell, before anything moves) ────────────────────────────

/** Bytes used by a directory tree (du -sk; 0 when unknown). */
function treeBytes(dir) {
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
  const kb = Number((r.stdout ?? '').split(/\s/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}
function freeBytes(dir) {
  const r = spawnSync('df', ['-Pk', dir], { encoding: 'utf8' });
  const kb = Number((r.stdout ?? '').trim().split('\n').pop()?.split(/\s+/)[3]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * The activation preflight: lock free, no held state, the target verifies,
 * the channel rule (no silent downgrade: a `signed` install never activates
 * an unsigned release; switching the channel is its own decision), free disk
 * ≥ 2× the current release (the snapshot and the next build), `minFrom`.
 * Returns `{ blockers, warnings, record, meta, binding }`.
 */
export function preflight(dataRoot, { id, trustedTree, channel = 'signed', trust, measureDisk = true, now = Date.now() } = {}) {
  const blockers = [];
  const warnings = [];
  const L = layout(dataRoot);
  const ptr = readPointer(dataRoot);
  if (!ptr?.current) blockers.push({ code: 'no-release', message: 'this install does not run from a release (no pointer)' });
  if (ptr?.current === id) blockers.push({ code: 'already-current', message: `release ${id} is already current` });
  const lk = lockStatus(L.lock, { now });
  if (lk.held && !lk.stale) blockers.push({ code: 'activation-busy', message: `another release job holds the activation lock (${lk.holder?.by ?? 'job'} ${lk.holder?.jobId ?? ''})` });
  const held = readWritesHeld(dataRoot);
  if (held) blockers.push({ code: 'writes-held', message: `the last activation (${held.jobId ?? 'unknown job'}) never accepted writes: roll back or accept it first` });
  let record = null;
  let meta = null;
  try {
    ({ record, meta } = verifyRelease(dataRoot, id, { trustedTree, trust }));
  } catch (e) {
    if (!(e instanceof ActivateError)) throw e;
    blockers.push({ code: e.code, message: e.message });
  }
  if (record) {
    if (channel === 'signed' && record.channel !== 'signed') {
      blockers.push({ code: 'channel-downgrade', message: `release ${id} is from the unsigned main channel; this install follows signed releases (switching the channel is its own decision, D64 update-channel)` });
    }
    if (record.channel === 'signed' && !record.meta?.signed) blockers.push({ code: 'unsigned', message: `release ${id} claims the signed channel but carries no signature` });
    const cur = ptr?.current ? readRelease(dataRoot, ptr.current) : null;
    if (meta?.minFrom && cur?.version && compareSemver(cur.version, meta.minFrom) < 0) {
      blockers.push({ code: 'min-from', message: `release ${record.version} updates only from ${meta.minFrom} or later (running ${cur.version}); update to an intermediate release first` });
    }
    if (cur && record.composition !== cur.composition) warnings.push({ code: 'composition', message: `the composition changes: ${cur.composition} → ${record.composition}` });
    if (measureDisk && cur) {
      const need = 2 * treeBytes(L.release(cur.id));
      const free = freeBytes(L.root);
      if (free !== null && need > 0 && free < need) blockers.push({ code: 'disk', message: `not enough free disk on the data volume: ${Math.round(free / 2 ** 20)} MiB free, ${Math.round(need / 2 ** 20)} MiB needed (2× the current release)` });
    }
  }
  return { blockers, warnings, record, meta, binding: record ? bindingOf(record) : null };
}

/** The payload of the approval `system.release.activate` (core release/types.ts ReleaseActivationBinding). */
export function bindingOf(rec) {
  return {
    releaseId: rec.id,
    commit: rec.commit,
    treeDigest: rec.treeDigest,
    metaDigest: rec.meta?.metaDigest ?? null,
    provenance: rec.provenance,
    composition: rec.composition,
    series: { digest: rec.series?.digest ?? null, base: rec.series?.base ?? null, order: rec.series?.order ?? [] },
    infraDigest: rec.infraDigest ?? null,
  };
}

/** True when two bindings are the same release (the approved one is the one switched to). */
export const sameBinding = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── the rollback rules (5b owner answer 1, D95 §14) ─────────────────────────

/**
 * Whether a manual rollback from the current release to the previous one
 * would bring back a vulnerability a newer signed security update fixed.
 * The current release (or any signed release on disk newer than the target)
 * that is a signed `securityUpdate` supersedes the target. `critical`: never
 * (refused whatever the owner says); otherwise only with the owner's explicit
 * confirmation naming the advisories. Automatic rollbacks before accepting
 * writes are not checked (the system never left the old release's exposure).
 * Returns `{ allowed, needsConfirmation, critical, advisories, reason }`.
 */
export function rollbackSecurity(dataRoot, { from, to, confirmInsecure } = {}) {
  const target = readRelease(dataRoot, to);
  const fixes = [];
  const candidates = new Set([from, ...(existsSync(layout(dataRoot).releases) ? readdirSync(layout(dataRoot).releases).filter((n) => !n.startsWith('.')) : [])]);
  for (const id of candidates) {
    const r = id ? readRelease(dataRoot, id) : null;
    if (!r || r.id === to || r.meta?.signed !== true || r.meta?.securityUpdate !== true) continue;
    // Newer than the target: by version when both are versioned, else the release being left.
    const newer = target?.version && r.version ? compareSemver(r.version, target.version) > 0 : r.id === from;
    if (newer) fixes.push(r);
  }
  if (!fixes.length) return { allowed: true, needsConfirmation: false, critical: false, advisories: [], reason: null };
  const critical = fixes.some((r) => r.meta?.severity === UNROLLBACKABLE_SEVERITY);
  const advisories = [...new Set(fixes.flatMap((r) => r.meta?.advisories ?? [`security update ${r.version ?? r.id}`]))];
  const names = fixes.map((r) => r.version ?? r.id).join(', ');
  if (critical) {
    return { allowed: false, needsConfirmation: false, critical: true, advisories, reason: `the signed critical security update ${names} fixed a vulnerability that ${target?.version ?? to} still has: a rollback past a resolved critical fix is never allowed` };
  }
  const confirmed = typeof confirmInsecure === 'string' && advisories.every((a) => confirmInsecure.split(',').map((s) => s.trim()).includes(a));
  return {
    allowed: confirmed, needsConfirmation: !confirmed, critical: false, advisories,
    reason: confirmed ? null : `the signed security update ${names} fixed ${advisories.join(', ')}; rolling back to ${target?.version ?? to} brings it back: confirm explicitly naming the advisories`,
  };
}

/** The pointer rule for a manual rollback: there must be a complete previous release. */
export function rollbackTarget(dataRoot) {
  const ptr = readPointer(dataRoot);
  if (!ptr?.current) refuse('no-release', 'this install does not run from a release (no pointer)');
  if (!ptr.previous) refuse('no-previous', 'there is no previous release to roll back to (a rollback clears it; update to roll forward)');
  if (!readRelease(dataRoot, ptr.previous)) refuse('previous-missing', `the previous release ${ptr.previous} is not on disk or incomplete`);
  return { from: ptr.current, to: ptr.previous };
}

// ── snapshot and restore (Q35) ──────────────────────────────────────────────

function cpTree(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  const r = spawnSync('cp', ['-a', '--reflink=auto', src, dst], { encoding: 'utf8' });
  if (r.status !== 0) throw new ActivateError('copy-failed', `cp ${src} ${dst}: ${(r.stderr || r.error?.message || '').trim()}`, { exit: 1 });
}

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function filesUnder(top, base) {
  const out = [];
  const walk = (p) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
    else if (st.isFile()) out.push({ path: relative(base, p).split(sep).join('/'), sha256: sha256File(p) });
  };
  if (existsSync(top)) walk(top);
  return out;
}

const listDigest = (files) => createHash('sha256').update(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))).digest('hex');

function assertDataPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '')) refuse('bad-path', `a snapshot path must be a relative path under the data root: ${JSON.stringify(rel)}`);
  if (rel === 'releases' || rel.startsWith('releases/') || rel === 'aura/release' || rel.startsWith('aura/release/')) refuse('bad-path', `the release layout is never snapshotted: ${rel}`);
}

/**
 * The data snapshot before the switch (the kernel is stopped: Valkey wrote
 * its dump/AOF on shutdown). `kv/` plus every path the target's declared
 * migrations touch. Written into `<fromId>-<ts>.tmp`, then renamed: a
 * snapshot is complete or absent.
 */
export function snapshot(dataRoot, { from, to, jobId, paths, now = new Date() }) {
  assertJobId(jobId);
  assertReleaseId(from);
  assertReleaseId(to);
  const L = layout(dataRoot);
  const target = readRelease(dataRoot, to);
  const roots = [...new Set([KV_DIR, ...(paths ?? (target?.migrations ?? []).flatMap((m) => m.paths ?? []))])];
  roots.forEach(assertDataPath);
  const id = `${from}-${compactTs(now)}`;
  const dir = join(L.snapshots, id);
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'data'), { recursive: true });
  const present = [];
  for (const rel of roots) {
    const src = join(dataRoot, rel);
    if (!existsSync(src)) continue;
    cpTree(src, join(tmp, 'data', rel));
    present.push(rel);
  }
  const files = filesUnder(join(tmp, 'data'), join(tmp, 'data'));
  const st = readJson(join(dataRoot, BOOT_STATUS));
  const record = {
    v: 1, id, fromRelease: from, toRelease: to, jobId, createdAt: nowIso(now),
    valkeyVersion: st?.kv?.version ?? null, files, sha256: listDigest(files),
  };
  // roots.json: which top paths were taken (and which did not exist yet: restoring removes those).
  writeJsonDurable(join(tmp, 'roots.json'), { roots, present });
  writeJsonDurable(join(tmp, 'snapshot.json'), record);
  renameSync(tmp, dir);
  return record;
}

/** A snapshot's files hash to its record (nothing was changed or lost). */
export function checkSnapshot(dataRoot, snapId) {
  const dir = join(layout(dataRoot).snapshots, snapId);
  const rec = readJson(join(dir, 'snapshot.json'));
  if (!rec || rec.id !== snapId) refuse('no-snapshot', `snapshot ${snapId} not found`);
  const files = filesUnder(join(dir, 'data'), join(dir, 'data'));
  if (listDigest(files) !== rec.sha256) refuse('snapshot-corrupt', `snapshot ${snapId} does not match its record`);
  return rec;
}

/**
 * Put a snapshot back (the kernel must be stopped). What it replaces moves
 * to `<snapshot>/replaced-<ts>/` (recoverable, never deleted here); then
 * the snapshot's copy goes into place and is checked again.
 */
export function restore(dataRoot, { snapshot: snapId, now = new Date() }) {
  if (typeof snapId !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,140}$/.test(snapId)) refuse('bad-snapshot', `bad snapshot id ${JSON.stringify(snapId)}`);
  const rec = checkSnapshot(dataRoot, snapId);
  const dir = join(layout(dataRoot).snapshots, snapId);
  const { roots = [KV_DIR], present = roots } = readJson(join(dir, 'roots.json')) ?? {};
  const aside = join(dir, `replaced-${compactTs(now)}`);
  for (const rel of roots) {
    assertDataPath(rel);
    const live = join(dataRoot, rel);
    if (existsSync(live)) {
      mkdirSync(dirname(join(aside, rel)), { recursive: true });
      renameSync(live, join(aside, rel));
    }
    if (present.includes(rel)) cpTree(join(dir, 'data', rel), live);
  }
  const back = roots.filter((r) => present.includes(r)).flatMap((rel) => filesUnder(join(dataRoot, rel), dataRoot));
  if (listDigest(back) !== rec.sha256) refuse('restore-mismatch', `the restored data does not match snapshot ${snapId}`);
  return { snapshot: snapId, restored: present, replacedKeptAt: relative(dataRoot, aside) };
}

// ── the switch and the hold ─────────────────────────────────────────────────

/** pointer.json → `{current: to, previous: <current>}` (temp + fsync + rename), then writes-held. */
export function switchTo(dataRoot, { to, jobId, snapshot: snapId = null, now = new Date() }) {
  assertJobId(jobId);
  const L = layout(dataRoot);
  const ptr = readPointer(dataRoot);
  if (!ptr?.current) refuse('no-release', 'no current release to switch from');
  if (!readRelease(dataRoot, to)) refuse('incomplete', `release ${to} is not complete`);
  if (ptr.current === to) refuse('already-current', `release ${to} is already current`);
  // The hold first: a crash between the two leaves the OLD release held, which the owner sees and accepts.
  holdWrites(dataRoot, { jobId, from: ptr.current, to, snapshot: snapId, now });
  return writePointer(dataRoot, { current: to, previous: ptr.current, jobId, now });
}

/**
 * The ONE pointer writer (temp + fsync + rename, durable.mjs): the updater's switch and revert and the host
 * recovery (os/release-ctl.sh use|rollback) all write pointer.json through it. The caller holds the lock.
 */
export function writePointer(dataRoot, { current, previous = null, jobId, now = new Date() }) {
  assertReleaseId(current);
  if (previous !== null) assertReleaseId(previous);
  const next = { v: 1, current, previous, switchedAt: nowIso(now), jobId };
  writeJsonDurable(layout(dataRoot).pointer, next);
  return next;
}

/** Roll the pointer back: `{current: previous, previous: null}` (a second rollback has no target). */
export function revert(dataRoot, { jobId, now = new Date() }) {
  assertJobId(jobId);
  const ptr = readPointer(dataRoot);
  if (!ptr?.current) refuse('no-release', 'no pointer');
  if (!ptr.previous) refuse('no-previous', 'there is no previous release to go back to');
  if (!readRelease(dataRoot, ptr.previous)) refuse('previous-missing', `the previous release ${ptr.previous} is not complete`);
  return writePointer(dataRoot, { current: ptr.previous, previous: null, jobId, now });
}

export function holdWrites(dataRoot, { jobId, from = null, to = null, snapshot: snapId = null, now = new Date() }) {
  const f = layout(dataRoot).writesHeld;
  mkdirSync(dirname(f), { recursive: true });
  const m = { v: WRITES_HELD_VERSION, jobId, from, to, snapshot: snapId, at: nowIso(now) };
  writeJsonDurable(f, m);
  return m;
}

/** Remove the hold marker (the accept-writes route, or the updater's fallback). */
export function releaseHold(dataRoot) {
  const f = layout(dataRoot).writesHeld;
  try { unlinkSync(f); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// ── health (step 9) ─────────────────────────────────────────────────────────

/**
 * The new kernel's verdict from status.json: a boot that started after
 * `since`, `kernelReadyAt` set, no boot error, and every service app
 * `resumed` with a `readyAt`. `{ ok, waiting: [...], failed?: reason }`.
 */
export function health(dataRoot, { since }) {
  const st = readJson(join(dataRoot, BOOT_STATUS));
  if (!st) return { ok: false, waiting: ['status.json'] };
  if (since && (!st.startedAt || st.startedAt < since)) return { ok: false, waiting: ['a boot after the switch'] };
  if (st.error) return { ok: false, waiting: [], failed: `the kernel boot failed: ${String(st.error).slice(0, 300)}` };
  if (st.stoppedAt && st.stoppedAt >= st.startedAt) return { ok: false, waiting: ['kernel (stopped)'] };
  if (!st.kernelReadyAt) return { ok: false, waiting: ['kernel'] };
  const waiting = Object.entries(st.services ?? {}).filter(([, s]) => s.state !== 'resumed' || !s.readyAt).map(([app, s]) => `${app} (${s.state})`);
  return { ok: waiting.length === 0, waiting, acceptingWrites: st.acceptingWrites === true, systemId: st.systemId ?? null };
}

// ── accept writes (step 10) ─────────────────────────────────────────────────

/**
 * The updater's accept-writes call: a one-time operator ticket for exactly
 * this request (core setupTickets, from the trusted tree's built core), then
 * the POST. If the API cannot be reached after a healthy probe, the marker is
 * removed directly (the shell re-reads it) and the result says so.
 */
export async function accept(dataRoot, { jobId, trustedTree, url = 'http://aura-shell:3000', fetchImpl = globalThis.fetch, ticket } = {}) {
  assertJobId(jobId);
  const held = readWritesHeld(dataRoot);
  if (!held) return { ok: true, via: 'none', note: 'writes were already accepted' };
  if (held.jobId && held.jobId !== jobId) refuse('not-this-job', `the hold belongs to job ${held.jobId}, not ${jobId}`);
  let code = null;
  try {
    code = ticket ? await ticket() : await operatorTicket(dataRoot, trustedTree, 'POST', ACCEPT_WRITES_PATH);
  } catch (e) {
    code = null;
    process.stderr.write(`[activate] no operator ticket (${e.message}); falling back to the marker\n`);
  }
  if (code) {
    try {
      const res = await fetchImpl(`${url}${ACCEPT_WRITES_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-aura-operator': code }, body: JSON.stringify({ jobId }),
      });
      if (res.ok) return { ok: true, via: 'api' };
      const body = await res.text().catch(() => '');
      // A refusal is an answer: never override it with the marker.
      if (res.status !== 503 && res.status < 500) refuse('accept-refused', `accept-writes answered ${res.status}: ${body.slice(0, 300)}`);
    } catch (e) {
      if (e instanceof ActivateError) throw e;
    }
  }
  releaseHold(dataRoot);
  return { ok: true, via: 'marker', note: 'the accept-writes API was unreachable after a healthy probe: the marker was removed (the shell re-reads it)' };
}

async function operatorTicket(dataRoot, trustedTree, method, path) {
  if (!trustedTree) throw new Error('no trusted tree');
  const mod = await import(pathToFileURL(join(trustedTree, 'packages/core/dist/auth/setupTickets.js')).href);
  return mod.createSetupTicket(dataRoot, { purpose: 'operator', subject: mod.operatorRequestSubject(method, path) }).code;
}

// ── system apps that changed (step 11) ──────────────────────────────────────

/** App components whose source tree differs between two release records (or that are new). */
export function changedApps(fromRec, toRec) {
  const trees = (r) => new Map((r?.components?.source ?? []).filter((c) => c.kind === 'app').map((c) => [c.name, c.tree]));
  const a = trees(fromRec);
  return [...trees(toRec)].filter(([name, tree]) => a.get(name) !== tree).map(([name]) => name);
}

// ── the lock for a whole job ────────────────────────────────────────────────

/** Takes the system lock for `jobId` (lock.mjs: heartbeat every 30 s while this process lives). */
export function takeLock(dataRoot, { jobId, by = 'system.release.activate' }) {
  assertJobId(jobId);
  try { return acquireLock(layout(dataRoot).lock, { jobId, by }); } catch (e) {
    if (e instanceof LockError) throw new ActivateError(e.code, e.message, { detail: e.holder });
    throw e;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const out = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const str = (v) => (typeof v === 'string' ? v : undefined);

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv, []);
  const [cmd] = a._;
  const data = str(a.data);
  const usage = () => { process.stderr.write('usage: activate.mjs status|hold-lock|verify|preflight|rollback-check|snapshot|switch|health|accept|revert|restore|release-hold … (see the file header)\n'); return 64; };
  if (!data) return usage();
  try {
    switch (cmd) {
      case 'status': out({ ok: true, ...status(data) }); return 0;
      case 'hold-lock': {
        const lock = takeLock(data, { jobId: str(a.job), by: str(a.by) ?? 'system.release.activate' });
        out({ ok: true, jobId: lock.jobId, brokeStale: lock.brokeStale?.jobId ?? null });
        await new Promise((resolve) => {
          const stop = () => { lock.release(); resolve(); };
          process.once('SIGTERM', stop);
          process.once('SIGINT', stop);
          // Hold while the job runs; a lost lock (stale takeover) ends the holder.
          const t = setInterval(() => { if (!lock.owned()) { clearInterval(t); resolve(); } }, 5_000);
        });
        return 0;
      }
      case 'verify': {
        const r = verifyRelease(data, str(a.id), { trustedTree: str(a.trusted) });
        out({ ok: true, id: r.record.id, provenance: r.record.provenance, signed: Boolean(r.meta), binding: bindingOf(r.record) });
        return 0;
      }
      case 'preflight': {
        const r = preflight(data, { id: str(a.id), trustedTree: str(a.trusted), channel: str(a.channel) ?? 'signed' });
        out({ ok: r.blockers.length === 0, blockers: r.blockers, warnings: r.warnings, binding: r.binding, securityUpdate: r.record?.meta?.securityUpdate === true });
        return r.blockers.length ? 3 : 0;
      }
      case 'rollback-check': {
        const t = rollbackTarget(data);
        const s = rollbackSecurity(data, { ...t, confirmInsecure: str(a['confirm-insecure']) });
        out({ ok: s.allowed, ...t, ...s });
        return s.allowed ? 0 : 3;
      }
      case 'snapshot': {
        const ptr = readPointer(data);
        out({ ok: true, ...snapshot(data, { from: str(a.from) ?? ptr?.current, to: str(a.to), jobId: str(a.job) }) });
        return 0;
      }
      case 'switch': out({ ok: true, pointer: switchTo(data, { to: str(a.to), jobId: str(a.job), snapshot: str(a.snapshot) ?? null }) }); return 0;
      case 'health': { const h = health(data, { since: str(a.since) }); out(h); return h.ok ? 0 : (h.failed ? 1 : 2); }
      case 'accept': out(await accept(data, { jobId: str(a.job), trustedTree: str(a.trusted), url: str(a.url) })); return 0;
      case 'revert': out({ ok: true, pointer: revert(data, { jobId: str(a.job) }) }); return 0;
      case 'restore': out({ ok: true, ...restore(data, { snapshot: str(a.snapshot) }) }); return 0;
      case 'release-hold': out({ ok: true, removed: releaseHold(data) }); return 0;
      default: return usage();
    }
  } catch (e) {
    if (e instanceof ActivateError) { out({ ok: false, code: e.code, error: e.message, ...(e.detail ? { detail: e.detail } : {}) }); return e.exit; }
    if (e instanceof ReleaseVerifyError) { out({ ok: false, code: `verify-${e.code}`, error: e.message }); return 3; }
    if (/^bad (job|release) id/.test(e.message)) { out({ ok: false, code: 'usage', error: e.message }); return 64; }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
