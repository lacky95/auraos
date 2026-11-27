#!/usr/bin/env node
// AuraOS release builder (Phase 6 stream B; D7, D68, D71, D94, Q34).
//
// The ONE entry that turns a verified Git revision into a release:
// `build(...)` is used by install.sh (first install, from the host), by the
// updater (stream U, from the running release's copy) and by Phase 7 system
// patches (the series slot). It runs from the TRUSTED side only (the
// installer's or the running release's copy of this file); nothing of the
// candidate runs outside the throwaway build container.
// Dependency-free (node, git, the docker CLI), like os/release-verify.mjs.
//
// It needs the data volume twice: as a local directory (`dataRoot`: `/data`
// inside AuraOS, the volume's mountpoint on the host) for its own file work,
// and by name (`dataVolume`) for the volume-subpath mounts of the build
// containers, so both views are the same files.
//
// Job steps (each one a line of the job checklist, aura/release/jobs/<job>.json,
// in SelfUpdater's step format):
//   lock       the one `system` activation lock, for the whole job (lock.mjs = core release/lock.ts's format)
//   source     fetch into the bare mirror aura/release/mirror.git (D94 git config), never /workspace
//   verify     the signed release metadata against commit and tree (D71) BEFORE anything of it runs
//   stage      git archive → releases/.staging-<job>; its tree must equal the verified tree (no .git)
//   series     the D68 series slot (series-slot.mjs, Phase 7b): the store's active series (or the one
//              passed) read, validated and applied whole to the staging tree; a conflict = needs-repair
//   images     aura-shell:<fp> and aura-base:<fp> through BuildKit; reused when the fingerprint exists
//   base-check node -v of both images against engines.node of the staged package.json
//   deps       pnpm install --frozen-lockfile in a throwaway container (offline first, then the network)
//   build      packages, shell bundle, system apps (os/release/build.sh, --network none)
//   check      server.mjs --check in a throwaway container (--network none)
//   manifest   release.json v1 (components, composition, provenance, digests)
//   finalize   read-only, atomic rename to releases/<id>, `.complete` last
//   gc         keep current + previous (+ the new release); other releases, staging, images go
// A failure at any step leaves the current release, the pointer and every
// other release untouched; the staging tree is removed.
//
// CLI (JSON result on stdout; progress on stderr; exit 0 ok, 1 failed, 3 refused, 64 usage):
//   builder.mjs build --data-root D --data-volume V [--data-subpath P] --fetch-from URL|PATH
//                     [--channel signed|main] [--maturity M] [--ref REF] [--expect-commit SHA]
//                     [--keys DIR]... [--key FILE]... [--pin ID]... [--composition desktop|server]
//                     [--infra FILE] [--first-install] [--job ID]
//                     [--series-dir DIR | --series-store DIR --series-rev REV | --no-series]
//                     [--validate-only] [--image-change-approved] [--expect-series-digest D] [--expect-inputs FILE]
//   builder.mjs series-plan --series-dir DIR [--commit SHA]   (Phase 7b: what an operator authorizes)
//   builder.mjs series-import --data-root D --series-dir DIR --digest D [--source S] [--ref R] [--by TEXT]
//   (build … --series-store S --series-rev R --mark-installed: an install-time series, approved + active on success)
//   builder.mjs status --data-root D
//   builder.mjs gc --data-root D [--data-volume V]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReleaseVerifyError, gitTreeOfDir, parseArgs, provenanceOf, selectRelease, emptyTrust, trustFrom,
} from '../release-verify.mjs';
import { renameDurable, writeFileDurable, writeJsonDurable } from './durable.mjs';
import { LockError, acquireLock, lockStatus } from './lock.mjs';
import { imageFingerprint, parseDockerfile, satisfiesNode, targetsOf } from './images.mjs';
import {
  COMPLETE_MARKER, RELEASE_RECORD, STAGING_PREFIX, assertReleaseId, layout, newJobId, subpathOf,
} from './layout.mjs';
import {
  EMPTY_SERIES_DIGEST, SeriesSlotError, applyToStaging, dependencyInputPaths, imageInputPaths, importStore, markInstalled, readSeriesInput, seriesForBuild, seriesIdentity, touchedComponents,
} from './series-slot.mjs';

export const RELEASE_RECORD_VERSION = 1;
export const COMPOSITIONS = Object.freeze(['desktop', 'server']);
export const SHELL_TARGET = 'release';          // stream L's Dockerfile target
export const SHELL_TARGET_PRE_L = 'development'; // until L adds `release` (recorded in images.target)
export const BASE_TARGET = 'aura-base';

export const BUILD_STEPS = Object.freeze([
  { key: 'lock', label: 'Activation lock taken' },
  { key: 'source', label: 'Source fetched into the mirror' },
  { key: 'verify', label: 'Release verified (signature, commit, tree)' },
  { key: 'stage', label: 'Staging tree extracted and matches the verified tree' },
  { key: 'series', label: 'System patch series validated and applied (D68)' },
  { key: 'images', label: 'Images built or reused' },
  { key: 'base-check', label: 'Image Node versions satisfy engines.node' },
  { key: 'deps', label: 'Dependencies installed (frozen lockfile, throwaway container)' },
  { key: 'build', label: 'Packages, shell and system apps built (throwaway container)' },
  { key: 'check', label: 'server.mjs --check passed' },
  { key: 'manifest', label: 'release.json written' },
  { key: 'finalize', label: 'Release finalized (read-only, complete)' },
  { key: 'gc', label: 'Old releases removed (current + previous kept)' },
  { key: 'complete', label: 'Done: process finished and acknowledged' },
]);

export class BuildError extends Error {
  constructor(code, message, { step, exit = 1 } = {}) { super(message); this.code = code; this.step = step; this.exit = exit; }
}
const refuse = (code, message) => { throw new BuildError(code, message, { exit: 3 }); };

// ── process helpers ─────────────────────────────────────────────────────────

/** Runs a command asynchronously (the lock heartbeat keeps ticking); resolves { code, out }. */
export function run(cmd, args, { env, cwd, input, timeoutMs = 0, onLine, name } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const keep = (d) => {
      const s = d.toString();
      out = (out + s).slice(-64_000);
      if (onLine) for (const l of s.split('\n')) if (l) onLine(l);
    };
    const child = spawn(cmd, args, { env: env ?? process.env, cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    if (input) input(child.stdin);
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        keep(`\n[builder] timed out after ${Math.round(timeoutMs / 1000)} s\n`);
        if (name) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 });
        child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: 127, out: `${out}\n${e.message}` }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

