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
  assert.equal(d.image, 'self', 'the image of the container the check runs in');
  assert.equal(CHK.resolveImage('self', { image: 'aura-aura-os' }), 'aura-aura-os');
  assert.equal(CHK.resolveImage('self', null), 'aura-base', 'outside a container');
  assert.equal(CHK.resolveImage('aura-base', { image: 'x' }), 'aura-base');
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

test('the check container: --rm, the limits profile, only the check capabilities, init, --network none, only the worktree (rw) and its git dir (ro), labelled', () => {
  const o = { ...CHK.parseCheckArgs(['--only=kv-store', '--env', 'X=1']), image: 'aura-base', worktree: '/data/dev/x', gitDir: '/workspace/.git', branch: 'phase6/x' };
  const mounts = [{ Type: 'volume', Name: 'vol', Destination: '/data' }, { Type: 'bind', Source: '/srv/aura', Destination: '/workspace' }];
  const a = CHK.checkRunArgs(o, { name: 'aura-check-1', mounts, owner: '0:0', started: '2026-11-27T20:00:00.000Z' }).join(' ');
  assert.match(a, /^create --rm --name aura-check-1 --network none --cpus=4 --memory=6442450944 --memory-swap=6442450944 --pids-limit=2048 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges --init --user 0:0 --workdir \/data\/dev\/x /);
  assert.doesNotMatch(a, /--cap-add (NET_|SYS_|MKNOD|SETPCAP|SETFCAP|ALL)/);
  assert.match(a, /--mount type=volume,source=vol,target=\/data\/dev\/x,volume-subpath=dev\/x --mount type=bind,source=\/srv\/aura\/\.git,target=\/workspace\/\.git,readonly /);
  assert.equal((a.match(/--mount/g) ?? []).length, 2);
  assert.doesNotMatch(a, /docker\.sock|\/home|aura-net|--privileged|-v \//);
  assert.match(a, / --label aura\.role=check --label aura\.check\.worktree=\/data\/dev\/x --label aura\.check\.branch=phase6\/x --label aura\.check\.started=2026-11-27T20:00:00\.000Z --label aura\.check\.timeout=2400 /);
  assert.match(a, /-e HOME=\/tmp -e AURA_TESTS_LIVE_SHELL=1 -e X=1 --entrypoint timeout aura-base -k 30 2400 node tools\/run-tests\.mjs --only=kv-store$/);
  // every limit of the profile is always on the argv, whatever is overridden
  for (const over of [[], ['--cpus=1'], ['--memory', '1g'], ['--pids=64']]) {
    const x = CHK.checkRunArgs({ ...CHK.parseCheckArgs(over), worktree: '/w', gitDir: null }, { name: 'n', mounts: null, owner: '1:1', started: 's' });
    for (const f of ['--rm', /^--cpus=/, /^--memory=/, /^--memory-swap=/, /^--pids-limit=/]) assert.ok(x.some((y) => (typeof f === 'string' ? y === f : f.test(y))), `${f} in ${over}`);
  }
  // the release build's containers come from the same function, with the release profile
  const r = B.buildContainerArgs({ name: 'n', image: 'i', dataVolume: 'v', stagingSub: 's', storeSub: 'p', network: 'none' }).join(' ');
  assert.match(r, /^run --rm --name n --network none --cpus=2 --memory=6442450944 --memory-swap=6442450944 --pids-limit=2048 --cap-drop ALL --security-opt no-new-privileges --workdir \/workspace /);
});

test('capProblems: a created container must carry every limit of its profile, --rm, its network and the role label', () => {
  const o = { limits: { ...LIM.DEFAULT_CHECK_LIMITS }, network: 'none' };
  const good = { hostConfig: { NanoCpus: 4e9, Memory: 6 * GiB, MemorySwap: 6 * GiB, PidsLimit: 2048, AutoRemove: true, Privileged: false, NetworkMode: 'none',
    Init: true, CapDrop: ['ALL'], CapAdd: ['CAP_CHOWN', 'KILL'], SecurityOpt: ['no-new-privileges'] }, labels: { 'aura.role': 'check' } };
  assert.deepEqual(CHK.capProblems(good, o), []);
  assert.deepEqual(CHK.capProblems({ ...good, hostConfig: { ...good.hostConfig, NanoCpus: 0, MemorySwap: -1 } }, o), ['NanoCpus is 0, expected 4000000000', `MemorySwap is -1, expected ${6 * GiB}`]);
  const { Memory, PidsLimit, AutoRemove, ...rest } = good.hostConfig;
  assert.equal(CHK.capProblems({ hostConfig: rest, labels: {} }, o).length, 4);
  assert.deepEqual(CHK.capProblems({ ...good, hostConfig: { ...good.hostConfig, CapAdd: ['CHOWN', 'NET_ADMIN', 'CAP_SYS_ADMIN'] } }, o), ['CapAdd has NET_ADMIN, SYS_ADMIN beyond the check\'s capabilities']);
  assert.deepEqual(CHK.capProblems({ ...good, hostConfig: { ...good.hostConfig, CapDrop: null, SecurityOpt: [], Init: false } }, o),
    ['Init is false, expected true', 'CapDrop is null, expected ["ALL"]', 'SecurityOpt lacks no-new-privileges']);
  assert.match(CHK.capProblems({ ...good, hostConfig: { ...good.hostConfig, Privileged: true, NetworkMode: 'bridge' } }, o).join(), /Privileged.*NetworkMode/);
});

test('branchOf: a linked worktree\'s branch, a clone\'s, a detached HEAD', () => {
  const files = {
    '/data/dev/x/.git': 'gitdir: /workspace/.git/worktrees/x\n', '/workspace/.git/worktrees/x/HEAD': 'ref: refs/heads/phase6/B-check2\n',
    '/c/.git/HEAD': 'ref: refs/heads/main\n', '/d/.git/HEAD': '0123456789abcdef0123456789abcdef01234567\n',
  };
  const read = (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); };
  assert.equal(CHK.branchOf('/data/dev/x', { read }), 'phase6/B-check2');
  assert.equal(CHK.branchOf('/c', { read }), 'main');
  assert.equal(CHK.branchOf('/d', { read }), 'detached@0123456789ab');
  assert.equal(CHK.branchOf('/none', { read }), null);
});

