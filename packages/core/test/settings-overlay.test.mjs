// Phase 6 O: the settings overlay (manifestOverlay.ts), the effective capability registry
// (registryOverlay.ts) and the one-shot migration of local edits (release/overlayMigration.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The composition root (Phase 6 K) wires the service accessors when the barrel loads.
import '../dist/index.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  applyManifestOverlay, editManifestOverlay, mergeManifestOverlays, overlayFromDiff, parseManifestOverlay,
  readManifestOverlay, writeManifestOverlay,
} from '../dist/app-manager/manifestOverlay.js';
import { capabilityRegistryMount, writeCapabilityRegistryOverlay } from '../dist/capabilities/registryOverlay.js';
import { applyOverlayMigration, overlayMigrationReport } from '../dist/release/overlayMigration.js';
import { layout } from '../dist/release/paths.js';

const base = (over = {}) => ({ id: 'com.example.notes', name: 'Notes', version: '1.0.0', ...over });

test('merge: remove then add, in order, no duplicates; a list the base lacks appears only with an op', () => {
  const m = base({ tools: ['git', 'node'], permissions: ['apps.read'], services: [{ name: 'db', image: 'x' }, { name: 'w', tools: ['git'] }] });
  const o = { v: 1, tools: { add: ['rg', 'git'], remove: ['node'] }, permissions: { add: ['apps.mount'], remove: [] }, services: { db: { tools: { add: ['psql'], remove: [] } }, w: { tools: { add: [], remove: ['git'] } }, gone: { tools: { add: ['x'], remove: [] } } } };
  const e = applyManifestOverlay(m, parseManifestOverlay(o));
  assert.deepEqual(e.tools, ['git', 'rg']);
  assert.deepEqual(e.permissions, ['apps.read', 'apps.mount']);
  assert.deepEqual(e.services, [{ name: 'db', image: 'x', tools: ['psql'] }, { name: 'w', tools: [] }], 'a template the base no longer has is ignored');
  assert.deepEqual(m.tools, ['git', 'node'], 'the input is not changed');
  assert.equal('tools' in applyManifestOverlay(base(), { v: 1, permissions: { add: ['x'], remove: [] } }), false);
  assert.equal(applyManifestOverlay(m, null), m);
});

test('parse: strict shape; an item both added and removed is refused', () => {
  for (const bad of [null, [], { v: 2 }, { v: 1, files: {} }, { v: 1, tools: { add: 'git' } }, { v: 1, tools: { add: ['a'], remove: ['a'] } },
    { v: 1, tools: { add: [''] } }, { v: 1, services: { s: { image: 'x' } } }, { v: 1, tools: { add: [], drop: [] } }]) {
    assert.throws(() => parseManifestOverlay(bad), /overlay|must|unknown|both/, JSON.stringify(bad));
  }
});

test('edit: ops relative to the base; no-ops change nothing; add after remove cancels', () => {
  const m = base({ tools: ['git'], permissions: ['apps.read'] });
  let r = editManifestOverlay(null, m, { action: 'add-tool', tool: 'git' });
  assert.equal(r.changed, false);
  r = editManifestOverlay(null, m, { action: 'add-tool', tool: 'rg' });
  assert.deepEqual([r.changed, r.overlay], [true, { v: 1, tools: { add: ['rg'], remove: [] } }]);
  r = editManifestOverlay(r.overlay, m, { action: 'remove-tool', tool: 'git' });
  assert.deepEqual(r.overlay.tools, { add: ['rg'], remove: ['git'] });
  r = editManifestOverlay(r.overlay, m, { action: 'add-tool', tool: 'git' });
  assert.deepEqual(r.overlay.tools, { add: ['rg'], remove: [] });
  r = editManifestOverlay(r.overlay, m, { action: 'remove-tool', tool: 'rg' });
  assert.deepEqual(r.overlay, { v: 1 }, 'back to the base: an empty overlay');
  // set-tools is order-insensitive
  r = editManifestOverlay(null, base({ tools: ['a', 'b'] }), { action: 'set-tools', tools: ['b', 'a'] });
  assert.equal(r.changed, false);
  r = editManifestOverlay(null, base({ tools: ['a', 'b'] }), { action: 'set-tools', tools: ['b', 'c', '*'] });
  assert.deepEqual(applyManifestOverlay(base({ tools: ['a', 'b'] }), r.overlay).tools.sort(), ['*', 'b', 'c']);
  // permissions
  r = editManifestOverlay(null, m, { action: 'remove-permission', permission: 'apps.read' });
  assert.deepEqual(r.overlay.permissions, { add: [], remove: ['apps.read'] });
  assert.deepEqual(applyManifestOverlay(m, r.overlay).permissions, []);
});

