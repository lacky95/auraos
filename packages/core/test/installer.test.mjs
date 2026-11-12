// Nexus installer: an update replaces an app's code, never its data. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/installer.test.mjs
//
// In the global and user scopes an app's dir is also its data dir (instance
// dirs `<appId>/`, `<appId>-<n>/`, `.sidecars/`, `.data/`), and an update
// swaps the whole dir. The data must move into the new copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Installer, runtimeDataEntries } from '../dist/nexus/Installer.js';

const ID = 'io.test.app';
const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const manifest = (version) => ({ id: ID, name: 'App', version });
const resolved = { source: 'local', rawRef: '/src', digest: '' };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aura-inst-'));
  const appsDir = join(root, 'apps');
  const dataDir = join(root, 'data');
  const installer = new Installer({ appsDir, dataDir, scope: 'user' });
  const stage = (version, extra = {}) => {
    const dir = mkdtempSync(join(root, 'stage-'));
    put(join(dir, 'app.manifest.json'), JSON.stringify(manifest(version)));
    put(join(dir, 'index.js'), `v${version}\n`);
    for (const [p, text] of Object.entries(extra)) put(join(dir, p), text);
    return dir;
  };
  return { root, appsDir, dataDir, installer, stage, appDir: join(appsDir, ID) };
}

test('runtimeDataEntries: instance dirs, .sidecars and .data — nothing else', () => {
  const { appDir } = setup();
  for (const d of [ID, `${ID}-2`, `${ID}-13`, '.sidecars', '.data', 'src', `${ID}x`, `${ID}-beta`, 'io.test.appx']) mkdirSync(join(appDir, d), { recursive: true });
  assert.deepEqual(runtimeDataEntries(appDir, ID).sort(), ['.data', '.sidecars', ID, `${ID}-13`, `${ID}-2`].sort());
});

test('an update keeps instance data, sidecar volumes and .data, in the same directories', async () => {
  const w = setup();
  await w.installer.install(w.stage('1.0.0'), manifest('1.0.0'), resolved);
  put(join(w.appDir, ID, 'settings.json'), '{"theme":"dark"}');
  put(join(w.appDir, `${ID}-2`, 'windows.json'), '[1]');
  put(join(w.appDir, '.sidecars', 'db', 'data', 'pg'), 'rows');
  put(join(w.appDir, '.data', 'cache'), 'c');
  const inode = statSync(join(w.appDir, ID)).ino;

  await w.installer.install(w.stage('1.1.0'), manifest('1.1.0'), resolved);

  assert.equal(readFileSync(join(w.appDir, 'index.js'), 'utf-8'), 'v1.1.0\n', 'the code is the new release');
  assert.equal(readFileSync(join(w.appDir, ID, 'settings.json'), 'utf-8'), '{"theme":"dark"}');
  assert.equal(readFileSync(join(w.appDir, `${ID}-2`, 'windows.json'), 'utf-8'), '[1]');
  assert.equal(readFileSync(join(w.appDir, '.sidecars', 'db', 'data', 'pg'), 'utf-8'), 'rows');
  assert.equal(readFileSync(join(w.appDir, '.data', 'cache'), 'utf-8'), 'c');
  assert.equal(statSync(join(w.appDir, ID)).ino, inode, 'moved, not copied: a running instance keeps its directory');

  // The old code still goes to the trash (undo window), without the data.
  const trash = join(w.dataDir, 'nexus', 'trash');
  const [old] = readdirSync(trash);
  assert.equal(readFileSync(join(trash, old, 'index.js'), 'utf-8'), 'v1.0.0\n');
  assert.equal(existsSync(join(trash, old, ID)), false);
});

test("the user's data wins over a bundle that ships a dir under the same name", async () => {
  const w = setup();
  await w.installer.install(w.stage('1.0.0'), manifest('1.0.0'), resolved);
  put(join(w.appDir, ID, 'settings.json'), 'mine');
  await w.installer.install(w.stage('1.1.0', { [`${ID}/settings.json`]: 'shipped', [`${ID}/other`]: 'x' }), manifest('1.1.0'), resolved);
  assert.equal(readFileSync(join(w.appDir, ID, 'settings.json'), 'utf-8'), 'mine');
  assert.equal(existsSync(join(w.appDir, ID, 'other')), false);
});

test('a fresh install has nothing to carry over', async () => {
  const w = setup();
  await w.installer.install(w.stage('1.0.0'), manifest('1.0.0'), resolved);
  assert.deepEqual(readdirSync(w.appDir).sort(), ['app.manifest.json', 'index.js']);
});
