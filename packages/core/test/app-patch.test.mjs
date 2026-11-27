// Track P, the system side of app patching: the effective source mode, the
// read-only rule for an agent workspace's own source, and installing a
// prepared tree through the Nexus install pipeline (atomic swap, rollback
// tree, data carry-over; a built-in app's activation is refused).
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Installer } from '../dist/nexus/Installer.js';
import { NexusManager } from '../dist/nexus/NexusManager.js';
import { effectiveSourceMode, listWorkspaces, workspaceSubpath, withoutCredentials } from '../dist/nexus/AppSource.js';
import { ContainerRunner, ownSourceReadOnly } from '../dist/app-manager/ContainerRunner.js';
import { appFingerprint, writeBuildStamp } from '../dist/app-manager/appBuild.js';

const O1 = '00000000-0000-4000-8000-000000000001';
const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const json = (p) => JSON.parse(readFileSync(p, 'utf-8'));

function world() {
  const root = mkdtempSync(join(tmpdir(), 'aura-patch-'));
  const scope = (id, priority, immutable) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority });
  const scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  const mgr = new NexusManager({ scopes, rootDataDir: join(root, 'root') });
  const tree = (dir, id, version, extra = {}) => {
    put(join(dir, 'app.manifest.json'), JSON.stringify({ id, originId: O1, name: 'Shop', version, ...extra.manifest }));
    put(join(dir, 'src', 'index.astro'), `v${version}\n`);
    for (const [p, text] of Object.entries(extra.files ?? {})) put(join(dir, p), text);
    return dir;
  };
  /** Run an install to its end; `approve` false stops at permission.needed. */
  const run = async (opts, approve = true) => {
    const bindings = [];
    const it = mgr.install({ approval: async (b) => { bindings.push(b); return approve; }, ...opts });
    for (let c = await it.next(); ; c = await it.next()) {
      if (c.done) return { record: c.value, bindings };
      if (c.value.type === 'permission.needed') { await it.return(null); return { needed: c.value, bindings }; }
    }
  };
  return { root, scopes, mgr, tree, run, sys: scopes[0], global: scopes[1], user: scopes[2] };
}

test('effective source mode: system closed, built here open, the owner\'s choice, else the release default', () => {
  const w = world();
  const m = (defaultMode) => ({ id: 'io.shop.app', ...(defaultMode ? { source: { defaultMode } } : {}) });
  assert.deepEqual(effectiveSourceMode(w.sys, m('open')), { mode: 'closed', defaultMode: 'open', from: 'system' });
  assert.deepEqual(effectiveSourceMode(w.global, m()), { mode: 'open', defaultMode: 'closed', from: 'local' }, 'no record: the author\'s own');
  put(join(w.global.dataDir, 'nexus', 'installed', 'io.shop.app.json'), JSON.stringify({ id: 'io.shop.app' }));
  assert.deepEqual(effectiveSourceMode(w.global, m()), { mode: 'closed', defaultMode: 'closed', from: 'default' });
  assert.deepEqual(effectiveSourceMode(w.global, m('open')), { mode: 'open', defaultMode: 'open', from: 'manifest' });
  mkdirSync(join(w.global.appsDir, 'io.shop.app', '.git'), { recursive: true });
  assert.deepEqual(effectiveSourceMode(w.global, m()), { mode: 'open', defaultMode: 'closed', from: 'checkout' }, 'an earlier dev checkout stays writable');
  put(join(w.global.dataDir, 'nexus', 'installed', 'io.shop.app.json'), JSON.stringify({ id: 'io.shop.app', sourceMode: 'closed' }));
  assert.deepEqual(effectiveSourceMode(w.global, m('open')), { mode: 'closed', defaultMode: 'open', from: 'record' });
});