test('edit: service tools; a template without tools gains its own list and keeps it after a removal', () => {
  const m = base({ services: [{ name: 'db', image: 'x' }] });
  let r = editManifestOverlay(null, m, { action: 'add-service-tool', service: 'db', tool: 'psql' });
  assert.deepEqual(applyManifestOverlay(m, r.overlay).services[0].tools, ['psql']);
  r = editManifestOverlay(r.overlay, m, { action: 'remove-service-tool', service: 'db', tool: 'psql' });
  assert.equal(r.changed, true);
  assert.deepEqual(applyManifestOverlay(m, r.overlay).services[0].tools, [], 'tools: [] keeps the own dir');
  assert.throws(() => editManifestOverlay(null, m, { action: 'add-service-tool', service: 'nope', tool: 'x' }), /no services/);
});

test('a changed base still merges predictably (a release adds, drops, or takes over an op)', () => {
  const o = parseManifestOverlay({ v: 1, tools: { add: ['rg'], remove: ['node'] } });
  // The release now ships rg itself and dropped node: both ops are no-ops, nothing doubles.
  assert.deepEqual(applyManifestOverlay(base({ tools: ['git', 'rg'] }), o).tools, ['git', 'rg']);
  // The release adds a new tool: it appears; the owner's revoke of node still holds.
  assert.deepEqual(applyManifestOverlay(base({ tools: ['git', 'node', 'jq'] }), o).tools, ['git', 'jq', 'rg']);
});

test('files: written atomically, deleted when empty, invalid ones throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-overlay-'));
  writeManifestOverlay(dir, 'com.example.notes', { v: 1, tools: { add: ['rg'], remove: [] } });
  assert.deepEqual(readManifestOverlay(dir, 'com.example.notes'), { v: 1, tools: { add: ['rg'], remove: [] } });
  writeManifestOverlay(dir, 'com.example.notes', { v: 1, tools: { add: [], remove: [] } });
  assert.equal(existsSync(join(dir, 'com.example.notes.json')), false);
  assert.equal(readManifestOverlay(dir, 'com.example.notes'), null);
  writeFileSync(join(dir, 'com.example.bad.json'), '{"v":1,"tools":');
  assert.throws(() => readManifestOverlay(dir, 'com.example.bad'), /com\.example\.bad\.json/);
  assert.throws(() => readManifestOverlay(dir, '../x'), /bad app id/);
  assert.deepEqual(mergeManifestOverlays({ v: 1, tools: { add: ['a'], remove: ['b'] } }, { v: 1, tools: { add: ['b'], remove: [] } }), { v: 1, tools: { add: ['a', 'b'], remove: [] } });
});