/** `git archive <commit> | tar -x -C dir`, both statuses checked. */
function archiveInto(mirror, commit, dir, env) {
  return new Promise((resolve) => {
    const ga = spawn('git', ['-C', mirror, 'archive', '--format=tar', commit], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    ga.stderr.on('data', (d) => { err += d; });
    tar.stderr.on('data', (d) => { err += d; });
    ga.stdout.pipe(tar.stdin);
    let gaCode = null;
    ga.on('close', (c) => { gaCode = c; });
    tar.on('close', (c) => resolve({ ok: c === 0 && gaCode === 0, err }));
  });
}

const sha256File = (f) => `sha256:${createHash('sha256').update(readFileSync(f)).digest('hex')}`;
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Makes a tree writable again (u+w on dirs and files; symlinks untouched) so it can be removed. */
function makeWritable(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) return;
  try { chmodSync(p, st.mode | 0o200); } catch { /* best effort */ }
  if (st.isDirectory()) for (const n of readdirSync(p)) makeWritable(join(p, n));
}
export function removeTree(p) {
  if (!existsSync(p)) return;
  makeWritable(p);
  rmSync(p, { recursive: true, force: true });
}

/** Read-only for everyone (a-w), except the top dir (finalize writes `.complete` into it last). */
function makeReadOnly(top) {
  const walk = (p, isTop) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n), false);
    if (!isTop) chmodSync(p, st.mode & ~0o222);
  };
  walk(top, true);
}

// ── pointer (the first install writes it; switching is stream U's activate) ─

export const readPointer = (dataRoot) => readJson(layout(dataRoot).pointer);

/** The very first pointer of an install: there is no previous release, no data to snapshot. */
export function writeFirstPointer(dataRoot, { id, jobId, now = new Date() }) {
  const L = layout(dataRoot);
  assertReleaseId(id);
  if (existsSync(L.pointer)) refuse('pointer-exists', 'a release is already current: switching releases is an activation (stream U), not a first install');
  if (!existsSync(join(L.release(id), COMPLETE_MARKER))) refuse('incomplete', `release ${id} is not complete`);
  mkdirSync(dirname(L.pointer), { recursive: true });
  const p = { v: 1, current: id, previous: null, switchedAt: now.toISOString(), jobId };
  writeJsonDurable(L.pointer, p);
  return p;
}

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

// ── GC (Q34: keep current + previous) ───────────────────────────────────────

/**
 * Removes every release that is not current, previous or in `keep`, every
 * staging dir but `activeJob`'s, and leftover per-job secret dirs. Images of
 * removed releases go too unless a kept release uses them (a running image
 * refuses removal; that is fine). Call it under the activation lock only.
 */
export async function gc({ dataRoot, keep = [], activeJob = null, docker = 'docker', log = () => {} }) {
  const L = layout(dataRoot);
  const ptr = readPointer(dataRoot);
  const kept = new Set([ptr?.current, ptr?.previous, ...keep].filter(Boolean));
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
  const images = [];
  for (const img of imagesOfRemoved) {
    if (imagesInUse.has(img)) continue;
    const r = await run(docker, ['image', 'rm', img]);
    if (r.code === 0) images.push(img);
  }
  return { removed, images, kept: [...kept] };
}

// ── the build ───────────────────────────────────────────────────────────────

function newJob(id, opts) {
  return {
    id, kind: 'release-build', phase: 'running', startedAt: new Date().toISOString(),
    steps: BUILD_STEPS.map((s) => ({ ...s, status: 'pending' })),
    input: {
      channel: opts.channel, maturity: opts.maturity ?? null, ref: opts.ref ?? null,
      composition: opts.composition, firstInstall: Boolean(opts.firstInstall),
    },
    log: [],
  };
}

/** Normalised D94 build inputs (`--infra FILE`); no config = today's behaviour. */
export function infraInputs(x) {
  const i = x ?? {};
  return {
    digest: i.digest ?? null,
    buildArgs: i.buildArgs ?? {},
    env: i.env ?? {},
    secrets: i.secrets ?? {},        // { id: file } BuildKit secret files (never args, env or layers)
    publicContext: i.publicContext ?? null,
    caBundle: i.caBundle ?? null,
    gitConfig: i.gitConfig ?? null,
  };
}

/** Container mounts and env for the throwaway build (no socket, no home, no /data beyond these). */
export function buildContainerArgs({ name, image, dataVolume, stagingSub, storeSub, publicSub, secretsSub, env = {}, network, limits = {} }) {
  const a = [
    'run', '--rm', '--name', name,
    '--network', network,
    '--pids-limit', String(limits.pids ?? 2048), '--memory', limits.memory ?? '6g', '--cpus', String(limits.cpus ?? 2),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--workdir', '/workspace',
    '--mount', `type=volume,source=${dataVolume},target=/workspace,volume-subpath=${stagingSub}`,
    '--mount', `type=volume,source=${dataVolume},target=/pnpm-store,volume-subpath=${storeSub}`,
  ];
  if (publicSub) a.push('--mount', `type=volume,source=${dataVolume},target=/etc/aura/build-infra,volume-subpath=${publicSub},readonly`);
  if (secretsSub) a.push('--mount', `type=volume,source=${dataVolume},target=/run/aura-build,volume-subpath=${secretsSub},readonly`);
  const e = { HOME: '/tmp', npm_config_store_dir: '/pnpm-store', ...env };
  for (const [k, v] of Object.entries(e)) a.push('-e', `${k}=${v}`);
  a.push('--entrypoint', 'sh', image);
  return a;
}

/**
 * The resolved inputs of a build (Phase 7b binding): lockfile digest, the package manager pin, the
 * Node versions of both images, the image ids, and, when the series changes the images, the
 * digest of every external base image the Dockerfile names (local RepoDigests, else the registry
 * manifest through buildx imagetools: metadata only, nothing runs).
 */
