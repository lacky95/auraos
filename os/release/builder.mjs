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
//   series     the D68 series slot: the empty series in Phase 6 (series-slot.mjs)
//   images     aura-shell:<fp> and aura-base:<fp> through BuildKit; reused when the fingerprint exists
//   base-check node -v of both images against engines.node of the staged package.json
//   deps       pnpm install --frozen-lockfile in a throwaway container (offline first, then the network)
//   build      packages, shell bundle, system apps (os/release/build.sh, --network none)
//   check      server.mjs --check in a throwaway container (--network none)
//   manifest   release.json v1 (components, composition, provenance, digests)
//   finalize   read-only, atomic rename to releases/<id>, `.complete` last
//   gc         keep current + previous (+ the new release); other releases, staging, images, their snapshots
//              go; the pnpm store is pruned monthly (gc.mjs)
// A failure at any step leaves the current release, the pointer and every
// other release untouched; the staging tree is removed.
//
// CLI (JSON result on stdout; progress on stderr; exit 0 ok, 1 failed, 3 refused, 64 usage):
//   builder.mjs build --data-root D --data-volume V [--data-subpath P] --fetch-from URL|PATH
//                     [--channel signed|main] [--maturity M] [--ref REF] [--expect-commit SHA]
//                     [--keys DIR]... [--key FILE]... [--pin ID]... [--composition desktop|server]
//                     [--infra FILE] [--first-install] [--job ID]
//   builder.mjs status --data-root D
//   builder.mjs gc --data-root D [--data-volume V [--data-subpath P]] [--prune-store auto|now|never] [--held-by JOB]
//     --held-by: the caller (stream U's switch job) holds the activation lock as JOB; gc runs under it
//     and leaves it held. Without it, gc takes the lock itself.
//   builder.mjs check [--only=PKGS] [--worktree DIR] [--cpus N --memory 6g --pids N] [--network none|bridge]
//                     [--timeout SEC] [--env K=V]... [--lock FILE | --no-lock] [--no-git] [-- CMD...]
//     D106 item 1: a package suite, typecheck, lint or build of a worktree in the same throwaway
//     container, limits enforced (check.mjs); the command's exit code and output.
//
// Every throwaway container (build steps and check) comes from container.mjs with a
// resources.limits profile (limits.mjs = core runtimes/container/limits.ts): RELEASE_BUILD_LIMITS
// for a release build, DEFAULT_CHECK_LIMITS for a check.
//
// D94 (IC-5 call site): the build's infrastructure inputs are either given (`--infra FILE`: install.sh
// renders them on the host before any data volume config exists) or come from the propagation API
// (os/infra/propagate.mjs = core infra/propagate.ts): `propagatedInfra()` below, before the first
// network access. No config = today's behaviour; a config before IC-5 is refused, never ignored.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReleaseVerifyError, gitTreeOfDir, parseArgs, provenanceOf, selectRelease, emptyTrust, trustFrom,
} from '../release-verify.mjs';
import { renameDurable, writeFileDurable, writeJsonDurable } from './durable.mjs';
import { ACTIVATION_BUSY, LockError, acquireLock, lockStatus } from './lock.mjs';
import { checkMain } from './check.mjs';
import { throwawayArgs, volumeSubpath } from './container.mjs';
import { PRUNE_MODES, gc, listReleases, readPointer } from './gc.mjs';
import { imageFingerprint, satisfiesNode, targetsOf } from './images.mjs';
import { RELEASE_BUILD_LIMITS } from './limits.mjs';
import {
  COMPLETE_MARKER, RELEASE_RECORD, STAGING_PREFIX, assertReleaseId, layout, newJobId,
} from './layout.mjs';
import { readJson, removeTree, run } from './proc.mjs';
import { seriesForBuild } from './series-slot.mjs';
import * as infraPropagation from '../infra/propagate.mjs';

export { gc, listReleases, readPointer, removeTree, run };

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
  { key: 'series', label: 'System patch series recorded (empty in Phase 6)' },
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

/**
 * The IC-5 call site: the build's D94 inputs from the propagation API (os/infra/propagate.mjs, the
 * twin of core infra/propagate.ts) when no `--infra` inputs are given (the updater's builds, from
 * the running release). Secret files land in the job's own dir (`jobDir`, removed after the run);
 * the caller calls `dispose()` in a `finally`. No rendered config: empty inputs (today). A rendered
 * config before IC-5: `infra-not-propagated`, refused before anything reaches the network.
 * IC-5 fills the remaining fields (build args, the public context, the CA bundle, the git config)
 * here, in this one function.
 */
export async function propagatedInfra({ dataRoot, jobDir }) {
  const digest = infraPropagation.renderDigest(dataRoot);
  const env = infraPropagation.infraExecEnv('release-build', { dataDir: dataRoot });
  const s = await infraPropagation.buildSecrets({ jobDir, dataDir: dataRoot });
  return { inputs: infraInputs({ digest, env: { ...env }, secrets: { ...s.secrets } }), dispose: s.dispose };
}