test('AppRegistry applies the overlay for every scope; an invalid overlay refuses the app', async () => {
  const { AppRegistry } = await import('../dist/app-manager/AppRegistry.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-overlay-reg-'));
  const scope = (id, priority) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable: id === 'system', priority });
  const scopes = [scope('system', 0), scope('user', 2)];
  const put = (s, id, m) => { mkdirSync(join(s.appsDir, id), { recursive: true }); writeFileSync(join(s.appsDir, id, 'app.manifest.json'), JSON.stringify(base({ id, ...m }))); };
  put(scopes[0], 'com.aura.sys', { tools: ['git'], permissions: ['apps.read'] });
  put(scopes[1], 'io.user.app', { tools: [] });
  put(scopes[1], 'io.user.bad', { tools: ['git'] });
  const overlayApps = layout(join(root, 'data')).overlayApps;
  writeManifestOverlay(overlayApps, 'com.aura.sys', { v: 1, tools: { add: ['rg'], remove: [] }, permissions: { add: ['apps.mount'], remove: ['apps.read'] } });
  writeManifestOverlay(overlayApps, 'io.user.app', { v: 1, tools: { add: ['node'], remove: [] } });
  mkdirSync(overlayApps, { recursive: true });
  writeFileSync(join(overlayApps, 'io.user.bad.json'), JSON.stringify({ v: 1, tools: { add: ['x'], remove: ['x'] } }));
  const reg = new AppRegistry(scopes, { overlayAppsDir: overlayApps });
  const errors = [];
  const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  try { for (const s of scopes) await reg['scanScope'](s); } finally { console.error = orig; }
  assert.deepEqual(reg.getById('com.aura.sys').tools, ['git', 'rg']);
  assert.deepEqual(reg.getById('com.aura.sys').permissions, ['apps.mount']);
  assert.deepEqual(reg.getById('io.user.app').tools, ['node']);
  assert.equal(reg.has('io.user.bad'), false, 'refused, not loaded without the revoke');
  assert.ok(errors.some((e) => e.includes('io.user.bad')));
  // reloadFromDisk (manifest-edit's reload) sees a new overlay; the installed tree is untouched.
  writeManifestOverlay(overlayApps, 'com.aura.sys', { v: 1 });
  reg.reloadFromDisk('com.aura.sys');
  assert.deepEqual(reg.getById('com.aura.sys').tools, ['git']);
  assert.deepEqual(JSON.parse(readFileSync(join(scopes[0].appsDir, 'com.aura.sys', 'app.manifest.json'), 'utf8')).tools, ['git']);
});

test('capability registry overlay: release entries win, owner entries added, rewritten in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-capov-'));
  const m = capabilityRegistryMount(root);
  assert.deepEqual([m.subpath, m.target], ['aura/overlay/capabilities.yaml', '/workspace/.aura/capabilities.yaml']);
  const release = { capabilities: { git: { source: 'apt', package: 'git', description: 'Git' } }, services: { sshd: { source: 'apt', package: 'openssh-server' } } };
  assert.equal(writeCapabilityRegistryOverlay(root, release, { git: { source: 'apt', package: 'evil' }, sl: { source: 'apt', package: 'sl' } }), true);
  const doc = parseYaml(readFileSync(m.path, 'utf8'));
  assert.deepEqual(doc.capabilities.git, release.capabilities.git, 'an owner entry never shadows a release entry');
  assert.deepEqual(doc.capabilities.sl, { source: 'apt', package: 'sl' });
  assert.deepEqual(doc.services, release.services);
  const ino = statSync(m.path).ino;
  assert.equal(writeCapabilityRegistryOverlay(root, release, { sl: { source: 'apt', package: 'sl' } }), false, 'unchanged: not rewritten');
  assert.equal(writeCapabilityRegistryOverlay(root, release, {}), true);
  assert.equal(statSync(m.path).ino, ino, 'same inode: a single-file bind follows');
  assert.equal(parseYaml(readFileSync(m.path, 'utf8')).capabilities.sl, undefined);
});

// ── the one-shot migration ──────────────────────────────────────────────────

