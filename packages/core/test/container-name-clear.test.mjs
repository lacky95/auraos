// Regression tests for ContainerRunner.spawn's name pre-clear. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/container-name-clear.test.mjs
//
// Background: `aura restart app <container app>` 500'd with "Conflict. The
// container name "/aura-<id>" is already in use". App containers run with
// `--rm`; after kill()'s `docker stop` returns, the daemon is still removing
// the old container. spawn's `docker rm -f` then failed with "removal already
// in progress" (swallowed) and `docker run` hit the name conflict.
// clearContainerName must wait out a `removing` container, force-remove other
// leftovers, and never touch a container a live instance is using.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearContainerName } from '../dist/app-manager/ContainerRunner.js';

/** Fake docker: `states` is the sequence inspect returns, one per call. */
function fakeDocker(states, { live = () => false } = {}) {
  const calls = { inspect: 0, removed: [], slept: 0 };
  const deps = {
    inspect: async () => {
      const st = states[Math.min(calls.inspect, states.length - 1)];
      calls.inspect++;
      return st;
    },
    remove: async (ref) => { calls.removed.push(ref); },
    sleep: async () => { calls.slept++; },
    isLive: live,
    pollMs: 0,
  };
  return { deps, calls };
}

test('returns at once when the name is free', async () => {
  const { deps, calls } = fakeDocker([null]);
  await clearContainerName('aura-x', deps);
  assert.equal(calls.inspect, 1);
  assert.deepEqual(calls.removed, []);
});

test('waits while the old --rm container is still being removed (the restart race)', async () => {
  const old = { id: 'old123', status: 'removing' };
  const { deps, calls } = fakeDocker([old, old, old, null]);
  await clearContainerName('aura-x', deps);
  assert.equal(calls.inspect, 4);
  // `docker rm -f` on a removing container only errors — don't issue it.
  assert.deepEqual(calls.removed, []);
  assert.equal(calls.slept, 3);
});

test('force-removes an exited leftover and re-checks', async () => {
  const { deps, calls } = fakeDocker([{ id: 'dead1', status: 'exited' }, null]);
  await clearContainerName('aura-x', deps);
  assert.deepEqual(calls.removed, ['dead1']);
  assert.equal(calls.inspect, 2);
});

test('removes an untracked orphan even if still running', async () => {
  const { deps, calls } = fakeDocker([{ id: 'orph', status: 'running' }, { id: 'orph', status: 'removing' }, null]);
  await clearContainerName('aura-x', deps);
  assert.deepEqual(calls.removed, ['orph']);
});

test('a failing rm (removal already in progress) keeps waiting instead of giving up', async () => {
  const { deps, calls } = fakeDocker([{ id: 'a', status: 'exited' }, { id: 'a', status: 'removing' }, null]);
  deps.remove = async (ref) => { calls.removed.push(ref); throw new Error('removal of container a is already in progress'); };
  await clearContainerName('aura-x', deps);
  assert.equal(calls.inspect, 3);
});

test('never removes the container of a live instance', async () => {
  const { deps, calls } = fakeDocker([{ id: 'live1', status: 'running' }], { live: (id) => id === 'live1' });
  await assert.rejects(clearContainerName('aura-x', deps), /in use by live container/);
  assert.deepEqual(calls.removed, []);
});

test('fails clearly when the name never frees up', async () => {
  const { deps } = fakeDocker([{ id: 'stuck', status: 'removing' }]);
  deps.timeoutMs = 0;
  await assert.rejects(clearContainerName('aura-x', deps), /still taken.*state=removing/);
});

test('M6: while the survivors are unknown, a running untracked container is never removed; a dead leftover still is', async () => {
  const running = fakeDocker([{ id: 'surv1', status: 'running' }]);
  running.deps.survivorsUnknown = () => true;
  await assert.rejects(clearContainerName('aura-com.aura.terminal-1', running.deps), /may survive from before the shell restart/);
  assert.deepEqual(running.calls.removed, []);
  const exited = fakeDocker([{ id: 'dead1', status: 'exited' }, null]);
  exited.deps.survivorsUnknown = () => true;
  await clearContainerName('aura-x', exited.deps);
  assert.deepEqual(exited.calls.removed, ['dead1']);
});
