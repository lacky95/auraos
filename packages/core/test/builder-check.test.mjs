// D106 item 1: the release builder's check mode (os/release/check.mjs) and its limits twin
// (os/release/limits.mjs = runtimes/container/limits.ts, compared on one table). The check runs a command
// of a worktree in the builder's throwaway container (container.mjs): limits enforced, no socket, no home,
// --network none, the worktree's path mapped through this container's own mounts, one slot lock.
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tmp } from './release-fixtures.mjs';

const LIM = await import(join(ROOT, 'os/release/limits.mjs'));
const CHK = await import(join(ROOT, 'os/release/check.mjs'));
const B = await import(join(ROOT, 'os/release/builder.mjs'));
const GiB = 1024 ** 3;

/** One table for the twin and core (the same rows as core's resource-limits.test.mjs LIMIT_TABLE). */
const TABLE = [
  [{}, []],
  [{ cpus: 4 }, ['--cpus=4']],
  [{ cpus: 0.5 }, ['--cpus=0.5']],
  [{ memoryBytes: 6 * GiB }, [`--memory=${6 * GiB}`, `--memory-swap=${6 * GiB}`]],
  [{ pids: 2048 }, ['--pids-limit=2048']],
  [{ cpus: 2, memoryBytes: 3 * GiB, pids: 512 }, ['--cpus=2', `--memory=${3 * GiB}`, `--memory-swap=${3 * GiB}`, '--pids-limit=512']],
  [{ pids: 64, cpus: 1 }, ['--cpus=1', '--pids-limit=64']],
];
const BAD = [null, [], 'x', { cpus: 0 }, { cpus: -1 }, { cpus: NaN }, { cpus: Infinity }, { memoryBytes: 1.5 }, { memoryBytes: 0 },
  { pids: 2.5 }, { pids: '64' }, { swapBytes: 1 }];
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

test('limits.mjs: one flag set per field, memory without swap beyond it; invalid records refused with invalid-resource-limits', () => {
  for (const [l, args] of TABLE) assert.deepEqual(LIM.limitArgs(l), args, JSON.stringify(l));
  for (const bad of BAD) assert.equal(codeOf(() => LIM.limitArgs(bad)), 'invalid-resource-limits', JSON.stringify(bad));
  assert.deepEqual({ ...LIM.DEFAULT_CHECK_LIMITS }, { cpus: 4, memoryBytes: 6 * GiB, pids: 2048 });
  assert.deepEqual({ ...LIM.RELEASE_BUILD_LIMITS }, { cpus: 2, memoryBytes: 6 * GiB, pids: 2048 });
  for (const p of [LIM.DEFAULT_BUILD_LIMITS, LIM.DEFAULT_CHECK_LIMITS, LIM.RELEASE_BUILD_LIMITS]) assert.equal(Object.isFrozen(p), true);
  assert.deepEqual(['6g', '512m', '1024', '1.5g', 'six'].map(LIM.parseBytes), [6 * GiB, 512 * 1024 ** 2, 1024, 1.5 * GiB, NaN]);
});

const CORE_LIMITS = join(ROOT, 'packages/core/src/runtimes/container/limits.ts');
test('limits.mjs is the twin of core runtimes/container/limits.ts: same mapping, validation codes and DEFAULT_BUILD_LIMITS', {
  skip: existsSync(CORE_LIMITS) ? false : 'runtimes/container/limits.ts is not in this tree yet (phase6/ari-rest adds it): the twin comparison runs once it is merged',
}, async () => {
  const core = await import(join(ROOT, 'packages/core/dist/runtimes/container/limits.js'));
  for (const [l] of TABLE) assert.deepEqual(LIM.limitArgs(l), core.limitArgs(l), JSON.stringify(l));
  for (const bad of BAD) assert.equal(codeOf(() => LIM.limitArgs(bad)), codeOf(() => core.limitArgs(bad)), JSON.stringify(bad));
  assert.equal(LIM.INVALID_RESOURCE_LIMITS, core.INVALID_RESOURCE_LIMITS);
  assert.deepEqual({ ...LIM.DEFAULT_BUILD_LIMITS }, { ...core.DEFAULT_BUILD_LIMITS });
});

