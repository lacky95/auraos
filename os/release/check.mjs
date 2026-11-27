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
// Options:
//   --worktree DIR    the checkout to check (default: the current directory); mounted rw at its own path
//   --image IMG       default aura-base (node + toolchain; the tools come from the worktree's node_modules).
//                     aura-base has no pnpm and no valkey-server: `pnpm …` commands and the kv-store suite
//                     need the shell image (`docker inspect aura-shell -f '{{.Config.Image}}'`)
//   --cpus N --memory BYTES|6g --pids N     the limits profile (DEFAULT_CHECK_LIMITS)
//   --network none|bridge                   default none; bridge only for `pnpm install` through the registry
//   --timeout SEC     default 2400; the container is killed after it
//   --env KEY=VALUE   repeatable, e.g. NODE_OPTIONS=--max-old-space-size=3072
//   --lock FILE       the host-wide slot (default /data/dev/.cpu.lock when its directory exists): one
//                     capped check at a time, since the sum of capped containers can still exceed the host
//   --no-lock         run without the slot
//   --no-git          do not mount the worktree's git directory (read-only; dep-check lists files through git)
//
// The container: `--rm`, --network none, no capabilities, no-new-privileges,
// the worktree owner's uid:gid, HOME=/tmp, no Docker socket, no home, no
// secrets, nothing of /data but the worktree. Run it where the worktree lives
// (in aura-shell for /data/dev/...): the worktree's path is mapped to what the
// Docker daemon sees through this container's own mounts (a volume subpath or
// a bind source). AURA_TESTS_LIVE_SHELL=1 makes tools/run-tests.mjs's D106
// guard require the cgroup cap (memory.max) inside, so a check that lost its
// cap refuses instead of running uncapped.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from '../release-verify.mjs';
import { throwawayArgs } from './container.mjs';
import { DEFAULT_CHECK_LIMITS, parseBytes, validateLimits } from './limits.mjs';

export const CHECK_IMAGE = 'aura-base';
export const CHECK_LOCK = '/data/dev/.cpu.lock';
export const CHECK_TIMEOUT_S = 2400;
export const CHECK_NETWORKS = Object.freeze(['none', 'bridge']);

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
  return {
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

/** The `docker run` argv of one check (no I/O: mounts and owner are passed in). */
export function checkRunArgs(o, { name, mounts, owner }) {
  const at = (path, readonly) => ({ ...daemonSourceOf(path, mounts), target: path, readonly });
  const m = [at(o.worktree, false)];
  if (o.gitDir) m.push(at(o.gitDir, true));
  return [
    ...throwawayArgs({
      name, image: o.image, network: o.network, limits: o.limits, workdir: o.worktree, mounts: m, user: owner,
      env: { HOME: '/tmp', AURA_TESTS_LIVE_SHELL: '1', ...o.env }, entrypoint: 'timeout',
    }),
    '-k', '30', String(o.timeoutS), ...o.cmd,
  ];
}

/** This container's mounts as the daemon sees them, or null outside a container. */
function ownMounts(docker) {
  if (!existsSync('/.dockerenv')) return null;
  const r = spawnSync(docker, ['inspect', '-f', '{{json .Mounts}}', hostname()], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new CheckError('inspect', `cannot read this container's mounts (docker inspect ${hostname()}): ${(r.stderr ?? '').trim()}`);
  return JSON.parse(r.stdout);
}

/** Runs one check; resolves the command's exit code. */
export async function check(o, { docker = 'docker', log = (s) => process.stderr.write(`[check] ${s}\n`) } = {}) {
  let worktree;
  try { worktree = realpathSync(o.worktree); } catch { throw new CheckError('no-worktree', `no such worktree: ${o.worktree}`); }
  if (!existsSync(join(worktree, 'package.json'))) throw new CheckError('no-worktree', `${worktree} is not a checkout (no package.json)`);
  const st = statSync(worktree);
  const run = { ...o, worktree, gitDir: o.git ? gitCommonDir(worktree) : null };
  const name = `aura-check-${randomBytes(4).toString('hex')}`;
  const args = checkRunArgs(run, { name, mounts: ownMounts(docker), owner: `${st.uid}:${st.gid}` });
  const argv = o.lock ? ['flock', o.lock, docker, ...args] : [docker, ...args];
  const l = o.limits;
  log(`${o.image} in ${name}: cpus ${l.cpus}, memory ${l.memoryBytes} bytes (no swap), pids ${l.pids}, network ${o.network}, timeout ${o.timeoutS} s; ${worktree}`);
  log(o.lock ? `waiting for the slot ${o.lock} (one check at a time)` : 'no slot lock');
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
    const stop = (sig) => {
      spawnSync(docker, ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 });
      child.kill(sig);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.on('error', (e) => { log(e.message); done(127); });
    child.on('close', (code, sig) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (code === 124) log(`timed out after ${o.timeoutS} s`);
      if (code === 137) log('killed (exit 137): the memory limit, a timeout kill or a signal');
      done(code ?? (sig ? 128 : 1));
    });
  });
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
