// The release builder's check mode (D106 item 1; Phase 6 stream B, D68): runs a
// package suite, typecheck, lint or build of a git worktree in the builder's
// throwaway container (container.mjs) with an enforced resources.limits profile
// (limits.mjs, default 4 CPUs / 6 GiB without swap / 2048 pids), so agents'
// test runs can no longer starve the live shell: the kernel caps the
// container's cgroup, memory pressure stays inside it, and the OOM killer
// picks from it.
//
//   node os/release/builder.mjs check [--only=<pkg,...>] [options] [-- <command...>]
//
// Command: after `--`; default `node tools/run-tests.mjs [--only=<pkgs>]`. Exit
// code and output are the command's (124 on --timeout; 3 refused, 64 usage).
// The container is `docker create`d, inspected, then `docker start -a`ed.
// Options:
//   --worktree DIR    the checkout to check (default: the current directory); mounted rw at its own path
//   --image IMG       default `self`: the image of the container this runs in (in aura-shell: the shell image,
//                     the toolchain the suites are written for: node, pnpm with its corepack cache, valkey-server);
//                     outside a container aura-base (node only: no pnpm, no valkey-server)
//   --cpus N --memory BYTES|6g --pids N     the limits profile (DEFAULT_CHECK_LIMITS)
//   --network none|bridge                   default none; bridge only for `pnpm install` through the registry
//   --timeout SEC     default 2400; the container is killed after it
//   --env KEY=VALUE   repeatable, e.g. NODE_OPTIONS=--max-old-space-size=3072
//   --lock FILE       the host-wide slot (default /data/dev/.cpu.lock when its directory exists): one
//                     capped check at a time, since the sum of capped containers can still exceed the host
//   --no-lock         run without the slot
//   --no-git          do not mount the worktree's git directory (read-only; dep-check lists files through git)
//   --user UID:GID    the container's user (default: the worktree's owner)
//   --target T        where the check runs (env AURA_CHECK_TARGET), default `live`: the Docker daemon this runs
//                     against. The build/test VM (D106 §3 item 5) becomes the default once it is registered as a
//                     build target in auraos-e2e config/targets.yaml (it is driven from there: `aura-e2e check
//                     --target <build>` copies a bundle of the ref and runs this file on that host with
//                     `--target local`, the build host's own daemon). Any other target is refused (3)
//
// Every check container is labelled (CHECK_LABELS: aura.role=check, the worktree, its branch, the start time
// and the timeout), so diagnose/containers (auraos-e2e) tells a capped check from an orphan and flags one that
// runs past its timeout. The container is created, inspected and only then started: a container whose
// HostConfig lacks a limit of the profile, --rm or the role label is removed unstarted (refused, 3).
//
// The container: `--rm`, --network none, no-new-privileges, every capability dropped but CHECK_CAPS (the
// file-ownership and identity capabilities the suites' root tests use: chown into app and user uids, keep
// setgid bits, read and remove what they own, spawn as them, kill their processes; no NET_*, MKNOD, SYS_*,
// SETPCAP or SETFCAP), Docker's init as PID 1 (orphaned test processes are reaped, as in the shell),
// the worktree owner's uid:gid, HOME=/tmp, no Docker socket, no home, no
// secrets, nothing of /data but the worktree. Run it where the worktree lives
// (in aura-shell for /data/dev/...): the worktree's path is mapped to what the
// Docker daemon sees through this container's own mounts (a volume subpath or
// a bind source). AURA_TESTS_LIVE_SHELL=1 makes tools/run-tests.mjs's D106
// guard require the cgroup cap (memory.max) inside, so a check that lost its
// cap refuses instead of running uncapped.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from '../release-verify.mjs';
import { throwawayArgs } from './container.mjs';
import { DEFAULT_CHECK_LIMITS, parseBytes, validateLimits } from './limits.mjs';