const GIT = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'aura-ovmig-'));
  const repo = join(root, 'ws');
  const write = (rel, text) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };
  const j = (o) => `${JSON.stringify(o, null, 2)}\n`;
  write('apps/com.aura.a/app.manifest.json', j(base({ id: 'com.aura.a', tools: ['git'], permissions: ['apps.read'], services: [{ name: 'db', image: 'x', tools: [] }] })));
  write('apps/com.aura.b/app.manifest.json', j(base({ id: 'com.aura.b', tools: [] })));
  write('apps/com.aura.c/app.manifest.json', j(base({ id: 'com.aura.c' })));
  write('.aura/capabilities.yaml', 'capabilities:\n  git:\n    source: apt\n    package: git\n');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, ...GIT, 'add', '-A']);
  execFileSync('git', ['-C', repo, ...GIT, 'commit', '-q', '-m', 'init']);
  return { root, repo, write, j, opts: { repoRoot: repo, systemAppsDir: join(repo, 'apps'), dataRoot: join(root, 'data') } };
}

test('migration: a clean checkout reports nothing; a release (no git) has nothing to migrate', () => {
  const c = checkout();
  const r = overlayMigrationReport(c.opts);
  assert.deepEqual([r.mode, r.apps, r.registry, r.fields], ['developer', [], [], []]);
  const rel = overlayMigrationReport({ ...c.opts, repoRoot: join(c.root, 'nogit'), systemAppsDir: join(c.root, 'nogit', 'apps') });
  assert.equal(rel.mode, 'release');
  assert.throws(() => applyOverlayMigration({ ...c.opts, repoRoot: join(c.root, 'nogit') }, rel.digest), /release/);
});

test('migration: grant edits become ops and the tracked manifest is restored; other fields stay and are reported', () => {
  const c = checkout();
  const editedA = base({ id: 'com.aura.a', tools: ['git', 'rg'], permissions: ['apps.mount'], services: [{ name: 'db', image: 'x', tools: ['psql'] }] });
  c.write('apps/com.aura.a/app.manifest.json', c.j(editedA));
  c.write('apps/com.aura.b/app.manifest.json', c.j(base({ id: 'com.aura.b', name: 'Renamed', tools: ['node'] })));
  c.write('.aura/capabilities.yaml.bak', 'capabilities:\n  git:\n    source: apt\n    package: git\n  old:\n    source: apt\n    package: old\n');
  const report = overlayMigrationReport(c.opts);
  assert.deepEqual(report.fields, ['permissions', 'services[].tools', 'tools'], 'only the three fields move');
  assert.deepEqual(report.otherFields, ['name']);
  const a = report.apps.find((x) => x.appId === 'com.aura.a');
  assert.deepEqual([a.restore, a.otherFields], [true, []]);
  assert.deepEqual(a.ops, { v: 1, tools: { add: ['rg'], remove: [] }, permissions: { add: ['apps.mount'], remove: ['apps.read'] }, services: { db: { tools: { add: ['psql'], remove: [] } } } });
  const b = report.apps.find((x) => x.appId === 'com.aura.b');
  assert.deepEqual([b.restore, b.fields, b.otherFields], [false, ['tools'], ['name']]);
  assert.deepEqual(report.registry, [{ file: '.aura/capabilities.yaml.bak', tracked: false, added: ['old'], changed: [], removed: [], action: 'move-aside' }]);
  // Read-only: nothing moved yet.
  assert.equal(existsSync(join(c.repo, '.aura/capabilities.yaml.bak')), true);
  assert.equal(existsSync(layout(c.opts.dataRoot).overlayApps), false);

  assert.throws(() => applyOverlayMigration(c.opts, '0'.repeat(64)), (e) => e.code === 'digest-mismatch');
  const res = applyOverlayMigration(c.opts, report.digest);
  assert.deepEqual([res.overlays, res.restored, res.movedAside.map((m) => m.file)], [['com.aura.a', 'com.aura.b'], ['com.aura.a'], ['.aura/capabilities.yaml.bak']]);
  assert.equal(execFileSync('git', ['-C', c.repo, 'status', '--porcelain', '--', 'apps/com.aura.a', '.aura']).toString(), '', 'a and the registry are clean again');
  assert.ok(existsSync(res.movedAside[0].to));
  // The effective manifest is what the owner had.
  const overlayApps = layout(c.opts.dataRoot).overlayApps;
  const restored = JSON.parse(readFileSync(join(c.repo, 'apps/com.aura.a/app.manifest.json'), 'utf8'));
  const eff = applyManifestOverlay(restored, readManifestOverlay(overlayApps, 'com.aura.a'));
  assert.deepEqual([eff.tools, eff.permissions, eff.services[0].tools], [editedA.tools, editedA.permissions, ['psql']]);
  // Idempotent: what is left is b (other fields), and applying again changes nothing.
  const again = overlayMigrationReport(c.opts);
  assert.deepEqual(again.apps.map((x) => x.appId), ['com.aura.b']);
  const before = readFileSync(join(overlayApps, 'com.aura.b.json'), 'utf8');
  applyOverlayMigration(c.opts, again.digest);
  assert.equal(readFileSync(join(overlayApps, 'com.aura.b.json'), 'utf8'), before);
});

