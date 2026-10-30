// Apps from a production build, dev fallback (app-manager/appBuild.ts):
// the source fingerprint, the prod-capability rules and the serve decision.
//
//   pnpm --filter @aura/core test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appFingerprint, prodCapability, serveState, writeBuildStamp, serveLabel } from '../dist/app-manager/appBuild.js';

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