test('workspace paths: validated segments, numbered dirs', () => {
  assert.equal(workspaceSubpath('default', 'inst-1', 3), 'aura/workspaces/default/inst-1/3');
  assert.throws(() => workspaceSubpath('..', 'inst-1', 1), /invalid workspace owner/);
  assert.throws(() => workspaceSubpath('default', 'a/b', 1), /invalid workspace owner/);
  assert.throws(() => workspaceSubpath('default', 'inst-1', 0), /invalid workspace number/);
  const root = mkdtempSync(join(tmpdir(), 'aura-ws-'));
  for (const n of ['2', '10', 'tmp', '1']) mkdirSync(join(root, 'aura', 'workspaces', 'default', 'inst-1', n), { recursive: true });
  assert.deepEqual(listWorkspaces(root, 'default', 'inst-1'), [1, 2, 10]);
  assert.deepEqual(listWorkspaces(root, 'default', 'nope'), []);
  assert.equal(withoutCredentials('https://user:tok@github.com/a/b.git'), 'https://github.com/a/b.git');
});

test('source.mode survives an update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-mode-'));
  const installer = new Installer({ appsDir: join(root, 'apps'), dataDir: join(root, 'data'), scope: 'global' });
  const stage = (v) => { const d = join(root, `s-${v}`); put(join(d, 'app.manifest.json'), '{}'); return d; };
  const manifest = (version) => ({ id: 'io.shop.app', name: 'Shop', version });
  const resolved = { source: 'oci', rawRef: 'reg/io.shop.app:1', digest: 'sha256:1' };
  await installer.install(stage('1'), manifest('1.0.0'), resolved);
  installer.setSourceMode('io.shop.app', 'open');
  const rec = await installer.install(stage('2'), manifest('2.0.0'), resolved);
  assert.equal(rec.sourceMode, 'open');
  assert.equal(installer.getRecord('io.shop.app').sourceMode, 'open');
  assert.equal(rec.version, '2.0.0');
});

test('activate a prepared tree: approval first, then the swap; rollback tree kept, data and provenance survive', async () => {
  const w = world();
  // The installed release, with instance data and the owner's choice of mode.
  await w.run({ ref: w.tree(join(w.root, 'release'), 'io.shop.app', '1.0.0'), scope: 'global' });
  const appDir = join(w.global.appsDir, 'io.shop.app');
  put(join(appDir, 'io.shop.app', 'orders.json'), '[42]');
  put(join(appDir, '.data', 'cache'), 'c');
  const before = json(join(w.global.dataDir, 'nexus', 'installed', 'io.shop.app.json'));

  // A workspace: a git work tree with the patched source.
  const ws = w.tree(join(w.root, 'root', 'aura', 'workspaces', 'default', 'inst-1', '1'), 'io.shop.app', '1.0.0',
    { files: { 'src/index.astro': 'patched\n', '.git/HEAD': 'ref: refs/heads/main\n' } });

  const denied = await w.run({ ref: ws, scope: 'global', action: 'app.patch.activate' }, false);
  assert.ok(denied.needed, 'no approval: permission.needed (the route answers 202)');
  assert.equal(denied.needed.binding.action, 'app.patch.activate');
  assert.match(denied.needed.binding.digest, /^tree:sha256:/, 'the approval binds the exact tree');
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), 'v1.0.0\n', 'nothing changed');

  const { record, bindings } = await w.run({ ref: ws, scope: 'global', action: 'app.patch.activate' });
  assert.equal(bindings[0].digest, denied.needed.binding.digest, 'the same tree, the same binding');
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), 'patched\n', 'swapped');
  assert.equal(existsSync(join(appDir, '.git')), false, 'the workspace history is not installed');
  assert.equal(readFileSync(join(appDir, 'io.shop.app', 'orders.json'), 'utf-8'), '[42]', 'instance data survives');
  assert.equal(readFileSync(join(appDir, '.data', 'cache'), 'utf-8'), 'c');
  assert.deepEqual([record.source, record.ref, record.installedAt], [before.source, before.ref, before.installedAt], 'still the release it came from');
  assert.notEqual(record.updatedAt, before.updatedAt);

  const trees = w.mgr.rollbackTrees('io.shop.app', 'global', record);
  assert.ok(trees.previous, 'the previous tree is kept');
  assert.equal(readFileSync(join(trees.previous, 'src', 'index.astro'), 'utf-8'), 'v1.0.0\n');
  assert.equal(trees.newest, trees.previous);
  assert.equal(existsSync(join(trees.previous, 'io.shop.app')), false, 'data moved, not left in the rollback tree');

  // Rolling back is the same install, from the rollback tree.
  await w.run({ ref: trees.previous, scope: 'global', action: 'app.patch.activate' });
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), 'v1.0.0\n');
  assert.equal(readFileSync(join(appDir, 'io.shop.app', 'orders.json'), 'utf-8'), '[42]');
});

