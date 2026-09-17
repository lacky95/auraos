// Tests for the container encoding of the OS sidecar concept. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/sidecars.test.mjs
//
// Background: a docker daemon restart removed the `--rm` app containers but
// revived their `unless-stopped` sidecars, and nothing reaped them (a Steel
// browser kept 660 MB for a day with no parent instance). The reconciler now
// lists labelled sidecars and removes those whose parent is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSidecarPs, selectOrphanSidecars, parseUsageStats, parseByteSize,
} from '../dist/app-manager/sidecars.js';

const row = (...cols) => cols.join('\t');

test('parses labelled containers and skips mount helpers', () => {
  const out = [
    row('074660c7104d', 'aura-io.lakner.teams--steel', 'steel:latest', 'running', '2026-09-17 12:22:40 +0000 UTC',
      'io.lakner.teams', 'io.lakner.teams', 'steel', ''),
    row('aaaaaaaaaaaa', 'aura-mount-x', 'aura-base', 'running', '', 'com.aura.terminal-1', '', '', '1'),
    row('bbbbbbbbbbbb', 'aura-whisper-asr', 'whisper:cpu', 'exited', '', 'com.aura.whisper', 'com.aura.whisper', 'asr', ''),
    '',
  ].join('\n');
  const list = parseSidecarPs(out);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    id: 'aura-io.lakner.teams--steel', service: 'steel', parentInstanceId: 'io.lakner.teams',
    appId: 'io.lakner.teams', backend: 'container', state: 'running',
    image: 'steel:latest', createdAt: '2026-09-17 12:22:40 +0000 UTC',
  });
  assert.equal(list[1].state, 'stopped');
});

const sidecar = (id, parent) => ({ id, service: id, parentInstanceId: parent, appId: parent, backend: 'container', state: 'running' });

test('reaps a sidecar whose parent is gone, keeps live ones', () => {
  const absence = new Map();
  const orphans = selectOrphanSidecars(
    [sidecar('a', 'live'), sidecar('b', 'gone')], new Set(['live']), absence, 1,
  );
  assert.deepEqual(orphans.map((o) => o.id), ['b']);
});

test('grace period requires consecutive misses and resets when parent returns', () => {
  const absence = new Map();
  const list = [sidecar('b', 'p')];
  assert.equal(selectOrphanSidecars(list, new Set(), absence, 2).length, 0);
  assert.equal(selectOrphanSidecars(list, new Set(['p']), absence, 2).length, 0); // parent back → reset
  assert.equal(selectOrphanSidecars(list, new Set(), absence, 2).length, 0);
  assert.equal(selectOrphanSidecars(list, new Set(), absence, 2).length, 1);
});

test('forgets counters for sidecars that disappeared', () => {
  const absence = new Map();
  selectOrphanSidecars([sidecar('b', 'p')], new Set(), absence, 3);
  selectOrphanSidecars([], new Set(), absence, 3);
  assert.equal(absence.size, 0);
});

test('parses docker stats output', () => {
  const usage = parseUsageStats([
    row('aura-io.lakner.trilium--trilium', '172.2MiB / 15.88GiB', '0.05%'),
    row('aura-x', '1.2GiB / 15.88GiB', '--'),
  ].join('\n'));
  assert.equal(usage.get('aura-io.lakner.trilium--trilium').memBytes, Math.round(172.2 * 1024 ** 2));
  assert.equal(usage.get('aura-io.lakner.trilium--trilium').cpuPct, 0.05);
  assert.equal(usage.get('aura-x').cpuPct, null);
  assert.equal(parseByteSize('512kB'), 512_000);
  assert.equal(parseByteSize('n/a'), null);
});
