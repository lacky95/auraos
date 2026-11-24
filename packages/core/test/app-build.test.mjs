// Apps from a production build, dev fallback (app-manager/appBuild.ts):
// the source fingerprint, the prod-capability rules and the serve decision.
//
//   pnpm --filter @aura/core test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appFingerprint, prodCapability, serveState, writeBuildStamp, serveLabel, sdkFingerprint, readBuildStamp,
  prepareBuildStaging, discardBuildStaging, installBuild, buildFailureReason, BUILD_STAGING_DIR,
} from '../dist/app-manager/appBuild.js';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function app(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aura-app-'));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
const manifest = (extra = {}) => ({ id: 'com.test.app', entrypoint: 'entrypoint.sh', runtime: 'astro', ...extra });
const PLAIN = "import node from '@astrojs/node';\nexport default { output: 'server', adapter: node({ mode: 'standalone' }) };\n";

test('the fingerprint covers sources only', () => {
  const dir = app({ 'astro.config.mjs': PLAIN, 'package.json': '{}', 'src/pages/index.astro': 'a' });
  const base = appFingerprint(dir);
  // Not sources: builds, deps, instance data, backups, logs.
  writeFileSync(join(dir, 'x.log'), 'log');
  mkdirSync(join(dir, 'dist', 'server'), { recursive: true }); writeFileSync(join(dir, 'dist', 'server', 'entry.mjs'), '');
  mkdirSync(join(dir, 'node_modules', 'p'), { recursive: true }); writeFileSync(join(dir, 'node_modules', 'p', 'i.js'), '');
  mkdirSync(join(dir, 'com.test.app-3'), { recursive: true }); writeFileSync(join(dir, 'com.test.app-3', 'db.sqlite'), 'data');
  writeFileSync(join(dir, 'src', 'pages', 'index.astro.bak-1'), 'old');
  assert.equal(appFingerprint(dir), base);
  // Sources: a change anywhere under src/ or a root config file.
  writeFileSync(join(dir, 'src', 'pages', 'index.astro'), 'b');
  assert.notEqual(appFingerprint(dir), base);
  const b = appFingerprint(dir);
  writeFileSync(join(dir, 'server.mjs'), '// prod server');
  assert.notEqual(appFingerprint(dir), b);
});

test('manifest build.ignore excludes paths', () => {
  const dir = app({ 'astro.config.mjs': PLAIN, 'public/engine.worker.js': '1' });
  const base = appFingerprint(dir, ['public/engine.worker.js']);
  writeFileSync(join(dir, 'public', 'engine.worker.js'), '2');
  assert.equal(appFingerprint(dir, ['public/engine.worker.js']), base);
  assert.notEqual(appFingerprint(dir), appFingerprint(dir, ['public/engine.worker.js']));
});

test('prod capability: plain apps yes; dev-server hooks only with serve: auto; serve: dev never', () => {
  assert.equal(prodCapability(app({ 'astro.config.mjs': PLAIN }), manifest()).capable, true);
  const hooks = app({ 'astro.config.mjs': PLAIN + "const i = { hooks: { 'astro:server:setup': () => {} } };\n" });
  assert.equal(prodCapability(hooks, manifest()).capable, false);
  assert.equal(prodCapability(hooks, manifest({ serve: 'auto' })).capable, true);
  const proxy = app({ 'astro.config.mjs': PLAIN + "const v = { server: { proxy: { '/x': 'http://y' } } };\n" });
  assert.equal(prodCapability(proxy, manifest()).capable, false);
  assert.equal(prodCapability(app({ 'astro.config.mjs': PLAIN }), manifest({ serve: 'dev' })).capable, false);
  const own = app({ 'astro.config.mjs': PLAIN, 'entrypoint.sh': '#!/bin/sh' });
  assert.equal(prodCapability(own, manifest()).reason, 'own-entrypoint');
  assert.equal(prodCapability(app({ 'astro.config.mjs': PLAIN }), manifest({ runtime: 'raw' })).reason, 'own-entrypoint');
});

test('serve state: no build → dev; matching build → prod; edit → dev again', () => {
  const dir = app({ 'astro.config.mjs': PLAIN, 'src/pages/index.astro': 'a' });
  assert.deepEqual(serveState(dir, manifest()), { mode: 'dev', reason: 'no-build' });
  mkdirSync(join(dir, 'dist', 'server'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'server', 'entry.mjs'), '');
  assert.equal(serveState(dir, manifest()).reason, 'changed');           // built, but no stamp
  writeBuildStamp(dir, appFingerprint(dir));
  assert.deepEqual(serveState(dir, manifest()), { mode: 'prod', reason: 'built' });
  writeFileSync(join(dir, 'src', 'pages', 'index.astro'), 'edited');
  assert.deepEqual(serveState(dir, manifest()), { mode: 'dev', reason: 'changed' });
  assert.equal(serveLabel({ mode: 'dev', reason: 'no-build' }), 'dev: no build');
  assert.equal(serveLabel({ mode: 'prod', reason: 'built' }), 'prod');
});

// ── SDK content in the fingerprint ───────────────────────────────────────────

function sdkPackage(root, name, files, pkg = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@aura/${name}`, version: '0.0.1', ...pkg }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

test('a change in a workspace SDK marks the app stale; types and source maps do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-ws-')); roots.push(root);
  const sdk = sdkPackage(root, 'app-sdk', { 'dist/index.js': 'export const a = 1;\n', 'dist/index.d.ts': 'x', 'dist/index.js.map': 'x' });
  const dir = app({ 'astro.config.mjs': PLAIN, 'package.json': JSON.stringify({ dependencies: { '@aura/app-sdk': 'workspace:*' } }), 'src/pages/index.astro': 'a' });
  mkdirSync(join(dir, 'node_modules', '@aura'), { recursive: true });
  symlinkSync(sdk, join(dir, 'node_modules', '@aura', 'app-sdk'));
  mkdirSync(join(dir, 'dist', 'server'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'server', 'entry.mjs'), '');
  writeBuildStamp(dir, appFingerprint(dir));
  assert.equal(serveState(dir, manifest({ entrypoint: 'none.sh' })).reason, 'built');

  writeFileSync(join(sdk, 'dist', 'index.d.ts'), 'changed');
  writeFileSync(join(sdk, 'dist', 'index.js.map'), 'changed');
  assert.equal(serveState(dir, manifest({ entrypoint: 'none.sh' })).reason, 'built');

  writeFileSync(join(sdk, 'dist', 'index.js'), 'export const a = 2;\n');
  assert.equal(serveState(dir, manifest({ entrypoint: 'none.sh' })).reason, 'changed');
});

test('the SDK fingerprint follows runtime imports, and ignores packages nothing imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-ws-')); roots.push(root);
  const core = sdkPackage(root, 'core', { 'dist/index.js': 'export const c = 1;\n' });
  const unused = sdkPackage(root, 'kv-store', { 'dist/index.js': 'export const k = 1;\n' });
  const sdk = sdkPackage(root, 'app-sdk', { 'dist/index.js': "import { c } from '@aura/core';\nexport { c };\n" }, { dependencies: { '@aura/core': 'workspace:*', '@aura/kv-store': 'workspace:*' } });
  mkdirSync(join(sdk, 'node_modules', '@aura'), { recursive: true });
  symlinkSync(core, join(sdk, 'node_modules', '@aura', 'core'));
  symlinkSync(unused, join(sdk, 'node_modules', '@aura', 'kv-store'));
  const dir = app({ 'package.json': JSON.stringify({ auraDependencies: { '@aura/app-sdk': '^0.0.1' } }) });
  mkdirSync(join(dir, 'node_modules', '@aura'), { recursive: true });
  symlinkSync(sdk, join(dir, 'node_modules', '@aura', 'app-sdk'));

  const base = sdkFingerprint(dir);
  writeFileSync(join(unused, 'dist', 'index.js'), 'export const k = 2;\n');
  assert.equal(sdkFingerprint(dir), base);
  writeFileSync(join(core, 'dist', 'index.js'), 'export const c = 2;\n');
  assert.notEqual(sdkFingerprint(dir), base);
});

test('an app without @aura packages keeps its fingerprint shape', () => {
  const dir = app({ 'package.json': '{"dependencies":{"left-pad":"1.0.0"}}', 'src/a.ts': 'a' });
  assert.equal(sdkFingerprint(dir), '');
});

// ── Installing a build under a running instance ──────────────────────────────

function builtApp(files) {
  const dir = app({ 'package.json': '{}' });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, 'dist', rel, '..'), { recursive: true });
    writeFileSync(join(dir, 'dist', rel), content);
  }
  return dir;
}
function stage(dir, files) {
  const next = prepareBuildStaging(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(next, rel, '..'), { recursive: true });
    writeFileSync(join(next, rel), content);
  }
}

test('a running server can still lazy-load its old chunks after a build is installed', async () => {
  const dir = builtApp({
    'server/entry.mjs': "export const load = () => import('./chunks/page_OLD.mjs');\n",
    'server/chunks/page_OLD.mjs': "export { v } from './dep_OLD.mjs';\n",
    'server/chunks/dep_OLD.mjs': "export const v = 'old';\n",
    'client/_astro/app.OLD.js': 'old',
  });
  writeBuildStamp(dir, 'old');
  // "Started" before the build: the entry is loaded, its chunks are not.
  const running = await import(pathToFileURL(join(dir, 'dist', 'server', 'entry.mjs')).href);

  stage(dir, {
    'server/entry.mjs': "export const load = () => import('./chunks/page_NEW.mjs');\n",
    'server/chunks/page_NEW.mjs': "export const v = 'new';\n",
    'client/_astro/app.NEW.js': 'new',
  });
  installBuild(dir, { prune: false });

  assert.equal((await running.load()).v, 'old');
  assert.ok(existsSync(join(dir, 'dist', 'client', '_astro', 'app.OLD.js')), 'pages already open keep their assets');
  assert.ok(existsSync(join(dir, 'dist', 'client', '_astro', 'app.NEW.js')));
  assert.ok(!existsSync(join(dir, 'dist', BUILD_STAGING_DIR)));
  const fresh = await import(`${pathToFileURL(join(dir, 'dist', 'server', 'entry.mjs')).href}?new`);
  assert.equal((await fresh.load()).v, 'new');
});

test('with nothing running, an install removes files of older builds', () => {
  const dir = builtApp({ 'server/entry.mjs': 'old', 'server/chunks/gone_OLD.mjs': 'old', 'client/only-old/a.js': 'old' });
  stage(dir, { 'server/entry.mjs': 'new', 'server/chunks/kept_NEW.mjs': 'new' });
  installBuild(dir, { prune: true });
  assert.ok(!existsSync(join(dir, 'dist', 'server', 'chunks', 'gone_OLD.mjs')));
  assert.ok(!existsSync(join(dir, 'dist', 'client')), 'emptied directories go too');
  assert.equal(readFileSync(join(dir, 'dist', 'server', 'entry.mjs'), 'utf-8'), 'new');
});

test('a build without a server entry is refused and leaves the running build alone', () => {
  const dir = builtApp({ 'server/entry.mjs': 'old' });
  writeBuildStamp(dir, 'stamp');
  stage(dir, { 'client/a.js': 'partial' });
  assert.throws(() => installBuild(dir, { prune: true }), /no server\/entry\.mjs/);
  assert.equal(readFileSync(join(dir, 'dist', 'server', 'entry.mjs'), 'utf-8'), 'old');
  assert.equal(readBuildStamp(dir), 'stamp');
  discardBuildStaging(dir);
  assert.ok(!existsSync(join(dir, 'dist', BUILD_STAGING_DIR)));
});

test('an install handles a path that changed between file and directory', () => {
  const dir = builtApp({ 'server/entry.mjs': 'old', 'client/thing': 'file', 'client/dir/a.js': 'old' });
  stage(dir, { 'server/entry.mjs': 'new', 'client/thing/b.js': 'now a dir', 'client/dir': 'now a file' });
  installBuild(dir, { prune: false });
  assert.equal(readFileSync(join(dir, 'dist', 'client', 'thing', 'b.js'), 'utf-8'), 'now a dir');
  assert.equal(readFileSync(join(dir, 'dist', 'client', 'dir'), 'utf-8'), 'now a file');
});

test('the logged failure reason names the error and carries no credentials', () => {
  assert.equal(buildFailureReason({ skipped: 'dependencies not installed yet — start the app once' }), 'dependencies not installed yet — start the app once');
  const reason = buildFailureReason({ output: [
    'building…',
    '\u001b[31mError: fetch https://bob:hunter2@example.test/x failed API_TOKEN=abc123 Authorization: Bearer zzz\u001b[0m',
    'done',
  ].join('\n') });
  assert.match(reason, /^Error: fetch/);
  for (const secret of ['hunter2', 'abc123', 'zzz']) assert.ok(!reason.includes(secret), secret);
});