/** The throwaway build's container (container.mjs): staging + store only, no socket, no home, the release limits profile. */
export function buildContainerArgs({ name, image, dataVolume, stagingSub, storeSub, publicSub, secretsSub, env = {}, network, limits }) {
  const vol = (target, subpath, readonly = false) => ({ type: 'volume', source: dataVolume, target, subpath, readonly });
  const mounts = [vol('/workspace', stagingSub), vol('/pnpm-store', storeSub)];
  if (publicSub) mounts.push(vol('/etc/aura/build-infra', publicSub, true));
  if (secretsSub) mounts.push(vol('/run/aura-build', secretsSub, true));
  return throwawayArgs({
    name, image, network, limits: limits ?? RELEASE_BUILD_LIMITS, workdir: '/workspace', mounts,
    env: { HOME: '/tmp', npm_config_store_dir: '/pnpm-store', ...env }, entrypoint: 'sh',
  });
}

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
 *   limits                     resources.limits of the throwaway containers ({cpus, memoryBytes, pids}; RELEASE_BUILD_LIMITS)
 *   jobId, docker, log, timeouts
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
  if (o.dataSubpath && o.dataSubpath.split('/').includes('..')) refuse('usage', 'dataSubpath must stay inside the volume');
  const L = layout(o.dataRoot);
  // Given inputs (install.sh) or, in the source step, the propagation API (propagatedInfra).
  let infra = o.infra ? infraInputs(o.infra) : null;
  let disposeInfra = null;
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
    if (!infra) {
      try {
        ({ inputs: infra, dispose: disposeInfra } = await propagatedInfra({ dataRoot: o.dataRoot, jobDir: jobFiles }));
      } catch (e) {
        if (e?.code === 'infra-not-propagated') throw new BuildError(e.code, e.message, { exit: 3 });
        throw e;
      }
    }
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
    const sourceComps = sourceComponents(staging);
    done('stage', `staged tree = verified tree ${sel.gitTree}`);

    // 5. series slot (D68)
    begin('series');
    let series;
    try { series = seriesForBuild({ seriesFile: L.series, requested: o.series ?? null }); } catch (e) {
      throw new BuildError(e.code ?? 'series', e.message, { exit: 3 });
    }
    done('series', `empty series ${series.digest}`);

    const version = channel === 'signed' ? sel.meta.version : (pkg.version ?? null);
    const id = releaseIdOf({ version: channel === 'signed' ? version : null, commit: sel.commit, seriesDigest: series.digest, composition, infraDigest: infra.digest });
    job.input.releaseId = id;
    if (existsSync(join(L.release(id), COMPLETE_MARKER))) {
      // The same inputs were built before (a rollback target, a retried install): reuse it.
      for (const k of ['images', 'base-check', 'deps', 'build', 'check', 'manifest', 'finalize']) step(k, 'skipped', `release ${id} exists`);
      removeTree(staging);
      finalized = true;
      if (o.firstInstall && !readPointer(o.dataRoot)) writeFirstPointer(o.dataRoot, { id, jobId });
      begin('gc');
      const g = await gc({ dataRoot: o.dataRoot, keep: [id], activeJob: jobId, docker, log, dataVolume: o.dataVolume, dataSubpath: o.dataSubpath, pruneStore: o.pruneStore ?? 'auto', limits: o.limits });
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
      const { fingerprint } = imageFingerprint(staging, target, { extra: infra.digest ?? '' });
      const tag = `${repo}:${fingerprint}`;
      images[key] = tag;
      if ((await run(docker, ['image', 'inspect', '--format', '{{.Id}}', tag])).code === 0) { log(`images: reuse ${tag}`); continue; }
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

    // 8.–10. throwaway container: deps, build, check
    mkdirSync(L.pnpmStore, { recursive: true });
    // dataSubpath: where dataRoot sits inside the volume ('' = its root; a scratch dir in e2e checks).
    const sub = (abs) => volumeSubpath(o.dataRoot, o.dataSubpath, abs);
    let publicSub = null;
    const env = { ...infra.env, AURA_COMPOSITION: composition };
    if (infra.caBundle) {
      mkdirSync(join(jobFiles, 'public'), { recursive: true });
      copyFileSync(infra.caBundle, join(jobFiles, 'public', 'ca.pem'));
      chmodSync(join(jobFiles, 'public', 'ca.pem'), 0o444);
      publicSub = sub(join(jobFiles, 'public'));
      env.NODE_EXTRA_CA_CERTS = '/etc/aura/build-infra/ca.pem';
    }
    const base = { image: images.shell, dataVolume: o.dataVolume, stagingSub: sub(staging), storeSub: sub(L.pnpmStore), publicSub, limits: o.limits };
    const shName = (s) => `aura-release-${s}-${jobId.toLowerCase()}`;

    begin('deps');
    const offline = await run(docker, [...buildContainerArgs({ ...base, name: shName('deps-offline'), network: 'none', env }), 'os/release/build.sh', 'deps', '--offline'],
      { timeoutMs: timeouts.deps, name: shName('deps-offline') });
    let depsDetail = 'from the store only (--network none)';
    if (offline.code) {
      // Registry access: the default bridge (never aura-net), credentials only as a 0400 file, removed after the run.
      let secretsSub = null;
      const depEnv = { ...env };
      const npmrc = [infra.secrets.infra_npmrc, infra.secrets.infra_proxy].filter(Boolean);
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
        if (online.code) throw new BuildError('deps', `pnpm install --frozen-lockfile failed: ${online.out.trim().split('\n').slice(-6).join(' / ')}`);
      } finally {
        removeTree(join(jobFiles, 'secrets'));
      }
      depsDetail = 'fetched through the registry (default bridge network)';
    }
    done('deps', depsDetail);

    begin('build');
    const b = await run(docker, [...buildContainerArgs({ ...base, name: shName('build'), network: 'none', env }), 'os/release/build.sh', 'build'],
      { timeoutMs: timeouts.build, name: shName('build') });
    if (b.code) throw new BuildError('build', `the release build failed: ${b.out.trim().split('\n').slice(-8).join(' / ')}`);
    const appsLine = b.out.trim().split('\n').reverse().find((l) => l.startsWith('{"apps":'));
    const apps = appsLine ? JSON.parse(appsLine).apps : [];
    done('build', `${apps.filter((a) => a.built).length} system app build(s)`);

    begin('check');
    const c = await run(docker, [...buildContainerArgs({ ...base, name: shName('check'), network: 'none', env }), 'os/release/build.sh', 'check'],
      { timeoutMs: timeouts.check, name: shName('check') });
    if (c.code) throw new BuildError('check', `server.mjs --check failed: ${c.out.trim().split('\n').slice(-6).join(' / ')}`);
    done('check', 'build loaded, servers attached');

    // 11. manifest
    begin('manifest');
    const signed = channel === 'signed' && sel.signed === true;
    const provenance = provenanceOf({ channel, signed, seriesLength: series.order.length });
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
      ...(provenance === 'locally-modified' ? { base: { commit: sel.commit, version } } : {}),
      series: { digest: series.digest, base: series.base, order: series.order },
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
      lockfileHash: existsSync(join(staging, 'pnpm-lock.yaml')) ? sha256File(join(staging, 'pnpm-lock.yaml')) : null,
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
    const g = await gc({ dataRoot: o.dataRoot, keep: [id], activeJob: jobId, docker, log, dataVolume: o.dataVolume, dataSubpath: o.dataSubpath, pruneStore: o.pruneStore ?? 'auto', limits: o.limits });
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
    if (disposeInfra) { try { await disposeInfra(); } catch { /* the job dir goes next */ } }
    removeTree(jobFiles);
    if (ownLock && lock) lock.release();
  }

  function finish(result) {
    if (result) job.phase = 'done';
    job.finishedAt = new Date().toISOString();
    if (result) job.result = { id: result.id, reused: result.reused };
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

const jsonOut = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'check') return checkMain(argv.slice(1));
  const a = parseArgs(argv);
  const [cmd] = a._;
  const usage = () => { process.stderr.write('usage: builder.mjs build|status|gc|check … (see the file header)\n'); return 64; };
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
        });
        jsonOut({ ok: true, id: r.id, reused: r.reused, job: r.job, provenance: r.release?.provenance, images: r.release?.images });
        return 0;
      }
      case 'status': {
        if (!a['data-root']) return usage();
        jsonOut({ ok: true, ...status(a['data-root']) });
        return 0;
      }
      case 'gc': {
        if (!a['data-root']) return usage();
        const prune = typeof a['prune-store'] === 'string' ? a['prune-store'] : 'auto';
        if (!PRUNE_MODES.includes(prune)) return usage();
        const opts = {
          dataRoot: a['data-root'], dataVolume: typeof a['data-volume'] === 'string' ? a['data-volume'] : null,
          dataSubpath: typeof a['data-subpath'] === 'string' ? a['data-subpath'] : undefined, pruneStore: prune,
        };
        const L = layout(a['data-root']);
        if (typeof a['held-by'] === 'string') {
          // Stream U's switch job holds the lock and runs gc under it; the lock stays the caller's.
          const holder = lockStatus(L.lock).holder;
          if (holder?.jobId !== a['held-by']) {
            throw new BuildError(ACTIVATION_BUSY, `${ACTIVATION_BUSY}: gc --held-by ${a['held-by']}, but the activation lock is ${holder ? `held by ${holder.jobId}` : 'not held'}`, { exit: 3 });
          }
          jsonOut({ ok: true, ...(await gc({ ...opts, activeJob: holder.jobId })) });
          return 0;
        }
        const lock = acquireLock(L.lock, { jobId: newJobId(), by: 'system.release.gc' });
        try { jsonOut({ ok: true, ...(await gc({ ...opts, activeJob: lock.jobId })) }); } finally { lock.release(); }
        return 0;
      }
      default: return usage();
    }
  } catch (e) {
    if (e instanceof BuildError || e instanceof LockError) {
      jsonOut({ ok: false, code: e.code, step: e.step ?? null, error: e.message });
      return e.exit ?? 3;
    }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
