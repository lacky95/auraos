// D106: the resource guard of tools/run-tests.mjs (bounded test concurrency; no uncapped run in the live shell).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CPU_LOCK, DEFAULT_TEST_CONCURRENCY, cgroupMemoryLimit, isLiveShell, liveShellVerdict, testConcurrency, underCpuLock, withConcurrency,
} from '../../../tools/run-tests-guard.mjs';

test('test concurrency: default 2, the option or env within 1..8, otherwise refused', () => {
  assert.equal(testConcurrency(undefined, {}), DEFAULT_TEST_CONCURRENCY);
  assert.equal(testConcurrency('3', {}), 3);
  assert.equal(testConcurrency(undefined, { AURA_TEST_CONCURRENCY: '1' }), 1);
  for (const bad of ['0', '9', 'x', '2.5']) assert.throws(() => testConcurrency(bad, {}), /1\.\.8/);
});

test('every node/tsx --test script gets the cap once; an explicit one wins', () => {
  assert.equal(withConcurrency('tsc && node --test test/a.test.mjs', 2), 'tsc && node --test --test-concurrency=2 test/a.test.mjs');
  assert.equal(withConcurrency('tsx --test test/*.test.ts', 2), 'tsx --test --test-concurrency=2 test/*.test.ts');
  assert.equal(withConcurrency('node --test --test-concurrency=1 x', 2), 'node --test --test-concurrency=1 x');
  assert.equal(withConcurrency('vitest run', 2), 'vitest run', 'not a node --test script: unchanged');
});

test('the live shell is the master container layout, or what AURA_TESTS_LIVE_SHELL says', () => {
  const all = () => true, none = () => false;
  assert.equal(isLiveShell({ env: {}, exists: all }), true);
  assert.equal(isLiveShell({ env: {}, exists: (p) => p !== '/var/run/docker.sock' }), false, 'a check container has no socket');
  assert.equal(isLiveShell({ env: { AURA_TESTS_LIVE_SHELL: '1' }, exists: none }), true);
  assert.equal(isLiveShell({ env: { AURA_TESTS_LIVE_SHELL: '0' }, exists: all }), false);
});

test('cgroup memory limit: v2 max means none, a number is a cap; v1 huge means none', () => {
  const r = (files) => (p) => files[p] ?? null;
  assert.equal(cgroupMemoryLimit({ read: r({ '/sys/fs/cgroup/memory.max': 'max\n' }) }), null);
  assert.equal(cgroupMemoryLimit({ read: r({ '/sys/fs/cgroup/memory.max': '6442450944\n' }) }), 6442450944);
  assert.equal(cgroupMemoryLimit({ read: r({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }) }), null);
  assert.equal(cgroupMemoryLimit({ read: r({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824' }) }), 1073741824);
  assert.equal(cgroupMemoryLimit({ read: r({}) }), null);
});

test('the CPU rule is found as a flock ancestor holding the lock, through comm names with spaces', () => {
  const proc = {
    '/proc/30/cmdline': 'node\0tools/run-tests.mjs\0', '/proc/30/stat': '30 (node) S 20 0',
    '/proc/20/cmdline': 'ionice\0-c3\0node\0', '/proc/20/stat': '20 (a (b) c) S 10 0',
    '/proc/10/cmdline': `flock\0${CPU_LOCK}\0nice\0`, '/proc/10/stat': '10 (flock) S 1 0',
  };
  const read = (p) => proc[p] ?? null;
  assert.equal(underCpuLock({ pid: 30, read }), true);
  assert.equal(underCpuLock({ pid: 30, read: (p) => (p === '/proc/10/cmdline' ? 'flock\0/tmp/other.lock\0' : read(p)) }), false, 'another lock is not the rule');
  assert.equal(underCpuLock({ pid: 30, read: (p) => (p.startsWith('/proc/10') ? null : read(p)) }), false);
});

test('the verdict: outside the live shell always; inside only capped, under the lock or with a reason', () => {
  assert.equal(liveShellVerdict({ live: false }).ok, true);
  assert.equal(liveShellVerdict({ live: true, memoryLimit: 6e9 }).ok, true);
  assert.equal(liveShellVerdict({ live: true, cpuLock: true }).ok, true);
  assert.equal(liveShellVerdict({ live: true, args: ['--allow-live-uncapped=owner: one quick run'], env: {} }).ok, true);
  assert.equal(liveShellVerdict({ live: true, args: [], env: { AURA_TESTS_ALLOW_UNCAPPED: 'owner' } }).ok, true);
  const no = liveShellVerdict({ live: true, args: [], env: {} });
  assert.equal(no.ok, false);
  assert.match(no.why, /flock \/data\/dev\/\.cpu\.lock nice -n 19 ionice -c3/);
  assert.match(no.why, /check container/);
  assert.equal(liveShellVerdict({ live: true, args: ['--allow-live-uncapped='], env: {} }).ok, false, 'an empty reason is none');
});
