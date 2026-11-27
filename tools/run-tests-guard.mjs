// The resource guard of tools/run-tests.mjs (D106, 2026-11-27; D95 L1). Package suites in the live master
// container (aura-shell) drove the host to load ~96: a run there must be capped by its cgroup (a check
// container), or follow the CPU rule (`flock /data/dev/.cpu.lock nice -n 19 ionice -c3 ...`), or name an
// explicit reason. Every suite runs with a bounded `--test-concurrency` (default 2).
// Pure functions over injected readers, so they are unit-tested (packages/core/test/run-tests-guard.test.mjs).
import { readFileSync, existsSync } from 'node:fs';

export const DEFAULT_TEST_CONCURRENCY = 2;
export const MAX_TEST_CONCURRENCY = 8;
export const CPU_LOCK = '/data/dev/.cpu.lock';
export const UNCAPPED_OVERRIDE = '--allow-live-uncapped';
export const UNCAPPED_ENV = 'AURA_TESTS_ALLOW_UNCAPPED';
export const LIVE_ENV = 'AURA_TESTS_LIVE_SHELL';

/** `--test-concurrency=<n>` for every suite: the option, else AURA_TEST_CONCURRENCY, else 2; 1..8. */
export function testConcurrency(optValue, env = process.env) {
  const raw = optValue ?? env.AURA_TEST_CONCURRENCY;
  if (raw === undefined || raw === '') return DEFAULT_TEST_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TEST_CONCURRENCY) throw new Error(`--test-concurrency must be an integer 1..${MAX_TEST_CONCURRENCY}, got ${raw}`);
  return n;
}

/** Insert `--test-concurrency=<n>` after the first `--test` of a node/tsx test script (an explicit one wins). */
export function withConcurrency(script, n) {
  if (/--test-concurrency[= ]/.test(script)) return script;
  return script.replace(/--test(\s|$)/, `--test --test-concurrency=${n}$1`);
}

const defaultRead = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

/**
 * The live master container: the shell's boot dir, the Docker socket and the boot script of a /workspace
 * checkout. A check container (aura-base with a worktree mounted) has none of them.
 * AURA_TESTS_LIVE_SHELL=1|0 states it explicitly.
 */
export function isLiveShell({ env = process.env, exists = existsSync } = {}) {
  if (env[LIVE_ENV] === '1') return true;
  if (env[LIVE_ENV] === '0') return false;
  return exists('/data/aura/boot') && exists('/var/run/docker.sock') && exists('/workspace/os/boot.sh');
}

/** The process's cgroup memory limit in bytes (cgroup v2 `memory.max`, else v1), or null when unlimited. */
export function cgroupMemoryLimit({ read = defaultRead } = {}) {
  const v2 = read('/sys/fs/cgroup/memory.max');
  if (v2 !== null) { const s = v2.trim(); return s === 'max' || s === '' ? null : Number(s); }
  const v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (v1 === null) return null;
  const n = Number(v1.trim());
  return Number.isFinite(n) && n < 2 ** 60 ? n : null;
}

/** An ancestor process is `flock <CPU_LOCK> ...` (the CPU rule), found through /proc. */
export function underCpuLock({ pid = process.pid, read = defaultRead, lock = CPU_LOCK } = {}) {
  let cur = pid;
  for (let depth = 0; depth < 64 && cur > 1; depth++) {
    const cmd = read(`/proc/${cur}/cmdline`);
    if (cmd !== null) {
      const argv = cmd.split('\0').filter(Boolean);
      if (argv.length && /(^|\/)flock$/.test(argv[0]) && argv.includes(lock)) return true;
    }
    const stat = read(`/proc/${cur}/stat`);
    if (stat === null) return false;
    // pid (comm) state ppid ...: comm may hold spaces and parentheses, so split after the last ')'.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!Number.isInteger(ppid) || ppid === cur) return false;
    cur = ppid;
  }
  return false;
}

/**
 * Whether this run may start. Outside the live shell: always. Inside: capped by its cgroup, or under the CPU
 * lock, or with an explicit reason (`--allow-live-uncapped=<reason>` / AURA_TESTS_ALLOW_UNCAPPED=<reason>).
 */
export function liveShellVerdict({ args = [], env = process.env, live, memoryLimit, cpuLock }) {
  if (!live) return { ok: true, why: 'not the live shell' };
  if (memoryLimit) return { ok: true, why: `capped by its cgroup (memory.max ${memoryLimit} bytes)` };
  if (cpuLock) return { ok: true, why: `under the CPU lock (${CPU_LOCK})` };
  const reason = args.find((a) => a.startsWith(`${UNCAPPED_OVERRIDE}=`))?.slice(UNCAPPED_OVERRIDE.length + 1) || env[UNCAPPED_ENV];
  if (reason) return { ok: true, why: `uncapped in the live shell on purpose: ${reason}` };
  return {
    ok: false,
    why: [
      'Refusing to run package suites uncapped in the live shell (aura-shell): they starve the owner\'s desktop (D106).',
      'Run them in a capped check container (the builder check mode, agent-brief.md), on a build/test VM, or',
      `under the CPU rule: flock ${CPU_LOCK} nice -n 19 ionice -c3 node tools/run-tests.mjs --only=<pkg>`,
      `(${UNCAPPED_OVERRIDE}=<reason> overrides it, for the owner only.)`,
    ].join('\n'),
  };
}