export const CHECK_IMAGE = 'self';
export const CHECK_FALLBACK_IMAGE = 'aura-base';
/** Capabilities a check keeps after --cap-drop ALL (a subset of Docker's default set). */
export const CHECK_CAPS = Object.freeze(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETUID', 'SETGID', 'KILL']);
export const CHECK_LOCK = '/data/dev/.cpu.lock';
export const CHECK_TIMEOUT_S = 2400;
export const CHECK_NETWORKS = Object.freeze(['none', 'bridge']);
/** Registered check targets; the first is the default. The build/test VM goes first once it is registered. */
export const CHECK_TARGETS = Object.freeze(['live', 'local']);
/** The labels of every check container (diagnose/containers reads them). */
export const CHECK_LABELS = Object.freeze({
  role: 'aura.role', worktree: 'aura.check.worktree', branch: 'aura.check.branch', started: 'aura.check.started', timeout: 'aura.check.timeout',
});

export class CheckError extends Error {
  constructor(code, message, exit = 3) { super(message); this.code = code; this.exit = exit; }
}

/** Splits `check` argv into its options and the command (after the first `--`; default run-tests). */
export function parseCheckArgs(argv) {
  // A `--` followed by an option is pnpm's (`pnpm check -- --only=core` passes it on): skip it. A command never starts with `-`.
  const i = argv.findIndex((x, k) => x === '--' && !(argv[k + 1] ?? '').startsWith('-'));
  const a = parseArgs((i < 0 ? argv : argv.slice(0, i)).filter((x) => x !== '--'), ['env']);
  const cmd = i < 0 ? [] : argv.slice(i + 1);
  const str = (k) => (typeof a[k] === 'string' ? a[k] : undefined);
  const num = (k, d) => (a[k] === undefined ? d : Number(a[k]));
  if (a._.length) throw new CheckError('usage', `unexpected argument ${a._[0]} (the command goes after --)`, 64);
  const limits = {
    cpus: num('cpus', DEFAULT_CHECK_LIMITS.cpus),
    memoryBytes: a.memory === undefined ? DEFAULT_CHECK_LIMITS.memoryBytes : parseBytes(a.memory),
    pids: num('pids', DEFAULT_CHECK_LIMITS.pids),
  };
  try { validateLimits(limits); } catch (e) { throw new CheckError(e.code, e.message, 64); }
  const network = str('network') ?? 'none';
  if (!CHECK_NETWORKS.includes(network)) throw new CheckError('usage', `--network must be one of ${CHECK_NETWORKS.join(', ')}`, 64);
  const timeoutS = num('timeout', CHECK_TIMEOUT_S);
  if (!Number.isInteger(timeoutS) || timeoutS <= 0) throw new CheckError('usage', '--timeout must be a positive integer (seconds)', 64);
  const env = {};
  for (const kv of a.env) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(String(kv));
    if (!m) throw new CheckError('usage', `--env needs KEY=VALUE, got ${kv}`, 64);
    env[m[1]] = m[2];
  }
  const only = str('only');
  const target = str('target') ?? process.env.AURA_CHECK_TARGET ?? CHECK_TARGETS[0];
  if (!CHECK_TARGETS.includes(target)) {
    throw new CheckError('no-target', `check target ${target} is not registered (known: ${CHECK_TARGETS.join(', ')}): the build/test VM becomes a target once it is in auraos-e2e config/targets.yaml (D106)`);
  }
  const user = str('user');
  if (user !== undefined && !/^\d+:\d+$/.test(user)) throw new CheckError('usage', `--user needs UID:GID, got ${user}`, 64);
  return {
    target, user,
    worktree: str('worktree') ?? process.cwd(),
    image: str('image') ?? CHECK_IMAGE,
    limits, network, timeoutS, env,
    lock: a['no-lock'] !== undefined ? null : (str('lock') ?? (existsSync(dirname(CHECK_LOCK)) ? CHECK_LOCK : null)),
    git: a['no-git'] === undefined,
    cmd: cmd.length ? cmd : ['node', 'tools/run-tests.mjs', ...(only ? [`--only=${only}`] : [])],
  };
}

/**
 * What the Docker daemon mounts for `path`, from the mounts of the container this runs in ([{Type, Name,
 * Source, Destination}] of `docker inspect`; null = not in a container: the path is the daemon's own).
 * The longest destination that contains the path wins.
 */
export function daemonSourceOf(path, mounts) {
  if (!mounts) return { type: 'bind', source: path };
  const hit = mounts
    .filter((m) => path === m.Destination || path.startsWith(`${m.Destination.replace(/\/$/, '')}/`))
    .sort((x, y) => y.Destination.length - x.Destination.length)[0];
  if (!hit) throw new CheckError('not-mounted', `${path} is not on a mount of this container: the Docker daemon cannot see it (use a worktree under /data/dev)`);
  const rel = relative(hit.Destination, path);
  if (hit.Type === 'volume') return { type: 'volume', source: hit.Name, ...(rel ? { subpath: rel } : {}) };
  if (hit.Type === 'bind') return { type: 'bind', source: rel ? join(hit.Source, rel) : hit.Source };
  throw new CheckError('not-mounted', `${path} is on a ${hit.Type} mount the daemon cannot share`);
}

