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
