// What an app container and an app build see of /workspace (ContainerRunner.workspaceMounts): the
// packages plus WORKSPACE_ROOT_FILES, read-only. Everything the apps and packages resolve at build time
// must be inside that slice: Vite 8 (Astro 7) reads the tsconfig of every file it transforms and fails
// on a missing `extends` — on 2026-11-26 every system app failed its build in the container over
// /workspace/tsconfig.base.json, while `astro build` in a full checkout passed.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKSPACE_ROOT_FILES } from '../dist/app-manager/ContainerRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Mounted in the container: packages/**, the root files, and the app's own dir. */
function mounted(file, appDir) {
  const rel = relative(ROOT, file);
  return rel.startsWith('packages/') || WORKSPACE_ROOT_FILES.includes(rel) || (appDir !== null && !relative(appDir, file).startsWith('..'));
}

/** The relative `extends` chain of a tsconfig (package-name extends resolve from node_modules: mounted). */
function extendsChain(tsconfig) {
  const out = [];
  for (let f = tsconfig, i = 0; f && i < 10; i++) {
    const ext = JSON.parse(readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')).extends;
    const next = typeof ext === 'string' && ext.startsWith('.') ? resolve(dirname(f), ext) : null;
    if (next) out.push(next);
    f = next && existsSync(next) ? next : null;
  }
  return out;
}

test('every tsconfig extends chain of the packages and system apps stays inside the container mounts', () => {
  const dirs = [
    ...readdirSync(join(ROOT, 'packages')).map((d) => ({ dir: join(ROOT, 'packages', d), app: null })),
    ...readdirSync(join(ROOT, 'apps')).map((d) => ({ dir: join(ROOT, 'apps', d), app: join(ROOT, 'apps', d) })),
  ];
  const outside = [];
  for (const { dir, app } of dirs) {
    const ts = join(dir, 'tsconfig.json');
    if (!existsSync(ts)) continue;
    for (const f of extendsChain(ts)) if (!mounted(f, app)) outside.push(`${relative(ROOT, ts)} → ${relative(ROOT, f)}`);
  }
  assert.deepEqual(outside, []);
});

test('the workspace root files a container mounts exist', () => {
  for (const f of WORKSPACE_ROOT_FILES) assert.ok(existsSync(join(ROOT, f)), f);
});