export async function resolveInputs({ docker, staging, images, node, rebuildsImage = false, pinBases = false }) {
  const pkg = readJson(join(staging, 'package.json')) ?? {};
  const imageId = async (ref) => {
    const r = await run(docker, ['image', 'inspect', '--format', '{{.Id}}', ref]);
    return r.code ? null : (r.out.trim().split('\n').pop() || null);
  };
  const from = {};
  if (pinBases) {
    const stages = parseDockerfile(readFileSync(join(staging, 'Dockerfile'), 'utf8'));
    const names = new Set(stages.map((x) => x.name));
    for (const ref of [...new Set(stages.map((x) => x.base).filter((b) => b && !names.has(b) && b !== 'scratch' && !b.includes('$')))].sort()) {
      let digest = null;
      if (/@sha256:[0-9a-f]{64}$/.test(ref)) digest = ref.slice(ref.indexOf('@') + 1);
      if (!digest) {
        const r = await run(docker, ['image', 'inspect', '--format', '{{json .RepoDigests}}', ref]);
        try { const d = JSON.parse(r.out.trim().split('\n').pop() || '[]')[0]; if (!r.code && d) digest = d.slice(d.indexOf('@') + 1); } catch { /* not local */ }
      }
      if (!digest) {
        const r = await run(docker, ['buildx', 'imagetools', 'inspect', '--raw', ref]);
        if (!r.code && r.out.trim()) digest = `sha256:${createHash('sha256').update(r.out.trim()).digest('hex')}`;
      }
      from[ref] = digest;
    }
  }
  return {
    lockfileHash: existsSync(join(staging, 'pnpm-lock.yaml')) ? sha256File(join(staging, 'pnpm-lock.yaml')) : null,
    packageManager: typeof pkg.packageManager === 'string' ? pkg.packageManager : null,
    node: { base: node.base ?? null, shell: node.shell ?? null },
    images: { base: await imageId(images.base), shell: await imageId(images.shell) },
    rebuildsImage,
    from,
  };
}

/** What differs between approved and resolved inputs (empty: the same build). */
export function inputsDiff(want, got) {
  const out = [];
  const cmp = (k, a, b) => { if ((a ?? null) !== (b ?? null)) out.push(`${k} ${a ?? 'none'} → ${b ?? 'none'}`); };
  cmp('lockfile', want.lockfileHash, got.lockfileHash);
  cmp('packageManager', want.packageManager, got.packageManager);
  cmp('node(base)', want.node?.base, got.node?.base);
  cmp('node(shell)', want.node?.shell, got.node?.shell);
  // Reused images must be the very same; images the series rebuilds are pinned by their bases.
  if (!want.rebuildsImage) { cmp('image(base)', want.images?.base, got.images?.base); cmp('image(shell)', want.images?.shell, got.images?.shell); }
  for (const [ref, d] of Object.entries(want.from ?? {})) cmp(`base image ${ref}`, d, got.from?.[ref]);
  return out;
}

const touchedNote = (series) => (series.touched?.length ? ` (system patches touch ${series.touched.map((t) => t.component).join(', ')})` : '');
const shortHash = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 8);

/** Release id: `<version or "main">-<commit12>-<inputs8>`. */
export function releaseIdOf({ version, commit, seriesDigest, composition, infraDigest }) {
  const v = version && /^[0-9A-Za-z.+-]+$/.test(version) ? version : 'main';
  return `${v}-${commit.slice(0, 12)}-${shortHash({ seriesDigest, composition, infraDigest })}`;
}

/** Components of a staged tree (before the build): every package, every system app, os/, the root inputs. */
export function sourceComponents(dir) {
  const out = [];
  const tree = (rel) => gitTreeOfDir(join(dir, rel));
  for (const [kind, base, marker] of [['package', 'packages', 'package.json'], ['app', 'apps', 'app.manifest.json']]) {
    if (!existsSync(join(dir, base))) continue;
    for (const n of readdirSync(join(dir, base)).sort()) {
      if (existsSync(join(dir, base, n, marker))) out.push({ name: n, kind, path: `${base}/${n}`, tree: tree(`${base}/${n}`) });
    }
  }
  if (existsSync(join(dir, 'os'))) out.push({ name: 'os', kind: 'os', path: 'os', tree: tree('os') });
  const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'Dockerfile', 'docker-compose.yml']
    .filter((f) => existsSync(join(dir, f)));
  const h = createHash('sha256');
  for (const f of rootFiles) h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  out.push({ name: '_root', kind: 'root', files: rootFiles, sha256: h.digest('hex') });
  return out;
}

const readVersionConst = (dir, rel, name) => {
  try { const m = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(readFileSync(join(dir, rel), 'utf8')); return m ? Number(m[1]) : null; } catch { return null; }
};

/**
 * Builds one release. Options:
 *   dataRoot, dataVolume       the data volume (local path + name); dataSubpath: dataRoot's place inside it
 *   fetchFrom                  URL or path the mirror fetches from now (refs/heads/main and the tags)
 *   channel, maturity, ref     what to build (owner answer c; S's selectRelease)
 *   trust                      the verifier side's trust (never the candidate's keys)
 *   expectCommit               refuse unless the selection resolves to it (install.sh verified it already)
 *   composition                desktop | server
 *   infra                      D94 build inputs (infraInputs)
 *   series                     Phase 7: the series to apply; refused in Phase 6 when non-empty
 *   firstInstall               write the first pointer (no current release yet)
 *   lock                       a lock handle the caller (U) already holds; else taken here
 *   jobId, docker, log, limits, timeouts
 * Resolves { ok, id, release, reused, job }; throws BuildError (job file records the step).
 */