test('check options: run-tests --only by default, the check profile, --network none; overrides validated (usage 64)', () => {
  const d = CHK.parseCheckArgs(['--only=core,kv-store', '--worktree', '/w']);
  assert.deepEqual(d.cmd, ['node', 'tools/run-tests.mjs', '--only=core,kv-store']);
  assert.deepEqual(d.limits, { ...LIM.DEFAULT_CHECK_LIMITS });
  assert.equal(d.network, 'none');
  assert.equal(d.image, 'aura-base');
  assert.equal(d.timeoutS, 2400);
  assert.equal(d.git, true);
  const o = CHK.parseCheckArgs(['--cpus=2', '--memory', '3g', '--pids=512', '--network', 'bridge', '--timeout=60', '--no-lock', '--no-git',
    '--env', 'NODE_OPTIONS=--max-old-space-size=3072', '--', 'npx', 'tsc', '--noEmit']);
  assert.deepEqual(o.limits, { cpus: 2, memoryBytes: 3 * GiB, pids: 512 });
  assert.deepEqual([o.network, o.timeoutS, o.lock, o.git], ['bridge', 60, null, false]);
  assert.deepEqual(o.env, { NODE_OPTIONS: '--max-old-space-size=3072' });
  assert.deepEqual(o.cmd, ['npx', 'tsc', '--noEmit']);
  assert.equal(CHK.parseCheckArgs(['--lock', '/x/slot']).lock, '/x/slot');
  // pnpm passes its `--` on: `pnpm check -- --only=core` and `pnpm check -- --no-lock -- tsc` keep working
  assert.deepEqual(CHK.parseCheckArgs(['--', '--only=core']).cmd, ['node', 'tools/run-tests.mjs', '--only=core']);
  const p = CHK.parseCheckArgs(['--', '--no-lock', '--', 'tsc', '-p', '.']);
  assert.deepEqual([p.lock, p.cmd], [null, ['tsc', '-p', '.']]);
  for (const bad of [['--network', 'host'], ['--network', 'aura-net'], ['--cpus=0'], ['--memory', 'lots'], ['--pids=1.5'], ['--timeout=0'], ['--env', 'NOEQ'], ['stray']]) {
    assert.throws(() => CHK.parseCheckArgs(bad), (e) => e.exit === 64, bad.join(' '));
  }
});

test('the worktree path is mapped through this container\'s own mounts (volume subpath, bind source; longest wins)', () => {
  const mounts = [
    { Type: 'volume', Name: 'aura_aura-app-data', Destination: '/data' },
    { Type: 'bind', Source: '/srv/aura', Destination: '/workspace' },
    { Type: 'volume', Name: 'aura_aura-node-modules', Destination: '/workspace/node_modules' },
  ];
  assert.deepEqual(CHK.daemonSourceOf('/data/dev/phase6/x', mounts), { type: 'volume', source: 'aura_aura-app-data', subpath: 'dev/phase6/x' });
  assert.deepEqual(CHK.daemonSourceOf('/workspace/.git', mounts), { type: 'bind', source: '/srv/aura/.git' });
  assert.deepEqual(CHK.daemonSourceOf('/workspace/node_modules/a', mounts), { type: 'volume', source: 'aura_aura-node-modules', subpath: 'a' });
  assert.deepEqual(CHK.daemonSourceOf('/data', mounts), { type: 'volume', source: 'aura_aura-app-data' });
  assert.deepEqual(CHK.daemonSourceOf('/datax/y', [{ Type: 'bind', Source: '/', Destination: '/' }]), { type: 'bind', source: '/datax/y' });
  assert.throws(() => CHK.daemonSourceOf('/datax/y', mounts), (e) => e.code === 'not-mounted');
  assert.deepEqual(CHK.daemonSourceOf('/home/me/wt', null), { type: 'bind', source: '/home/me/wt' }, 'outside a container: the daemon\'s own path');
});

test('a linked worktree needs its git common dir (mounted read-only); a plain clone does not', () => {
  const files = { '/data/dev/x/.git': 'gitdir: /workspace/.git/worktrees/x\n', '/workspace/.git/worktrees/x/commondir': '../..\n' };
  const read = (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); };
  assert.equal(CHK.gitCommonDir('/data/dev/x', { read }), '/workspace/.git');
  assert.equal(CHK.gitCommonDir('/data/dev/clone', { read }), null);
});