test('migration: a tracked registry edited in place is reported only', () => {
  const c = checkout();
  c.write('.aura/capabilities.yaml', 'capabilities:\n  git:\n    source: apt\n    package: git\n  mine:\n    source: apt\n    package: sl\n');
  const report = overlayMigrationReport(c.opts);
  assert.deepEqual(report.registry, [{ file: '.aura/capabilities.yaml', tracked: true, added: ['mine'], changed: [], removed: [], action: 'report-only' }]);
  const res = applyOverlayMigration(c.opts, report.digest);
  assert.deepEqual(res.movedAside, []);
  assert.match(readFileSync(join(c.repo, '.aura/capabilities.yaml'), 'utf8'), /mine/);
});

test('overlayFromDiff: a base without a template list and an empty local list is no op', () => {
  assert.equal(overlayFromDiff(base({ services: [{ name: 's' }] }), base({ services: [{ name: 's', tools: [] }] })), null);
});

test('the overlay ends with the installation: removing the app drops its grants (a reinstall earns them again)', async () => {
  const { NexusManager } = await import('../dist/nexus/NexusManager.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-overlay-nexus-'));
  const scope = (id, priority, immutable) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority });
  const scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  const rootDataDir = join(root, 'data');
  const mgr = new NexusManager({ scopes, rootDataDir });
  mkdirSync(join(scopes[2].appsDir, 'io.user.app'), { recursive: true });
  writeFileSync(join(scopes[2].appsDir, 'io.user.app', 'app.manifest.json'), JSON.stringify(base({ id: 'io.user.app' })));
  const overlayApps = layout(rootDataDir).overlayApps;
  writeManifestOverlay(overlayApps, 'io.user.app', { v: 1, permissions: { add: ['apps.mount'], remove: [] } });
  writeManifestOverlay(overlayApps, 'io.other.app', { v: 1, tools: { add: ['git'], remove: [] } });
  await mgr.removeFromScope('io.user.app', 'user');
  assert.equal(readManifestOverlay(overlayApps, 'io.user.app'), null);
  assert.ok(readManifestOverlay(overlayApps, 'io.other.app'), 'other apps keep theirs');
});

test('containers see the effective registry at /workspace/.aura/capabilities.yaml, read-only, in both layouts (systemTreeMount)', async () => {
  const { systemTreeMount } = await import('../dist/runtimes/spawn/systemTreeArgs.js');
  const want = ['--mount', 'type=volume,source=appdata,target=/workspace/.aura/capabilities.yaml,volume-subpath=aura/overlay/capabilities.yaml,readonly'];
  assert.deepEqual(systemTreeMount({ kind: 'checkout', hostRoot: '/srv/aura', nodeModulesVolume: 'nm', dataVolume: 'appdata' }, '.aura', '/workspace/.aura'), want);
  assert.deepEqual(systemTreeMount({ kind: 'release', releaseId: '0.1.0-0123456789ab-cafebabe', dataVolume: 'appdata' }, '.aura', '/workspace/.aura'), want);
  assert.equal(capabilityRegistryMount('/data').subpath, 'aura/overlay/capabilities.yaml', 'the path the shell writes');
});