export async function build(o) {
  const docker = o.docker ?? 'docker';
  const log = o.log ?? ((s) => process.stderr.write(`[builder] ${s}\n`));
  const jobId = o.jobId ?? newJobId();
  const composition = o.composition ?? 'desktop';
  if (!COMPOSITIONS.includes(composition)) refuse('usage', `unknown composition ${composition}`);
  const channel = o.channel ?? 'signed';
  if (!o.dataRoot || !o.dataVolume) refuse('usage', 'dataRoot and dataVolume are required');
  const prefix = o.dataSubpath ? `${o.dataSubpath.replace(/^\/+|\/+$/g, '')}/` : '';
  if (prefix.split('/').includes('..')) refuse('usage', 'dataSubpath must stay inside the volume');
  const L = layout(o.dataRoot);
  const infra = infraInputs(o.infra);
  const timeouts = { deps: 30 * 60_000, build: 45 * 60_000, check: 5 * 60_000, image: 60 * 60_000, ...(o.timeouts ?? {}) };
  mkdirSync(L.jobs, { recursive: true });
  const job = newJob(jobId, { ...o, channel, composition });
  const save = () => writeJsonDurable(L.job(jobId), job);
  const step = (key, status, detail) => {
    const s = job.steps.find((x) => x.key === key);
    Object.assign(s, { status, at: new Date().toISOString() }, detail !== undefined ? { detail: String(detail).slice(0, 400) } : {});
    if (detail !== undefined) job.log.push(`${key}: ${String(detail).slice(0, 400)}`);
    save();
  };
  let current = 'lock';
  const begin = (key) => { current = key; step(key, 'running'); log(`${key} …`); };
  const done = (key, detail) => { step(key, 'done', detail); if (detail) log(`${key}: ${detail}`); };
  save();

  let lock = o.lock ?? null;
  const ownLock = !lock;
  const staging = L.staging(jobId);
  const jobFiles = L.jobFiles(jobId);
  let finalized = false;
  try {
    // 1. lock
    begin('lock');
    if (ownLock) {
      try { lock = acquireLock(L.lock, { jobId, by: o.firstInstall ? 'system.release.install' : 'system.release.build' }); } catch (e) {
        if (e instanceof LockError) throw new BuildError(e.code, e.message, { exit: 3 });
        throw e;
      }
    } else if (!lock.owned()) refuse('activation-busy', 'the caller\'s activation lock is not held');
    done('lock', lock.brokeStale ? `took over a stale lock of ${lock.brokeStale.jobId ?? 'an unknown job'}` : `held by ${lock.jobId}`);

    // 2. source: the bare mirror under /data, never /workspace
    begin('source');
    if (!o.fetchFrom) refuse('usage', 'fetchFrom is required');
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
    if (infra.gitConfig) gitEnv.GIT_CONFIG_GLOBAL = infra.gitConfig;
    if (!existsSync(join(L.mirror, 'HEAD'))) {
      mkdirSync(L.mirror, { recursive: true });
      const r = await run('git', ['init', '-q', '--bare', L.mirror], { env: gitEnv });
      if (r.code) throw new BuildError('mirror', `git init of the mirror failed: ${r.out.trim()}`);
    }
    const f = await run('git', ['-C', L.mirror, 'fetch', '--prune', '--force', '--tags', '--no-recurse-submodules', '--', o.fetchFrom,
      '+refs/heads/main:refs/heads/main'], { env: gitEnv, timeoutMs: 15 * 60_000 });
    if (f.code) throw new BuildError('fetch', `fetching ${o.fetchFrom} failed: ${f.out.trim().split('\n').slice(-3).join(' / ')}`);
    done('source', `mirror ${L.mirror}`);

    // 3. verify (D71): before anything from the candidate runs or is even extracted
    begin('verify');
    let sel;
    try {
      sel = selectRelease(L.mirror, { channel, maturity: o.maturity ?? 'alpha', ref: o.ref ?? undefined, trust: channel === 'main' ? emptyTrust() : (o.trust ?? emptyTrust()) });
    } catch (e) {
      if (e instanceof ReleaseVerifyError) throw new BuildError(`verify-${e.code}`, `release verification refused (${e.code}): ${e.message}`, { exit: 3 });
      throw e;
    }
    if (o.expectCommit && sel.commit !== o.expectCommit) refuse('verify-moved', `the source moved: expected ${o.expectCommit}, the selection is ${sel.commit}`);
    job.input.commit = sel.commit;
    done('verify', channel === 'signed' ? `${sel.ref} ${sel.commit} signed by ${sel.keyId}` : `unsigned ${sel.ref} ${sel.commit}`);

    // 4. stage: git archive, then the staged files must BE the verified tree
    begin('stage');
    mkdirSync(L.releases, { recursive: true });
    removeTree(staging);
    mkdirSync(staging, { recursive: true });
    const ar = await archiveInto(L.mirror, sel.commit, staging, gitEnv);
    if (!ar.ok) throw new BuildError('stage', `extracting ${sel.commit} failed: ${ar.err.trim()}`);
    const stagedTree = gitTreeOfDir(staging);
    if (stagedTree !== sel.gitTree) refuse('tree-mismatch', `the staged tree ${stagedTree} is not the verified tree ${sel.gitTree}`);
    const pkg = readJson(join(staging, 'package.json')) ?? {};
    let sourceComps = sourceComponents(staging);
    done('stage', `staged tree = verified tree ${sel.gitTree}`);

    // 5. series slot (D68, Phase 7b): the WHOLE series applied to the full source tree (D73),
    // with the one patch library; a patch that does not apply is "needs repair" (nothing else runs).
    begin('series');
    const imageFps = (dir) => {
      const t = targetsOf(existsSync(join(dir, 'Dockerfile')) ? readFileSync(join(dir, 'Dockerfile'), 'utf8') : '');
      const shellT = t.includes(SHELL_TARGET) ? SHELL_TARGET : SHELL_TARGET_PRE_L;
      if (!t.includes(shellT) || !t.includes(BASE_TARGET)) return null;
      return { base: imageFingerprint(dir, BASE_TARGET, { extra: infra.digest ?? '' }).fingerprint, shell: imageFingerprint(dir, shellT, { extra: infra.digest ?? '' }).fingerprint };
    };
    let read = null;
    try { read = await seriesForBuild({ store: L.seriesStore, requested: o.series ?? null }); } catch (e) {
      if (e instanceof SeriesSlotError) throw new BuildError(e.code, e.message, { exit: 3 });
      throw e;
    }
    const enabled = read ? read.patches.filter((p) => p.enabled) : [];
    let series = { digest: EMPTY_SERIES_DIGEST, base: null, order: [] };
    let rebuildsImage = false;
    let upstreamImages = null;
    if (read) {
      const ident = await seriesIdentity(read, sel.commit);
      upstreamImages = imageFps(staging);
      if (enabled.length) {
        const r = await applyToStaging({ staging, mirror: L.mirror, commit: sel.commit, patches: read.patches });
        if (!r.ok) {
          const e = new BuildError('needs-repair', `patch ${r.failed.index + 1} "${r.failed.subject}" (${r.failed.file}) does not apply to ${sel.commit.slice(0, 12)}`
            + `${r.conflicts.length ? `: conflicts in ${r.conflicts.join(', ')}` : ''} (${r.message})`, { exit: 3 });
          e.repair = { release: sel.meta?.version ?? null, commit: sel.commit, rev: read.rev, patch: { file: r.failed.file, subject: r.failed.subject, sha256: r.failed.sha256 ?? null },
            index: r.failed.index, reason: 'conflict', conflicts: r.conflicts, message: r.message };
          job.repair = e.repair;
          throw e;
        }
      }
      if (enabled.length) sourceComps = sourceComponents(staging);   // release.json describes the patched source
      const patched = imageFps(staging);
      rebuildsImage = Boolean(upstreamImages && patched && (upstreamImages.base !== patched.base || upstreamImages.shell !== patched.shell));
      const touched = await touchedComponents(read.patches, sourceComps);
      series = {
        digest: ident.digest,
        base: { commit: sel.commit, version: channel === 'signed' ? sel.meta.version : null },
        order: enabled.map((p) => ({ file: p.file, sha256: p.sha256, subject: p.subject })),
        disabled: read.patches.filter((p) => !p.enabled).map((p) => ({ file: p.file, sha256: p.sha256, subject: p.subject })),
        target: { kind: 'system' },
        rev: read.rev,
        declaredBase: read.series.base,
        rebased: read.series.base.commit !== sel.commit,
        binding: ident.binding,
        flags: read.flags,
        touched,
        rebuildsImage,
        // Owner 2026-11-27: Dockerfile and image changes are named in the approval and the install prompt.
        imageFiles: await imageInputPaths(read.patches),
        touchesDependencies: touched.length > 0 && (await dependencyInputPaths(read.patches)).length > 0,
      };
    }
    job.series = series.order.length || series.disabled?.length ? { digest: series.digest, rev: series.rev ?? null, patches: series.order.length, rebuildsImage } : null;
    done('series', read ? `${series.order.length} patch(es) applied${series.disabled?.length ? `, ${series.disabled.length} disabled` : ''} (${series.digest})${rebuildsImage ? ', changes the images' : ''}` : `no series ${series.digest}`);

    const version = channel === 'signed' ? sel.meta.version : (pkg.version ?? null);
    const id = releaseIdOf({ version: channel === 'signed' ? version : null, commit: sel.commit, seriesDigest: series.digest, composition, infraDigest: infra.digest });
    job.input.releaseId = id;
    if (o.expectSeriesDigest && o.expectSeriesDigest !== series.digest) {
      refuse('series-moved', `the series is ${series.digest}, not the approved ${o.expectSeriesDigest}: approve the new revision`);
    }
    if (rebuildsImage && !o.validateOnly && !o.imageChangeApproved) {
      refuse('image-change-unapproved', 'the series changes what the AuraOS images are built from: the image is built only after the activation was approved');
    }
    if (!o.validateOnly && existsSync(join(L.release(id), COMPLETE_MARKER))) {
      // The same inputs were built before (a rollback target, a retried install): reuse it.
      if (o.expectInputs) {
        // Reusing a release is reusing its build: it must have been built from the approved inputs.
        const diff = inputsDiff(o.expectInputs, readJson(join(L.release(id), RELEASE_RECORD))?.inputs ?? {});
        if (diff.length) refuse('build-inputs-moved', `release ${id} exists but was built from other inputs: ${diff.join('; ')}`);
      }
      for (const k of ['images', 'base-check', 'deps', 'build', 'check', 'manifest', 'finalize']) step(k, 'skipped', `release ${id} exists`);
      removeTree(staging);
      finalized = true;
      if (o.firstInstall && !readPointer(o.dataRoot)) writeFirstPointer(o.dataRoot, { id, jobId });
      begin('gc');
      const g = await gc({ dataRoot: o.dataRoot, keep: [id], activeJob: jobId, docker, log });
      done('gc', g.removed.length ? `removed ${g.removed.join(', ')}` : 'nothing to remove');
      return finish({ ok: true, id, reused: true, release: readJson(join(L.release(id), RELEASE_RECORD)) });
    }

    // 6. images (privileged side, BuildKit; secrets only as secret mounts)
    begin('images');
    if (!existsSync(join(staging, 'Dockerfile'))) refuse('bad-dockerfile', 'the release has no Dockerfile: it cannot be built as a release');
    const dockerfile = readFileSync(join(staging, 'Dockerfile'), 'utf8');
    const targets = targetsOf(dockerfile);
    const shellTarget = targets.includes(SHELL_TARGET) ? SHELL_TARGET : SHELL_TARGET_PRE_L;
    if (!targets.includes(shellTarget) || !targets.includes(BASE_TARGET)) refuse('bad-dockerfile', `the release's Dockerfile lacks the ${shellTarget} or ${BASE_TARGET} target`);
    const hasBuildx = (await run(docker, ['buildx', 'version'])).code === 0;
    const secretIds = Object.keys(infra.secrets).sort();
    if (!hasBuildx && secretIds.length) refuse('legacy-builder', 'build secrets are configured (D94) but buildx (BuildKit) is missing: the legacy builder would put them at risk; install the buildx plugin');
    const images = {};
    for (const [key, target, repo] of [['base', BASE_TARGET, 'aura-base'], ['shell', shellTarget, 'aura-shell']]) {
      // Validating an unapproved series that changes the images: its code is built and checked
      // in the UPSTREAM images (an image build runs Dockerfile steps on the privileged side).
      const fingerprint = o.validateOnly && rebuildsImage ? upstreamImages[key] : imageFingerprint(staging, target, { extra: infra.digest ?? '' }).fingerprint;
      const tag = `${repo}:${fingerprint}`;
      images[key] = tag;
      if ((await run(docker, ['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0) { log(`images: reuse ${tag}`); continue; }
      if (o.validateOnly && rebuildsImage) refuse('upstream-image-missing', `the upstream image ${tag} is not there to validate an image-changing series in; build the release without the series first`);
      const args = hasBuildx ? ['buildx', 'build', '--load'] : ['build'];
      args.push('--target', target, '-t', tag, '-f', join(staging, 'Dockerfile'));
      for (const [k, v] of Object.entries(infra.buildArgs)) args.push('--build-arg', `${k}=${v}`);
      for (const sid of secretIds) args.push('--secret', `id=${sid},src=${infra.secrets[sid]}`);
      if (infra.publicContext && hasBuildx) args.push('--build-context', `aura-infra-public=${infra.publicContext}`);
      args.push(staging);
      log(`images: build ${tag} (target ${target})`);
      const r = await run(docker, args, { timeoutMs: timeouts.image, env: { ...process.env, DOCKER_BUILDKIT: '1' } });
      if (r.code) throw new BuildError('image-build', `building ${tag} failed: ${r.out.trim().split('\n').slice(-5).join(' / ')}`);
    }
    images.target = shellTarget;
    done('images', `${images.shell}, ${images.base}${shellTarget !== SHELL_TARGET ? ` (target ${shellTarget}: no release target yet, stream L)` : ''}`);

    // 7. base check (Astro 7 lesson)
    begin('base-check');
    const required = pkg.engines?.node ?? null;
    const node = { required };
    for (const key of ['base', 'shell']) {
      const r = await run(docker, ['run', '--rm', '--network', 'none', '--entrypoint', 'node', images[key], '-v']);
      const v = r.out.trim().split('\n').pop();
      if (r.code || !/^v\d+\.\d+\.\d+/.test(v)) throw new BuildError('base-check', `cannot read the Node version of ${images[key]}: ${r.out.trim()}`);
      node[key] = v;
      if (!satisfiesNode(v, required)) refuse('base-check', `${images[key]} has Node ${v}, but this release requires ${required} (engines.node): rebuild the image`);
    }
    done('base-check', `base ${node.base}, shell ${node.shell}, required ${required ?? 'any'}`);

    // Phase 7b: the RESOLVED build inputs. A validation records them; the approved build of the same
    // series must resolve to exactly the same (owner 2026-11-27: mutable dependencies or base images
    // never silently change an approved build).
    const inputs = await resolveInputs({ docker, staging, images, node, rebuildsImage, pinBases: rebuildsImage });
    if (o.validateOnly && rebuildsImage) {
      const loose = Object.entries(inputs.from).filter(([, d]) => !d).map(([r]) => r);
      if (loose.length) refuse('base-image-unpinned', `cannot pin the base image(s) ${loose.join(', ')} by digest: an image-changing series is validated only with pinned bases`);
    }
    if (o.expectInputs) {
      const diff = inputsDiff(o.expectInputs, inputs);
      if (diff.length) refuse('build-inputs-moved', `the build resolved other inputs than the approved ones: ${diff.join('; ')}`);
    }

    // 8.–10. throwaway container: deps, build, check
    mkdirSync(L.pnpmStore, { recursive: true });
    // dataSubpath: where dataRoot sits inside the volume ('' = its root; a scratch dir in e2e checks).
    const sub = (abs) => `${prefix}${subpathOf(o.dataRoot, abs)}`;
    let publicSub = null;
    const env = { ...infra.env, AURA_COMPOSITION: composition };
    if (infra.caBundle) {
      mkdirSync(join(jobFiles, 'public'), { recursive: true });
      copyFileSync(infra.caBundle, join(jobFiles, 'public', 'ca.pem'));
      chmodSync(join(jobFiles, 'public', 'ca.pem'), 0o444);
      publicSub = sub(join(jobFiles, 'public'));
      env.NODE_EXTRA_CA_CERTS = '/etc/aura/build-infra/ca.pem';
    }
    // An unapproved series (validate-only) never writes the pnpm store approved builds use.
    const store = o.validateOnly ? L.pnpmStoreUnapproved : L.pnpmStore;
    mkdirSync(store, { recursive: true });
    const base = { image: images.shell, dataVolume: o.dataVolume, stagingSub: sub(staging), storeSub: sub(store), publicSub, limits: o.limits };
    const shName = (s) => `aura-release-${s}-${jobId.toLowerCase()}`;

    begin('deps');
    const offline = await run(docker, [...buildContainerArgs({ ...base, name: shName('deps-offline'), network: 'none', env }), 'os/release/build.sh', 'deps', '--offline'],
      { timeoutMs: timeouts.deps, name: shName('deps-offline') });
    let depsDetail = 'from the store only (--network none)';
    if (offline.code) {
      // Registry access: the default bridge (never aura-net), credentials only as a 0400 file, removed after the run.
      let secretsSub = null;
      const depEnv = { ...env };
      // Unapproved code never runs while the network or a credential is there: the fetch skips every
      // lifecycle script (AURA_BUILD_IGNORE_SCRIPTS), then they run offline in their own container.
      if (o.validateOnly) depEnv.AURA_BUILD_IGNORE_SCRIPTS = '1';
      // ...and a series that changes what the install reads (package manifests, lockfile, workspace, npm or
      // pnpm config) gets no registry credential at all: its fetch runs anonymously or fails clearly.
      const noCreds = o.validateOnly && series.touchesDependencies === true;
      const npmrc = noCreds ? [] : [infra.secrets.infra_npmrc, infra.secrets.infra_proxy].filter(Boolean);
      if (npmrc.length) {
        const sd = join(jobFiles, 'secrets');
        mkdirSync(sd, { recursive: true, mode: 0o700 });
        let text = infra.secrets.infra_npmrc ? readFileSync(infra.secrets.infra_npmrc, 'utf8') : '';
        if (infra.secrets.infra_proxy) {
          const p = readFileSync(infra.secrets.infra_proxy, 'utf8').trim();
          text += `${text && !text.endsWith('\n') ? '\n' : ''}proxy=${p}\nhttps-proxy=${p}\n`;
        }
        writeFileDurable(join(sd, 'npmrc'), text, { mode: 0o400 });
        secretsSub = sub(sd);
        depEnv.NPM_CONFIG_USERCONFIG = '/run/aura-build/npmrc';
      }
      try {
        const online = await run(docker, [...buildContainerArgs({ ...base, secretsSub, name: shName('deps'), network: 'bridge', env: depEnv }), 'os/release/build.sh', 'deps'],
          { timeoutMs: timeouts.deps, name: shName('deps') });
        if (online.code) {
          throw new BuildError('deps', `pnpm install --frozen-lockfile failed${noCreds && infra.secrets.infra_npmrc ? ' (an unapproved series that changes dependency inputs is fetched WITHOUT registry credentials)' : ''}: ${online.out.trim().split('\n').slice(-6).join(' / ')}`);
        }
      } finally {
        removeTree(join(jobFiles, 'secrets'));
      }
      depsDetail = 'fetched through the registry (default bridge network)';
      if (o.validateOnly) {
        const sc = await run(docker, [...buildContainerArgs({ ...base, name: shName('scripts'), network: 'none', env }), 'os/release/build.sh', 'scripts'],
          { timeoutMs: timeouts.deps, name: shName('scripts') });
        if (sc.code) throw new BuildError('deps', `the install scripts failed (offline, no credentials): ${sc.out.trim().split('\n').slice(-6).join(' / ')}`);
        depsDetail += '; install scripts offline, without credentials (unapproved series)';
      }
    }
    done('deps', depsDetail);

    begin('build');
    const b = await run(docker, [...buildContainerArgs({ ...base, name: shName('build'), network: 'none', env }), 'os/release/build.sh', 'build'],
      { timeoutMs: timeouts.build, name: shName('build') });
    if (b.code) throw new BuildError('build', `the release build failed${touchedNote(series)}: ${b.out.trim().split('\n').slice(-8).join(' / ')}`);
    const appsLine = b.out.trim().split('\n').reverse().find((l) => l.startsWith('{"apps":'));
    const apps = appsLine ? JSON.parse(appsLine).apps : [];
    done('build', `${apps.filter((a) => a.built).length} system app build(s)`);

    begin('check');
    const c = await run(docker, [...buildContainerArgs({ ...base, name: shName('check'), network: 'none', env }), 'os/release/build.sh', 'check'],
      { timeoutMs: timeouts.check, name: shName('check') });
    if (c.code) throw new BuildError('check', `server.mjs --check failed${touchedNote(series)}: ${c.out.trim().split('\n').slice(-6).join(' / ')}`);
    done('check', 'build loaded, servers attached');

    // D73: each touched component is built and deployed in this composition, or named as not deployed.
    const builtNames = new Set(apps.filter((a) => a.built).map((a) => a.id).concat(sourceComps.filter((x) => x.kind === 'package').map((x) => x.name)));
    if (series.touched) {
      for (const t of series.touched) {
        t.built = t.kind === 'os' || t.kind === 'root' ? null : builtNames.has(t.component);
        t.deployed = t.kind === 'os' || t.kind === 'root' ? true : builtNames.has(t.component);
      }
    }
    if (o.validateOnly) {
      // Phase 7b: an unapproved series was applied, built and checked in throwaway containers.
      // Nothing is finalized; the approved activation builds again with the same inputs.
      removeTree(staging);
      job.validated = { id, commit: sel.commit, version, composition, provenance: provenanceOf({ channel, signed: channel === 'signed' && sel.signed === true, seriesLength: series.order.length }),
        series: { ...series, binding: { ...series.binding, composition } }, images, inputs };
      for (const k of ['manifest', 'finalize', 'gc']) step(k, 'skipped', 'validation only');
      finalized = true;
      return finish({ ok: true, id, reused: false, validated: job.validated });
    }

    // 11. manifest
    begin('manifest');
    const signed = channel === 'signed' && sel.signed === true;
    const provenance = provenanceOf({ channel, signed, seriesLength: series.order.length });
    if (series.binding) series.binding = { ...series.binding, composition };
    const builtComps = [
      ...sourceComps.filter((x) => x.kind === 'package').map((x) => ({ name: x.name, kind: 'package' })),
      { name: 'shell-bundle', kind: 'shell', composition, outDir: 'packages/shell/dist-prod' },
      ...apps.filter((a) => a.built).map((a) => ({ name: a.id, kind: 'app', via: a.via, ...(a.fingerprint ? { fingerprint: a.fingerprint } : {}), ...(a.outputs ? { outputs: a.outputs } : {}) })),
    ];
    const record = {
      v: RELEASE_RECORD_VERSION,
      id,
      version,
      commit: sel.commit,
      gitTree: sel.gitTree,
      channel,
      maturity: sel.maturity ?? null,
      meta: signed
        ? { signed: true, keyId: sel.keyId, metaDigest: sel.metaDigest, securityUpdate: sel.meta.securityUpdate === true, ...(sel.meta.severity ? { severity: sel.meta.severity } : {}) }
        // main channel: unsigned, so a securityUpdate claim is never honoured (D71)
        : { signed: false, metaDigest: null, securityUpdate: false },
      provenance,
      ...(provenance === 'locally-modified' ? {
        base: { commit: sel.commit, version },
        // D71: what this locally modified release is based on; it is never itself "signed".
        basedOn: { version, commit: sel.commit, metaDigest: signed ? sel.metaDigest : null, signed },
      } : {}),
      series,
      composition,
      components: {
        source: sourceComps,
        built: builtComps,
        // What this composition serves; `server` drops the desktop pages once stream W splits them.
        deployed: builtComps,
        skipped: apps.filter((a) => !a.built).map((a) => ({ name: a.id, reason: a.skipped ?? 'failed' })),
      },
      images,
      node,
      lockfileHash: inputs.lockfileHash,
      inputs,
      infraDigest: infra.digest,
      auraContract: readVersionConst(staging, 'packages/core/src/contract/appContract.ts', 'AURA_CONTRACT'),
      ari: readVersionConst(staging, 'packages/core/src/runtimes/ari.ts', 'ARI_VERSION'),
      builtAt: new Date().toISOString(),
      builderJob: jobId,
      // git-tree-shaped sha256 of the finalized tree without release.json and .complete (diagnose/release recomputes it).
      treeDigest: `sha256:${gitTreeOfDir(staging, { algo: 'sha256', skip: [RELEASE_RECORD, COMPLETE_MARKER] })}`,
    };
    writeJsonDurable(join(staging, RELEASE_RECORD), record);
    done('manifest', `${id} (${provenance})`);

    // 12. finalize: read-only, atomic rename, `.complete` last
    begin('finalize');
    if (!lock.owned()) throw new BuildError('lock-lost', 'the activation lock was taken over during the build');
    makeReadOnly(staging);
    if (existsSync(L.release(id))) removeTree(L.release(id));   // an incomplete leftover of the same id
    renameDurable(staging, L.release(id));
    writeFileDurable(join(L.release(id), COMPLETE_MARKER), `${jobId}\n`, { mode: 0o444 });
    chmodSync(L.release(id), 0o555);
    finalized = true;
    if (o.firstInstall && !readPointer(o.dataRoot)) writeFirstPointer(o.dataRoot, { id, jobId });
    done('finalize', `releases/${id}${o.firstInstall ? ' (first install: current)' : ''}`);

    // 13. gc (Q34): current + previous, and the new release until U activates it
    begin('gc');
    const g = await gc({ dataRoot: o.dataRoot, keep: [id], activeJob: jobId, docker, log });
    done('gc', g.removed.length ? `removed ${g.removed.join(', ')}` : 'nothing to remove');
    return finish({ ok: true, id, reused: false, release: record });
  } catch (e) {
    const err = e instanceof BuildError ? e : new BuildError('internal', e.message);
    err.step ??= current;
    step(current, 'failed', err.message);
    job.phase = 'failed';
    job.error = err.message;
    job.code = err.code;
    if (!finalized) removeTree(staging);
    finish(null);
    throw err;
  } finally {
    removeTree(jobFiles);
    if (ownLock && lock) lock.release();
  }

  function finish(result) {
    if (result) job.phase = 'done';
    job.finishedAt = new Date().toISOString();
    if (result) job.result = { id: result.id, reused: result.reused, ...(result.validated ? { validated: true } : {}) };
    if (result?.validated) job.phase = 'validated';
    step('complete', 'done');
    return result ? { ...result, job: jobId } : null;
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export function status(dataRoot) {
  const L = layout(dataRoot);
  return {
    pointer: readPointer(dataRoot),
    releases: listReleases(dataRoot).map((r) => ({
      id: r.id, complete: r.complete, version: r.record?.version ?? null, commit: r.record?.commit ?? null,
      provenance: r.record?.provenance ?? null, composition: r.record?.composition ?? null,
    })),
    staging: existsSync(L.releases) ? readdirSync(L.releases).filter((n) => n.startsWith(STAGING_PREFIX)) : [],
    lock: lockStatus(L.lock),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** --series-dir DIR | --series-store DIR --series-rev REV | --no-series; none of them: the store's active series. */
function seriesArg(a) {
  if (a['no-series'] === true) return { none: true };
  if (typeof a['series-dir'] === 'string') return { dir: a['series-dir'] };
  // --series-rev alone: a revision of this data root's store.
  const store = typeof a['series-store'] === 'string' ? a['series-store'] : (a['data-root'] ? layout(a['data-root']).seriesStore : null);
  if (store && typeof a['series-rev'] === 'string') return { store, rev: a['series-rev'] };
  return null;
}

const jsonOut = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const [cmd] = a._;
  const usage = () => { process.stderr.write('usage: builder.mjs build|status|gc … (see the file header)\n'); return 64; };
  try {
    switch (cmd) {
      case 'build': {
        if (!a['data-root'] || !a['data-volume'] || !a['fetch-from']) return usage();
        const r = await build({
          dataRoot: a['data-root'], dataVolume: a['data-volume'], fetchFrom: a['fetch-from'],
          dataSubpath: typeof a['data-subpath'] === 'string' ? a['data-subpath'] : undefined,
          channel: a.channel ?? 'signed', maturity: a.maturity ?? 'alpha', ref: typeof a.ref === 'string' ? a.ref : undefined,
          expectCommit: typeof a['expect-commit'] === 'string' ? a['expect-commit'] : undefined,
          trust: (a.channel ?? 'signed') === 'main' ? emptyTrust() : trustFrom(a),
          composition: a.composition ?? 'desktop',
          infra: typeof a.infra === 'string' ? JSON.parse(readFileSync(a.infra, 'utf8')) : null,
          firstInstall: a['first-install'] === true,
          jobId: typeof a.job === 'string' ? a.job : undefined,
          series: seriesArg(a),
          validateOnly: a['validate-only'] === true,
          imageChangeApproved: a['image-change-approved'] === true,
          expectSeriesDigest: typeof a['expect-series-digest'] === 'string' ? a['expect-series-digest'] : undefined,
          expectInputs: typeof a['expect-inputs'] === 'string' ? JSON.parse(readFileSync(a['expect-inputs'], 'utf8')) : undefined,
        });
        // Install-time patches: the operator-authorized store revision becomes approved and active.
        const sa = seriesArg(a);
        if (a['mark-installed'] === true && sa?.store) markInstalled({ store: sa.store, rev: sa.rev });
        jsonOut({
          ok: true, id: r.id, reused: r.reused, job: r.job, provenance: r.release?.provenance ?? r.validated?.provenance, images: r.release?.images,
          ...(r.validated ? { validated: true, series: r.validated.series } : { series: r.release?.series }),
        });
        return 0;
      }
      case 'series-plan': {
        // What an operator authorizes before an install-time series is built (Phase 7b I):
        // read and validated without git or any build; the digest is the one the build will have on --commit.
        if (!a['series-dir']) return usage();
        const read = await readSeriesInput({ dir: a['series-dir'] });
        const commit = typeof a.commit === 'string' ? a.commit : read.series.base.commit;
        const { digest } = await seriesIdentity(read, commit);
        const imageFiles = await imageInputPaths(read.patches);
        jsonOut({
          ok: true, digest, base: read.series.base, buildsOn: commit, rebased: commit !== read.series.base.commit,
          imageFiles, changesImages: imageFiles.length > 0,
          patches: read.patches.map((p) => ({
            file: p.file, subject: p.subject, sha256: p.sha256, enabled: p.enabled,
            files: p.validation.files.map((x) => ({ path: x.path, status: x.status, added: x.addedBytes })),
            flags: p.validation.flags.map((x) => x.message),
          })),
        });
        return 0;
      }
      case 'series-import': {
        // Install-time patches (Phase 7b I): the authorized series becomes the store, with its history,
        // and a handoff for the kernel's audit at first boot (patch.saved + patch.install-authorized).
        if (!a['data-root'] || !a['series-dir'] || typeof a.digest !== 'string') return usage();
        const L = layout(a['data-root']);
        const rev = importStore({ store: L.seriesStore, dir: a['series-dir'], source: String(a.source ?? a['series-dir']), by: String(a.by ?? 'the operator') });
        const handoff = join(a['data-root'], 'aura/install/patches-authorization.json');
        mkdirSync(dirname(handoff), { recursive: true });
        writeJsonDurable(handoff, { v: 1, source: String(a.source ?? ''), ref: typeof a.ref === 'string' ? a.ref : null, digest: a.digest, rev, by: String(a.by ?? 'the operator'), at: new Date().toISOString() });
        jsonOut({ ok: true, store: L.seriesStore, rev });
        return 0;
      }
      case 'status': {
        if (!a['data-root']) return usage();
        jsonOut({ ok: true, ...status(a['data-root']) });
        return 0;
      }
      case 'gc': {
        if (!a['data-root']) return usage();
        const L = layout(a['data-root']);
        const lock = acquireLock(L.lock, { jobId: newJobId(), by: 'system.release.gc' });
        try { jsonOut({ ok: true, ...(await gc({ dataRoot: a['data-root'], activeJob: lock.jobId })) }); } finally { lock.release(); }
        return 0;
      }
      default: return usage();
    }
  } catch (e) {
    if (e instanceof BuildError || e instanceof LockError || e instanceof SeriesSlotError) {
      jsonOut({ ok: false, code: e.code, step: e.step ?? null, error: e.message, ...(e.repair ? { repair: e.repair } : {}), ...(e.refused ? { refused: e.refused } : {}) });
      return e.exit ?? 3;
    }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