test('built-in: a built-in app is not patched — its activation is refused, nothing installed, the system copy untouched', async () => {
  const w = world();
  const sysDir = w.tree(join(w.sys.appsDir, 'com.aura.terminal'), 'com.aura.terminal', '1.0.0');
  const ws = w.tree(join(w.root, 'ws'), 'com.aura.terminal', '1.0.0', { files: { 'src/index.astro': 'status line\n' } });
  const bindings = [];
  const it = w.mgr.install({ ref: ws, scope: 'user', action: 'app.patch.activate', approval: async (b) => { bindings.push(b); return true; } });
  let error = null;
  try { for (let c = await it.next(); !c.done; c = await it.next()) { /* to the end */ } }
  catch (err) { error = err.message; }
  assert.equal(error, 'system-app-later: Built-in apps are patched by system patches (Phase 7) or in Developer Mode');
  assert.deepEqual(bindings, [], 'the owner is never asked');
  assert.equal(existsSync(join(w.user.appsDir, 'com.aura.terminal')), false);
  assert.equal(readFileSync(join(sysDir, 'src', 'index.astro'), 'utf-8'), 'v1.0.0\n');
});

test('own source read-only: a closed agent workspace (every tool) that serves its build', () => {
  const PLAIN = "import node from '@astrojs/node';\nexport default { output: 'server', adapter: node({ mode: 'standalone' }) };\n";
  const dir = mkdtempSync(join(tmpdir(), 'aura-term-'));
  put(join(dir, 'astro.config.mjs'), PLAIN);
  put(join(dir, 'src', 'pages', 'index.astro'), 'a');
  const terminal = { id: 'com.aura.terminal', entrypoint: 'entrypoint.sh', runtime: 'astro', tools: ['*', 'git'] };
  assert.equal(ownSourceReadOnly({ appDir: dir, sourceMode: 'closed' }, terminal), false, 'dev mode (no build) must write .astro');
  put(join(dir, 'dist', 'server', 'entry.mjs'), '');
  writeBuildStamp(dir, appFingerprint(dir));
  assert.equal(ownSourceReadOnly({ appDir: dir, sourceMode: 'closed' }, terminal), true, 'the Terminal\'s own source is read-only');
  assert.equal(ownSourceReadOnly({ appDir: dir, sourceMode: 'open' }, terminal), false);
  assert.equal(ownSourceReadOnly({ appDir: dir, sourceMode: 'closed' }, { ...terminal, tools: ['git'] }), false, 'other apps write their own dir');

  const mount = ContainerRunner.prototype.buildAppDirMount;
  const self = { systemTree: { kind: 'checkout', hostRoot: '/workspace', nodeModulesVolume: 'nm' }, dataDir: '/data' };
  assert.deepEqual(mount.call(self, '/workspace/apps/com.aura.terminal', 'com.aura.terminal', 'vol', undefined, true),
    ['-v', '/workspace/apps/com.aura.terminal:/workspace/apps/com.aura.terminal:ro']);
  assert.deepEqual(mount.call(self, '/data/scopes/users/default/apps/io.x', 'io.x', 'vol', undefined, true),
    ['--mount', 'type=volume,source=vol,target=/workspace/apps/io.x,volume-subpath=scopes/users/default/apps/io.x,readonly']);
  assert.deepEqual(mount.call(self, '/data/scopes/users/default/apps/io.x', 'io.x', 'vol'),
    ['--mount', 'type=volume,source=vol,target=/workspace/apps/io.x,volume-subpath=scopes/users/default/apps/io.x']);
});
