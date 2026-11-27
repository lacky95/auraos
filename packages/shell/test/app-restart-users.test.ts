/**
 * appRestart (5-main VM finding): instances of several users are never merged into one. A restart of the System
 * Terminal with the owner's and a member's instance running brought both back as ONE instance of the first one's
 * owner (the member): the owner had no Terminal left, the member two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartWithActivities } from '../src/lib/appRestart.js';

test('a restart of an app with instances of two users restarts each user into their own instance', async () => {
  const stopped: string[] = [];
  const started: Array<string | undefined> = [];
  let n = 10;
  const instances = [
    { instanceId: 'com.aura.terminal-7', owner: 'u-member', inPool: false },
    { instanceId: 'com.aura.terminal-5', owner: 'default', inPool: false },
    { instanceId: 'com.aura.terminal-6', inPool: true },
  ];
  const fake = {
    getManifest: () => ({ id: 'com.aura.terminal', activityMode: 'none', componentType: 'service' }),
    getInstancesByApp: () => instances,
    getActivitiesByInstance: () => [],
    stop: async (id: string) => { stopped.push(id); },
    stopAll: async () => { throw new Error('stopAll merges every user'); },
    start: async (_app: string, o: { userId?: string }) => { started.push(o.userId); return `com.aura.terminal-${n++}`; },
  };
  const g = globalThis as Record<string, unknown>;
  const prev = g['__aura_app_manager__'];
  g['__aura_app_manager__'] = fake;
  try {
    const r = await restartWithActivities('com.aura.terminal');
    assert.deepEqual(started.sort(), ['default', 'u-member']);
    assert.deepEqual(stopped.sort(), ['com.aura.terminal-5', 'com.aura.terminal-6', 'com.aura.terminal-7']);
    // The local owner's restart is the answer; the member's is beside it, each with its own old instance only.
    assert.equal(r.userId, 'default');
    assert.deepEqual(r.oldInstanceIds, ['com.aura.terminal-5']);
    assert.equal(r.others?.length, 1);
    assert.deepEqual(r.others?.[0]?.oldInstanceIds, ['com.aura.terminal-7']);
    assert.equal(r.others?.[0]?.userId, 'u-member');
  } finally {
    g['__aura_app_manager__'] = prev;
  }
});

test('one user: still one restart through stopAll', async () => {
  const calls: string[] = [];
  const fake = {
    getManifest: () => ({ id: 'io.ex.a', activityMode: 'none', componentType: 'service' }),
    getInstancesByApp: () => [{ instanceId: 'io.ex.a-1', owner: 'default', inPool: false }],
    getActivitiesByInstance: () => [],
    stop: async () => { calls.push('stop'); },
    stopAll: async () => { calls.push('stopAll'); },
    start: async () => { calls.push('start'); return 'io.ex.a-2'; },
  };
  const g = globalThis as Record<string, unknown>;
  const prev = g['__aura_app_manager__'];
  g['__aura_app_manager__'] = fake;
  try {
    const r = await restartWithActivities('io.ex.a');
    assert.deepEqual(calls, ['stopAll', 'start']);
    assert.equal(r.others, undefined);
  } finally {
    g['__aura_app_manager__'] = prev;
  }
});