test('the check container: --rm, the limits profile, no capabilities, --network none, only the worktree (rw) and its git dir (ro)', () => {
  const o = { ...CHK.parseCheckArgs(['--only=kv-store', '--env', 'X=1']), worktree: '/data/dev/x', gitDir: '/workspace/.git' };
  const mounts = [{ Type: 'volume', Name: 'vol', Destination: '/data' }, { Type: 'bind', Source: '/srv/aura', Destination: '/workspace' }];
  const a = CHK.checkRunArgs(o, { name: 'aura-check-1', mounts, owner: '0:0' }).join(' ');
  assert.match(a, /^run --rm --name aura-check-1 --network none --cpus=4 --memory=6442450944 --memory-swap=6442450944 --pids-limit=2048 --cap-drop ALL --security-opt no-new-privileges --user 0:0 --workdir \/data\/dev\/x /);
  assert.match(a, /--mount type=volume,source=vol,target=\/data\/dev\/x,volume-subpath=dev\/x --mount type=bind,source=\/srv\/aura\/\.git,target=\/workspace\/\.git,readonly /);
  assert.equal((a.match(/--mount/g) ?? []).length, 2);
  assert.doesNotMatch(a, /docker\.sock|\/home|aura-net|--privileged|-v \//);
  assert.match(a, /-e HOME=\/tmp -e AURA_TESTS_LIVE_SHELL=1 -e X=1 --entrypoint timeout aura-base -k 30 2400 node tools\/run-tests\.mjs --only=kv-store$/);
  // the release build's containers come from the same function, with the release profile
  const r = B.buildContainerArgs({ name: 'n', image: 'i', dataVolume: 'v', stagingSub: 's', storeSub: 'p', network: 'none' }).join(' ');
  assert.match(r, /--network none --cpus=2 --memory=6442450944 --memory-swap=6442450944 --pids-limit=2048 --cap-drop ALL --security-opt no-new-privileges --workdir \/workspace /);
});

const FAKE = `#!/bin/sh
echo "docker $*" >> "$FAKE_STATE/calls.log"
case "$1" in
  inspect) echo '[{"Type":"bind","Source":"/host","Destination":"/"}]'; exit 0 ;;
  run) if flock -n "$FAKE_LOCK" true 2>/dev/null; then echo free > "$FAKE_STATE/lock"; else echo held > "$FAKE_STATE/lock"; fi
       echo "check output on stdout"; exit "\${FAKE_RC:-0}" ;;
esac
exit 0
`;

test('builder.mjs check: the command\'s output and exit code pass through, under the slot lock; a missing worktree is refused (3)', () => {
  const bin = tmp('aura-check-bin-');
  const state = tmp('aura-check-state-');
  writeFileSync(join(bin, 'docker'), FAKE);
  chmodSync(join(bin, 'docker'), 0o755);
  const wt = tmp('aura-check-wt-');
  writeFileSync(join(wt, 'package.json'), '{}');
  mkdirSync(join(wt, 'packages'));
  const lock = join(state, 'slot.lock');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_LOCK: lock, FAKE_RC: '7' };
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'os/release/builder.mjs'), 'check', ...args], { env, encoding: 'utf8' });
  const r = run('--worktree', wt, '--lock', lock, '--only=core');
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stdout, /check output on stdout/);
  assert.match(r.stderr, /cpus 4, memory 6442450944 bytes \(no swap\), pids 2048, network none/);
  assert.equal(readFileSync(join(state, 'lock'), 'utf8').trim(), 'held', 'docker run ran while the slot lock was held');
  const call = readFileSync(join(state, 'calls.log'), 'utf8').split('\n').find((l) => l.startsWith('docker run'));
  assert.match(call, new RegExp(`type=bind,source=(/host)?${wt},target=${wt} `));
  assert.match(call, /--entrypoint timeout aura-base -k 30 2400 node tools\/run-tests\.mjs --only=core$/);
  const free = run('--worktree', wt, '--no-lock', '--', 'true');
  assert.equal(free.status, 7);
  assert.equal(readFileSync(join(state, 'lock'), 'utf8').trim(), 'free');
  const missing = run('--worktree', join(wt, 'nope'), '--no-lock');
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /no-worktree/);
  assert.equal(run('--network', 'host').status, 64);
});
