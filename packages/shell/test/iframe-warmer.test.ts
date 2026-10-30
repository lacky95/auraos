// Lazy activity loading: who may load when (lib/iframeWarmer.ts).
//
//   cd packages/shell && npx tsx --test test/iframe-warmer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIframeWarmer, parsePolicy, warmOrder, rememberRecentWorkspace, recentWorkspaces,
  type WarmerDeps,
} from '../src/lib/iframeWarmer.ts';

/** Deterministic deps: idle + delay are queued and run by `flush()`. */
function harness(over: Partial<WarmerDeps> = {}) {
  const loaded: Array<[string, string]> = [];
  const marks: string[] = [];
  const tasks: Array<() => void> = [];
  let hidden = false;
  const visibleWaiters: Array<() => void> = [];
  const deps: WarmerDeps = {
    load: (id, reason) => { loaded.push([id, reason]); return true; },
    idle: (fn) => { tasks.push(fn); },
    delay: (fn) => { tasks.push(fn); },
    isHidden: () => hidden,
    onVisible: (fn) => { visibleWaiters.push(fn); },
    mark: (name) => { marks.push(name); },
    batchSize: 2,
    ...over,
  };
  const flush = (max = 100) => { let n = 0; while (tasks.length && n++ < max) tasks.shift()!(); };
  return {
    warmer: createIframeWarmer(deps), loaded, marks, flush,
    setHidden(h: boolean) { hidden = h; if (!h) visibleWaiters.splice(0).forEach((f) => f()); },
  };
}

test('parsePolicy accepts the three policies and maps off → eager', () => {
  assert.equal(parsePolicy('warm-idle'), 'warm-idle');
  assert.equal(parsePolicy('on-demand'), 'on-demand');
  assert.equal(parsePolicy('eager'), 'eager');
  assert.equal(parsePolicy('off'), 'eager');
  assert.equal(parsePolicy('bogus'), null);
  assert.equal(parsePolicy(null), null);
});

test('cold views are not warm until allowed', () => {
  const { warmer } = harness();
  assert.equal(warmer.isWarm('a'), false);
  assert.deepEqual(warmer.allow(['a', 'b']), ['a', 'b']);
  assert.equal(warmer.isWarm('a'), true);
  // Allowing again reports nothing new.
  assert.deepEqual(warmer.allow(['a', 'c']), ['c']);
});

test('warm-idle loads in batches during idle time and ends with warm:end', () => {
  const h = harness();
  h.warmer.allow(['active1']);
  h.warmer.start(['active1', 'x1', 'x2', 'x3', 'x4', 'x5']);
  assert.equal(h.loaded.length, 0, 'nothing loads before idle');
  h.flush();
  assert.deepEqual(h.loaded.map(([id]) => id), ['x1', 'x2', 'x3', 'x4', 'x5']);
  assert.ok(h.loaded.every(([, r]) => r === 'warm'));
  assert.equal(h.marks.filter((m) => m === 'warm:batch').length, 3);
  assert.equal(h.marks.at(-1), 'warm:end');
  assert.deepEqual(h.warmer.pending(), []);
});

test('a switch onto a cold workspace jumps the queue (allow) and is not loaded twice', () => {
  const h = harness({ batchSize: 1 });
  h.warmer.start(['x1', 'x2', 'x3']);
  const cold = h.warmer.allow(['x3']);         // user switched to x3's workspace
  assert.deepEqual(cold, ['x3']);
  h.flush();
  // x3 is loaded by the caller's render (allow), the warmer skips it.
  assert.deepEqual(h.loaded.map(([id]) => id), ['x1', 'x2']);
});

test('on-demand never warms in the background', () => {
  const h = harness();
  h.warmer.setPolicy('on-demand');
  h.warmer.start(['x1', 'x2']);
  h.flush();
  assert.deepEqual(h.loaded, []);
  assert.equal(h.warmer.isWarm('x1'), false);
});

test('eager loads everything queued at once and treats every view as warm', () => {
  const h = harness();
  h.warmer.setPolicy('eager');
  assert.equal(h.warmer.isWarm('anything'), true);
  h.warmer.start(['x1', 'x2']);
  assert.deepEqual(h.loaded, [['x1', 'eager'], ['x2', 'eager']]);
});

test('switching on-demand → warm-idle after start resumes warming', () => {
  const h = harness();
  h.warmer.setPolicy('on-demand');
  h.warmer.start(['x1', 'x2']);
  h.flush();
  assert.equal(h.loaded.length, 0);
  h.warmer.setPolicy('warm-idle');
  h.flush();
  assert.deepEqual(h.loaded.map(([id]) => id), ['x1', 'x2']);
});

test('warming pauses while the page is hidden and resumes when visible', () => {
  const h = harness();
  h.setHidden(true);
  h.warmer.start(['x1', 'x2', 'x3']);
  h.flush();
  assert.equal(h.loaded.length, 0);
  h.setHidden(false);
  h.flush();
  assert.deepEqual(h.loaded.map(([id]) => id), ['x1', 'x2', 'x3']);
});

test('forget drops a closed view from the queue', () => {
  const h = harness();
  h.warmer.start(['x1', 'x2']);
  h.warmer.forget('x1');
  h.flush();
  assert.deepEqual(h.loaded.map(([id]) => id), ['x2']);
});

test('warmOrder: parked first, then recent workspaces, then by distance (right before left)', () => {
  const workspaces = [
    { id: 'w1', members: ['a'] },
    { id: 'w2', members: ['b'] },
    { id: 'w3', members: ['c1', 'c2'] }, // active
    { id: 'w4', members: ['d'] },
    { id: 'w5', members: ['e'] },
  ];
  assert.deepEqual(
    warmOrder({ workspaces, activeWorkspaceId: 'w3', parked: ['p'] }),
    ['p', 'd', 'b', 'e', 'a'],
  );
  assert.deepEqual(
    warmOrder({ workspaces, activeWorkspaceId: 'w3', recent: ['w3', 'w1', 'gone'] }),
    ['a', 'd', 'b', 'e'],
  );
});

test('recent workspaces: most recent first, deduped, capped', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  rememberRecentWorkspace('w1', storage);
  rememberRecentWorkspace('w2', storage);
  rememberRecentWorkspace('w1', storage);
  assert.deepEqual(recentWorkspaces(storage), ['w1', 'w2']);
  for (let i = 0; i < 20; i++) rememberRecentWorkspace(`x${i}`, storage);
  assert.equal(recentWorkspaces(storage).length, 12);
});