/** The git directory a worktree needs beyond itself (a linked worktree's common dir), or null. */
export function gitCommonDir(worktree, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  let text;
  try { text = read(join(worktree, '.git')); } catch { return null; }   // a directory (inside the worktree) or none
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const gitdir = resolve(worktree, m[1].trim());
  let common = gitdir;
  try { common = resolve(gitdir, read(join(gitdir, 'commondir')).trim()); } catch { /* not a linked worktree */ }
  return isAbsolute(common) && relative(worktree, common).startsWith('..') ? common : null;
}

/** The worktree's branch (`detached@<sha12>` on a detached HEAD), read from its git files; null when unknown. */
export function branchOf(worktree, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  let head;
  try {
    const dotgit = read(join(worktree, '.git'));
    const m = /^gitdir:\s*(.+)$/m.exec(dotgit);
    head = read(join(m ? resolve(worktree, m[1].trim()) : join(worktree, '.git'), 'HEAD'));
  } catch {
    try { head = read(join(worktree, '.git', 'HEAD')); } catch { return null; }
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  if (ref) return ref[1].trim();
  const sha = /^([0-9a-f]{12})/.exec(head.trim());
  return sha ? `detached@${sha[1]}` : null;
}

/** The labels of one check container. */
export function checkLabels(o, { started }) {
  return {
    [CHECK_LABELS.role]: 'check', [CHECK_LABELS.worktree]: o.worktree, [CHECK_LABELS.branch]: o.branch ?? 'unknown',
    [CHECK_LABELS.started]: started, [CHECK_LABELS.timeout]: String(o.timeoutS),
  };
}

/** The `docker create` argv of one check (no I/O: mounts, owner and start time are passed in). */
export function checkRunArgs(o, { name, mounts, owner, started }) {
  const at = (path, readonly) => ({ ...daemonSourceOf(path, mounts), target: path, readonly });
  const m = [at(o.worktree, false)];
  if (o.gitDir) m.push(at(o.gitDir, true));
  return [
    ...throwawayArgs({
      verb: 'create', name, image: o.image, network: o.network, limits: o.limits, workdir: o.worktree, mounts: m, user: owner, capAdd: CHECK_CAPS, init: true,
      labels: checkLabels(o, { started }), env: { HOME: '/tmp', AURA_TESTS_LIVE_SHELL: '1', ...o.env }, entrypoint: 'timeout',
    }),
    '-k', '30', String(o.timeoutS), ...o.cmd,
  ];
}

/**
 * What is wrong with a created check container against its profile (`docker inspect` HostConfig and
 * Config.Labels): [] when it is capped as asked (cpus, memory, memory-swap = memory, pids), auto-removed,
 * unprivileged, on the asked network and labelled aura.role=check.
 */
export function capProblems({ hostConfig: h, labels }, o) {
  const p = [];
  const want = (what, got, exp) => { if (got !== exp) p.push(`${what} is ${got ?? 'unset'}, expected ${exp}`); };
  want('NanoCpus', h?.NanoCpus, Math.round(o.limits.cpus * 1e9));
  want('Memory', h?.Memory, o.limits.memoryBytes);
  want('MemorySwap', h?.MemorySwap, o.limits.memoryBytes);
  want('PidsLimit', h?.PidsLimit, o.limits.pids);
  want('AutoRemove', h?.AutoRemove, true);
  want('Privileged', h?.Privileged ?? false, false);
  want('NetworkMode', h?.NetworkMode, o.network);
  want('Init', h?.Init, true);
  want('CapDrop', JSON.stringify(h?.CapDrop ?? null), JSON.stringify(['ALL']));
  const extra = (h?.CapAdd ?? []).map((c) => String(c).toUpperCase().replace(/^CAP_/, '')).filter((c) => !CHECK_CAPS.includes(c));
  if (extra.length) p.push(`CapAdd has ${extra.join(', ')} beyond the check's capabilities`);
  if (!(h?.SecurityOpt ?? []).some((x) => /^no-new-privileges(:true)?$/.test(x))) p.push('SecurityOpt lacks no-new-privileges');
  want(`label ${CHECK_LABELS.role}`, labels?.[CHECK_LABELS.role], 'check');
  return p;
}

/** Waits for the host-wide slot: `flock` on an fd this process keeps, so the lock lasts until `release` (or exit). */
async function takeSlot(lock) {
  const fd = openSync(lock, 'a');
  const code = await new Promise((res) => {
    const c = spawn('flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'inherit', fd] });
    c.on('error', () => res(127));
    c.on('close', (x) => res(x));
  });
  if (code !== 0) { closeSync(fd); throw new CheckError('slot', `cannot take the slot ${lock} (flock exit ${code})`); }
  return { release: () => { try { closeSync(fd); } catch { /* closed */ } } };
}

/** The container this runs in, as the daemon sees it: { mounts, image }; null outside a container. */
function ownContainer(docker) {
  if (!existsSync('/.dockerenv')) return null;
  const r = spawnSync(docker, ['inspect', '-f', '{{json .Mounts}}\t{{.Config.Image}}', hostname()], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new CheckError('inspect', `cannot read this container's mounts (docker inspect ${hostname()}): ${(r.stderr ?? '').trim()}`);
  const [mounts, image] = r.stdout.trim().split('\t');
  return { mounts: JSON.parse(mounts), image: image || null };
}

/** `--image self` → the image of the container this runs in, else CHECK_FALLBACK_IMAGE. */
export const resolveImage = (image, own) => (image === 'self' ? own?.image || CHECK_FALLBACK_IMAGE : image);

/** Runs one check; resolves the command's exit code. */
export async function check(o, { docker = 'docker', log = (s) => process.stderr.write(`[check] ${s}\n`) } = {}) {
  let worktree;
  try { worktree = realpathSync(o.worktree); } catch { throw new CheckError('no-worktree', `no such worktree: ${o.worktree}`); }
  if (!existsSync(join(worktree, 'package.json'))) throw new CheckError('no-worktree', `${worktree} is not a checkout (no package.json)`);
  const st = statSync(worktree);
  const run = { ...o, worktree, gitDir: o.git ? gitCommonDir(worktree) : null, branch: branchOf(worktree) };
  const name = `aura-check-${randomBytes(4).toString('hex')}`;
  const own = ownContainer(docker);
  const mounts = own?.mounts ?? null;
  run.image = resolveImage(o.image, own);
  const l = o.limits;
  log(`${run.image} in ${name} (target ${o.target}): cpus ${l.cpus}, memory ${l.memoryBytes} bytes (no swap), pids ${l.pids}, network ${o.network}, timeout ${o.timeoutS} s; ${worktree} (${run.branch ?? 'unknown branch'})`);
  log(o.lock ? `waiting for the slot ${o.lock} (one check at a time)` : 'no slot lock');
  const slot = o.lock ? await takeSlot(o.lock) : null;
  const remove = () => spawnSync(docker, ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 });
  try {
    const args = checkRunArgs(run, { name, mounts, owner: o.user ?? `${st.uid}:${st.gid}`, started: new Date().toISOString() });
    const c = spawnSync(docker, args, { encoding: 'utf8', timeout: 120_000 });
    if (c.status !== 0) throw new CheckError('create', `docker create failed: ${(c.stderr ?? '').trim().split('\n').slice(-3).join(' / ')}`);
    const i = spawnSync(docker, ['inspect', '-f', '{{json .HostConfig}}\t{{json .Config.Labels}}', name], { encoding: 'utf8', timeout: 20_000 });
    let problems;
    try {
      const [hc, lb] = i.stdout.trim().split('\t');
      problems = capProblems({ hostConfig: JSON.parse(hc), labels: JSON.parse(lb) }, run);
    } catch { problems = [`cannot inspect ${name}: ${(i.stderr ?? '').trim()}`]; }
    if (problems.length) {
      remove();
      throw new CheckError('uncapped', `${name} was not created as asked, removed unstarted: ${problems.join('; ')}`);
    }
    return await new Promise((done) => {
      const child = spawn(docker, ['start', '-a', name], { stdio: ['ignore', 'inherit', 'inherit'] });
      const stop = (sig) => { remove(); child.kill(sig); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      child.on('error', (e) => { log(e.message); remove(); done(127); });
      child.on('close', (code, sig) => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (code === 124) log(`timed out after ${o.timeoutS} s`);
        if (code === 137) log('killed (exit 137): the memory limit, a timeout kill or a signal');
        done(code ?? (sig ? 128 : 1));
      });
    });
  } finally {
    slot?.release();
  }
}

/** CLI: `builder.mjs check …`. */
export async function checkMain(argv) {
  try {
    return await check(parseCheckArgs(argv));
  } catch (e) {
    if (!(e instanceof CheckError)) throw e;
    process.stderr.write(`[check] ${e.code}: ${e.message}\n`);
    return e.exit;
  }
}
