// Tests for the aura-base safety net (BaseImage). Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/base-image.test.mjs
//
// A fresh install whose shell comes up without the `aura-base` image must
// build it once, report progress from the legacy builder's `Step N/M` lines,
// let concurrent spawns share that one build, and after a failure refuse
// spawns until a retry succeeds. Docker is faked through `deps`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseImage, parseBuildStep } from '../dist/app-manager/BaseImage.js';

function setup({ present = false, results = [0] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'base-image-'));
  const dockerfile = join(dataDir, 'Dockerfile');
  writeFileSync(dockerfile, 'FROM node:22 AS aura-base\nRUN true\n');
  let exists = present;
  const calls = { builds: 0 };
  const deps = {
    exists: () => exists,
    build: async (_image, _df, onLine) => {
      calls.builds++;
      const code = results[Math.min(calls.builds - 1, results.length - 1)];
      onLine('Sending build context to Docker daemon  2.048kB');
      onLine('Step 1/2 : FROM node:22 AS aura-base');
      onLine('Step 2/2 : RUN true');
      if (code === 0) { onLine('Successfully tagged aura-base:latest'); exists = true; }
      else onLine('E: Unable to locate package nope');
      return code;
    },
  };
  const base = new BaseImage({ dataDir, dockerfile, image: 'aura-base-test', deps });
  const states = [];
  base.onChange((s) => states.push(s));
  return { base, calls, states, dataDir };
}

test('parseBuildStep reads legacy-builder step lines', () => {
  assert.deepEqual(parseBuildStep('Step 3/7 : RUN apt-get update'), { n: 3, of: 7, text: 'RUN apt-get update' });
  assert.equal(parseBuildStep(' ---> Running in be80da6dd657'), null);
  assert.equal(parseBuildStep('Step 9/7 : RUN nope'), null);
});

test('present image: ready at once, no build', async () => {
  const { base, calls } = setup({ present: true });
  await base.whenReady();
  assert.equal(calls.builds, 0);
  assert.equal(base.current.phase, 'ready');
});

test('missing image: one build shared by concurrent callers, with progress', async () => {
  const { base, calls, states, dataDir } = setup();
  await Promise.all([base.ensure(), base.whenReady(), base.whenReady()]);
  assert.equal(calls.builds, 1);
  assert.equal(base.current.phase, 'ready');
  assert.equal(base.current.built, true);
  const steps = states.filter((s) => s.phase === 'building' && s.step).map((s) => [s.progress, s.step]);
  assert.deepEqual(steps, [[0, 'Step 1 of 2: FROM node:22 AS aura-base'], [0.5, 'Step 2 of 2: RUN true']]);
  assert.match(base.readLog(), /Successfully tagged/);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'aura', 'first-boot', 'base-image.json'), 'utf-8')).phase, 'ready');
});

test('failed build: spawns are refused until a retry succeeds', async () => {
  const { base, calls } = setup({ results: [1, 0] });
  await assert.rejects(base.ensure(), /exited with 1: E: Unable to locate package nope/);
  assert.equal(base.current.phase, 'failed');
  // whenReady does not rebuild on its own after a failure.
  await assert.rejects(base.whenReady(), /missing and building it failed/);
  assert.equal(calls.builds, 1);
  // Retry (the notification button / POST /api/admin/first-boot).
  await base.ensure();
  assert.equal(calls.builds, 2);
  await base.whenReady();
  assert.equal(base.current.phase, 'ready');
});

// ── Phase 6 G: the image's Node against engines.node (the Astro 7 lesson) ────

function nodeSetup({ versions, engines = '>=22.23.4' }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'base-image-node-'));
  const dockerfile = join(dataDir, 'Dockerfile');
  writeFileSync(dockerfile, 'FROM node:22 AS aura-base\n');
  writeFileSync(join(dataDir, 'package.json'), JSON.stringify({ engines: { node: engines } }));
  const calls = { builds: 0, inspected: 0 };
  const deps = {
    exists: () => true,
    nodeVersion: () => versions[Math.min(calls.inspected++, versions.length - 1)],
    build: async () => { calls.builds++; return 0; },
  };
  return { base: new BaseImage({ dataDir, dockerfile, image: 'aura-base-test', deps }), calls };
}

test('node requirement: an image that satisfies engines.node is ready, with both versions recorded', async () => {
  const { base, calls } = nodeSetup({ versions: ['22.23.5'] });
  await base.whenReady();
  assert.equal(calls.builds, 0);
  assert.equal(base.current.phase, 'ready');
  assert.deepEqual(base.current.node, { version: '22.23.5', required: '>=22.23.4' });
});

test('node requirement: a stale image is rebuilt; ready once the rebuilt one satisfies it', async () => {
  const { base, calls } = nodeSetup({ versions: ['22.12.0', '22.23.5'] });
  await base.whenReady();
  assert.equal(calls.builds, 1);
  assert.equal(base.current.phase, 'ready');
});

test('node requirement: still stale after the build fails, naming the image and both versions', async () => {
  const { base, calls } = nodeSetup({ versions: ['22.12.0'] });
  await assert.rejects(base.whenReady(), /aura-base-test has Node 22\.12\.0, but this AuraOS requires >=22\.23\.4 \(engines\.node\)/);
  assert.equal(calls.builds, 1);
  assert.equal(base.current.phase, 'failed');
  await assert.rejects(base.whenReady(), /missing and building it failed/, 'not ready by the exists shortcut either');
});

test('node requirement: an unknown version or no engines.node is not checked', async () => {
  for (const s of [nodeSetup({ versions: [null] }), nodeSetup({ versions: ['18.0.0'], engines: '' })]) {
    await s.base.whenReady();
    assert.equal(s.calls.builds, 0);
  }
});

test('satisfiesNode: npm-style ranges; one table with the release builder\'s copy when it exists (phase 6 B)', async () => {
  const { satisfiesNode } = await import('../dist/app-manager/nodeRequirement.js');
  const table = [
    ['v22.23.5', '>=22.23.4', true], ['22.23.3', '>=22.23.4', false], ['22.23.4', '>=22.23.4', true],
    ['24.1.0', '^22', false], ['22.0.0', '^22', true], ['23.1.0', '>=20 <23 || 24.x', false], ['24.3.1', '>=20 <23 || 24.x', true],
    ['22.5.0', '~22.5', true], ['22.6.0', '~22.5', false], ['22.23.5', '', true], ['22.23.5', '22.x', true], ['bogus', '>=1', false],
  ];
  for (const [v, r, want] of table) assert.equal(satisfiesNode(v, r), want, `${v} ${r}`);
  const builder = new URL('../../../os/release/images.mjs', import.meta.url);
  const { existsSync } = await import('node:fs');
  if (!existsSync(builder)) return;
  const other = await import(builder.href);
  for (const [v, r] of table) assert.equal(other.satisfiesNode(v, r), satisfiesNode(v, r), `builder copy differs: ${v} ${r}`);
});