test('check target: live by default (--target / AURA_CHECK_TARGET); an unregistered target is refused (3)', () => {
  assert.deepEqual([...CHK.CHECK_TARGETS], ['live']);
  assert.equal(CHK.parseCheckArgs([]).target, 'live');
  assert.throws(() => CHK.parseCheckArgs(['--target', 'build-vm']), (e) => e.code === 'no-target' && e.exit === 3);
});

// A fake docker (node): records argv; `inspect` of the HostConfig answers from the last `create` (FAKE_DROP drops a field).
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const S = process.env.FAKE_STATE;
const log = S + '/calls.log';
fs.appendFileSync(log, 'docker ' + a.join(' ') + '\\n');
if (a[0] === 'inspect' && a[2].startsWith('{{json .Mounts}}')) { console.log('[{"Type":"bind","Source":"/host","Destination":"/"}]\\taura-shell-image'); process.exit(0); }
if (a[0] === 'inspect') {
  const c = fs.readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('docker create ')).pop().split(' ');
  const v = (f) => c.find((x) => x.startsWith(f + '='))?.slice(f.length + 1);
  const hc = { NanoCpus: Number(v('--cpus')) * 1e9, Memory: Number(v('--memory')), MemorySwap: Number(v('--memory-swap')), PidsLimit: Number(v('--pids-limit')),
    AutoRemove: c.includes('--rm'), Privileged: false, NetworkMode: c[c.indexOf('--network') + 1], Init: c.includes('--init'),
    CapDrop: c.includes('ALL') ? ['ALL'] : null, CapAdd: c.map((x, i) => (c[i - 1] === '--cap-add' ? x : null)).filter(Boolean),
    SecurityOpt: c.includes('no-new-privileges') ? ['no-new-privileges'] : [] };
  if (process.env.FAKE_DROP) delete hc[process.env.FAKE_DROP];
  const labels = Object.fromEntries(c.map((x, i) => (c[i - 1] === '--label' ? x.split(/=(.*)/s).slice(0, 2) : null)).filter(Boolean));
  console.log(JSON.stringify(hc) + '\\t' + JSON.stringify(labels));
  process.exit(0);
}
if (a[0] === 'start') {
  const held = require('node:child_process').spawnSync('flock', ['-n', process.env.FAKE_LOCK, 'true']).status !== 0;
  fs.writeFileSync(S + '/lock', held ? 'held' : 'free');
  console.log('check output on stdout');
  process.exit(Number(process.env.FAKE_RC ?? 0));
}
process.exit(0);
`;

test('builder.mjs check: create, inspect, start; output and exit code pass through under the slot lock; an uncapped container is removed unstarted (3)', () => {
  const bin = tmp('aura-check-bin-');
  const state = tmp('aura-check-state-');
  writeFileSync(join(bin, 'docker'), FAKE);
  chmodSync(join(bin, 'docker'), 0o755);
  const wt = tmp('aura-check-wt-');
  writeFileSync(join(wt, 'package.json'), '{}');
  mkdirSync(join(wt, 'packages'));
  const lock = join(state, 'slot.lock');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_LOCK: lock, FAKE_RC: '7' };
  delete env.AURA_CHECK_TARGET;
  const run = (args, extra = {}) => spawnSync(process.execPath, [join(ROOT, 'os/release/builder.mjs'), 'check', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const calls = () => readFileSync(join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  const r = run(['--worktree', wt, '--lock', lock, '--only=core']);
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stdout, /check output on stdout/);
  assert.match(r.stderr, /\(target live\): cpus 4, memory 6442450944 bytes \(no swap\), pids 2048, network none/);
  assert.equal(readFileSync(join(state, 'lock'), 'utf8').trim(), 'held', 'the container ran while the slot lock was held');
  const create = calls().find((l) => l.startsWith('docker create'));
  const name = /--name (aura-check-[0-9a-f]{8}) /.exec(create)[1];
  assert.match(create, new RegExp(`type=bind,source=(/host)?${wt},target=${wt} `));
  assert.match(create, / --label aura\.role=check .*--label aura\.check\.started=\d{4}-\d\d-\d\dT[^ ]+ --label aura\.check\.timeout=2400 /);
  // --image self: the fake's own container image inside a container, aura-base outside one
  assert.match(create, /--entrypoint timeout (aura-shell-image|aura-base) -k 30 2400 node tools\/run-tests\.mjs --only=core$/);
  const order = calls().filter((l) => !l.includes('{{json .Mounts}}')).map((l) => l.split(' ').slice(0, 2).join(' '));
  assert.deepEqual(order, ['docker create', 'docker inspect', 'docker start'], 'inspected before it starts');
  assert.match(calls().find((l) => l.startsWith('docker start')), new RegExp(`start -a ${name}$`));
  const free = run(['--worktree', wt, '--no-lock', '--', 'true']);
  assert.equal(free.status, 7);
  assert.equal(readFileSync(join(state, 'lock'), 'utf8').trim(), 'free');
  for (const field of ['Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'AutoRemove', 'Init']) {
    writeFileSync(join(state, 'calls.log'), '');
    const u = run(['--worktree', wt, '--no-lock'], { FAKE_DROP: field });
    assert.equal(u.status, 3, field);
    assert.match(u.stderr, new RegExp(`uncapped: .*${field} is unset`));
    assert.ok(calls().some((l) => /^docker rm -f aura-check-/.test(l)), 'removed');
    assert.ok(!calls().some((l) => l.startsWith('docker start')), 'never started');
  }
  const missing = run(['--worktree', join(wt, 'nope'), '--no-lock']);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /no-worktree/);
  assert.equal(run(['--network', 'host']).status, 64);
  assert.equal(run(['--worktree', wt], { AURA_CHECK_TARGET: 'build-vm' }).status, 3);
});
