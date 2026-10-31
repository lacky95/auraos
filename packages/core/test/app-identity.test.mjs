// App identity: `id` (local name) + `originId` (which logical app). Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/app-identity.test.mjs
//
// The store must never replace an app just because the ids match, must
// recognise the same app under another id or from another registry, and a
// clone must become its own app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  newOriginId, isOriginId, withKeyAfterId, setOriginIdInFile, rewriteAppIdentity,
  classifyIdentity, suggestFreeAppId, scanInstalledIdentities, idRegex,
} from '../dist/app-manager/AppIdentity.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { buildStoreAnnotations, parseStoreAnnotations } from '../dist/nexus/ociMetadata.js';
import { parseCatalog } from '../dist/nexus/OciCatalog.js';

const O1 = '550e8400-e29b-41d4-a716-446655440000';
const O2 = 'a12f67b9-89d3-4e01-b51f-729a5b99c812';
const base = { id: 'io.aura.vscode', name: 'VSCode', version: '1.0.0' };

test('originId is an optional UUID in the manifest and survives parsing', () => {
  assert.equal(AppManifestSchema.parse({ ...base, originId: O1 }).originId, O1);
  assert.equal(AppManifestSchema.parse(base).originId, undefined);
  assert.equal(AppManifestSchema.safeParse({ ...base, originId: 'io.aura.vscode' }).success, false);
  assert.ok(isOriginId(newOriginId()));
  assert.notEqual(newOriginId(), newOriginId());
});

test('setOriginIdInFile puts the key after id, keeps order, assign never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-oid-'));
  const p = join(dir, 'app.manifest.json');
  writeFileSync(p, JSON.stringify({ id: 'a.b', name: 'X', version: '1.0.0', tools: ['git'] }, null, 2));
  const a = setOriginIdInFile(p, { mode: 'assign' });
  assert.ok(a.changed && isOriginId(a.originId) && a.previous === null);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p, 'utf-8'))), ['id', 'originId', 'name', 'version', 'tools']);
  const again = setOriginIdInFile(p, { mode: 'assign' });
  assert.equal(again.changed, false);
  assert.equal(again.originId, a.originId);
  const re = setOriginIdInFile(p, { mode: 'reassign', originId: O2 });
  assert.deepEqual([re.changed, re.previous, re.originId], [true, a.originId, O2]);
  assert.deepEqual(withKeyAfterId({ name: 'n' }, 'originId', O1), { name: 'n', originId: O1 });
});

test('setOriginIdInFile is a one-line edit: hand formatting survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-oid-fmt-'));
  const p = join(dir, 'app.manifest.json');
  const raw = '{\n  "id": "a.b",\n  "name": "X \\u2014 y",\n  "version": "1.0.0",\n  "tools": ["git", "node"]\n}';
  writeFileSync(p, raw);
  const a = setOriginIdInFile(p, { mode: 'assign' });
  assert.equal(readFileSync(p, 'utf-8'), raw.replace('"id": "a.b",\n', `"id": "a.b",\n  "originId": "${a.originId}",\n`));
  setOriginIdInFile(p, { mode: 'reassign', originId: O2 });
  assert.equal(readFileSync(p, 'utf-8'), raw.replace('"id": "a.b",\n', `"id": "a.b",\n  "originId": "${O2}",\n`));
});

test('rewriteAppIdentity: a clone gets the new id everywhere and a new originId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-rw-'));
  writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify({
    ...base, originId: O1, critical: true, dataProvider: { authority: 'io.aura.vscode' },
  }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'io.aura.vscode', dependencies: {} }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), "const ID = 'io.aura.vscode'; const other = 'io.aura.vscode.helper';");
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), 'url = io.aura.vscode');

  const r = rewriteAppIdentity(dir, { fromId: 'io.aura.vscode', toId: 'io.aura.vscode.custom', scope: 'user', originId: 'new', sdkVersion: '0.0.1' });
  assert.equal(r.ok, true);
  const m = JSON.parse(readFileSync(join(dir, 'app.manifest.json'), 'utf-8'));
  assert.equal(m.id, 'io.aura.vscode.custom');
  assert.ok(isOriginId(m.originId) && m.originId !== O1, 'new originId');
  assert.equal(r.previousOriginId, O1);
  assert.equal(m.dataProvider.authority, 'io.aura.vscode.custom');
  assert.equal(m.critical, undefined);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).name, 'io.aura.vscode.custom');
  assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf-8'),
    "const ID = 'io.aura.vscode.custom'; const other = 'io.aura.vscode.helper';", 'whole ids only');
  assert.equal(readFileSync(join(dir, '.git', 'config'), 'utf-8'), 'url = io.aura.vscode', '.git is never swept');
});

test('rewriteAppIdentity keep / explicit originId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-rw2-'));
  writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify({ ...base, originId: O1 }));
  assert.equal(rewriteAppIdentity(dir, { fromId: base.id, toId: 'com.example.vscode', scope: 'global', originId: 'keep', sdkVersion: '0' }).originId, O1);
  assert.equal(rewriteAppIdentity(dir, { fromId: 'com.example.vscode', toId: 'com.example.vscode', scope: 'global', originId: O2, sdkVersion: '0' }).originId, O2);
  assert.equal(idRegex('a.b').test('x a.b.c'), false);
});

// ─── classifyIdentity: scenarios from the concept ───────────────────────

const inc = (over = {}) => ({ appId: 'io.aura.vscode', originId: O1, rawRef: 'io.aura.vscode', sourceName: 'registry-a', ...over });
const app = (over = {}) => ({ appId: 'io.aura.vscode', originId: O1, scope: 'global', record: { ref: 'io.aura.vscode', sourceName: 'registry-a' }, ...over });

test('C: nothing shares id or originId → fresh', () => {
  assert.deepEqual(classifyIdentity(inc(), []), { kind: 'fresh' });
  assert.deepEqual(classifyIdentity(inc(), [app({ appId: 'x.y', originId: O2 })]), { kind: 'fresh' });
});

test('normal update: same app from the source it came from', () => {
  const v = classifyIdentity(inc(), [app()]);
  assert.equal(v.kind, 'update');
  assert.equal(v.target.appId, 'io.aura.vscode');
});

test('A: same app from another registry → explicit switch-source, never silent', () => {
  const v = classifyIdentity(inc({ sourceName: 'registry-b' }), [app()]);
  assert.deepEqual([v.kind, v.conflict, v.choices], ['conflict', 'switch-source', ['update-existing', 'install-copy']]);
  // An app built locally (no record) is not "from" any source either.
  assert.equal(classifyIdentity(inc(), [app({ record: null })]).conflict, 'switch-source');
});

test('B: same id, different originId → never replaced, only install-as', () => {
  const v = classifyIdentity(inc({ originId: O2 }), [app()]);
  assert.deepEqual([v.kind, v.conflict, v.choices], ['conflict', 'id-taken', ['install-as']]);
  // Even from the very source it was installed from (the source now serves another app).
  assert.equal(classifyIdentity(inc({ originId: O2 }), [app()]).conflict, 'id-taken');
  // Unknown originId on one side, not tracked: may be replaced, but only when chosen.
  assert.deepEqual(classifyIdentity(inc({ originId: null }), [app({ record: null })]).choices, ['install-as', 'update-existing']);
  // Legacy record from this source, no originIds yet: a normal update.
  assert.equal(classifyIdentity(inc({ originId: null }), [app({ originId: null })]).kind, 'update');
});

test('D: same originId under another local id → offer update-existing / copy', () => {
  const v = classifyIdentity(inc({ appId: 'com.example.editor' }), [app()]);
  assert.deepEqual([v.kind, v.conflict, v.existing.appId], ['conflict', 'same-origin', 'io.aura.vscode']);
  assert.deepEqual(v.choices, ['update-existing', 'install-copy']);
});

test('linked installs: an app installed under another id updates from its source', () => {
  const local = app({ appId: 'io.my.editor', record: { ref: 'com.example.editor', sourceName: 'registry-b', remoteId: 'com.example.editor' } });
  const v = classifyIdentity(inc({ appId: 'com.example.editor', rawRef: 'com.example.editor', sourceName: 'registry-b' }), [local]);
  assert.deepEqual([v.kind, v.target.appId], ['update', 'io.my.editor']);
  // …but not when that source now serves a different app.
  assert.notEqual(classifyIdentity(inc({ appId: 'com.example.editor', originId: O2, sourceName: 'registry-b' }), [local]).kind, 'update');
  // A detached copy never follows its source.
  const copy = app({ appId: 'io.aura.vscode.copy', originId: O2, record: { ref: 'io.aura.vscode', sourceName: 'registry-a', detached: true } });
  assert.equal(classifyIdentity(inc(), [copy]).kind, 'fresh');
});

test('system apps: same artifact shadows, a different one never does', () => {
  assert.equal(classifyIdentity(inc(), [app({ scope: 'system', record: null })]).kind, 'update');
  assert.deepEqual(classifyIdentity(inc({ originId: O2 }), [app({ scope: 'system', record: null })]).choices, ['install-as']);
});

test('free ids and scanning', () => {
  assert.equal(suggestFreeAppId('a.b', new Set(['a.b', 'a.b.copy'])), 'a.b.copy2');
  const apps = mkdtempSync(join(tmpdir(), 'aura-scan-'));
  for (const [dir, m] of [['a.b', { id: 'a.b', originId: O1 }], ['c.d', { id: 'c.d' }], ['a.b.tmp.123', { id: 'a.b' }], ['e.f', { id: 'other.id' }]]) {
    mkdirSync(join(apps, dir));
    writeFileSync(join(apps, dir, 'app.manifest.json'), JSON.stringify(m));
  }
  assert.deepEqual(scanInstalledIdentities(apps, 'user').sort((x, y) => x.appId.localeCompare(y.appId)), [
    { appId: 'a.b', originId: O1, scope: 'user' },
    { appId: 'c.d', originId: null, scope: 'user' },
  ]);
});

test('originId travels with releases and the registry catalog', () => {
  const ann = buildStoreAnnotations(AppManifestSchema.parse({ ...base, originId: O1 }));
  assert.equal(ann['app.aura.origin-id'], O1);
  assert.equal(parseStoreAnnotations(ann).originId, O1);
  const doc = parseCatalog({ apps: [{ id: 'a.b', repo: 'p/a.b', originId: O1 }, { id: 'c.d', repo: 'p/c.d', originId: 'nope' }] }, 'p');
  assert.deepEqual(doc.apps.map((a) => a.originId), [O1, undefined]);
});

// ─── The store's view: catalog entry → install state ─────────────────────

import { compareVersions } from '../dist/nexus/version.js';
import { NexusManager } from '../dist/nexus/NexusManager.js';

test('compareVersions: numeric parts, pre-releases first, junk never "newer"', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v2.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('latest', '1.0.0'), 0);
  assert.equal(compareVersions(undefined, '1.0.0'), 0);
});

test('installStates: id + originId decide what the store shows', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-states-'));
  const O = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  const scope = (id, priority, immutable) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority });
  const scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  const put = (s, id, originId, version, record) => {
    const dir = join(s.appsDir, id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify({ id, originId, name: id, version }));
    if (record) {
      mkdirSync(join(s.dataDir, 'nexus', 'installed'), { recursive: true });
      writeFileSync(join(s.dataDir, 'nexus', 'installed', `${id}.json`), JSON.stringify({ id, version, scope: s.id, ...record }));
    }
  };
  const [sys, , user] = scopes;
  put(user, 'io.a.same', O(1), '1.0.0', { ref: 'io.a.same', sourceName: 'src', source: 'index' });
  put(user, 'io.my.editor', O(2), '1.0.0');                                        // built here, no record
  put(user, 'io.taken', O(3), '1.0.0');
  put(user, 'io.a.same.copy', O(6), '1.0.0', { ref: 'io.a.same', sourceName: 'src', detached: true });
  put(sys, 'com.sys', O(5), '2.0.0');

  const mgr = new NexusManager({ scopes, rootDataDir: join(root, 'root') });
  const e = (id, originId, version, sourceName = 'src') => ({ id, originId, version, sourceName, sources: { oci: { ref: `reg/${id}` } } });
  const st = mgr.installStates([
    e('io.a.same', O(1), '1.1.0'),
    e('com.ex.editor', O(2), '3.0.0', 'other'),
    e('io.taken', O(4), '1.0.0'),
    e('io.new', O(7), '1.0.0'),
    e('com.sys', O(5), '2.0.0'),
  ]);

  assert.deepEqual(st['io.a.same'], {
    status: 'installed', localAppId: 'io.a.same', scope: 'user', installedVersion: '1.0.0', availableVersion: '1.1.0',
    updateAvailable: true, fromThisSource: true, hasRecord: true, canUninstall: true, detached: false, verified: true,
  }, 'record ref is the bare id, the entry ref is reg/… — the same source name decides');
  assert.equal(st['com.ex.editor'].status, 'installed', 'same originId under another id');
  assert.equal(st['com.ex.editor'].localAppId, 'io.my.editor');
  assert.equal(st['com.ex.editor'].canUninstall, false, 'built here: never deleted from the store');
  assert.equal(st['com.ex.editor'].updateAvailable, true);
  assert.deepEqual([st['io.taken'].status, st['io.taken'].localAppId], ['id-taken', 'io.taken']);
  assert.equal(st['io.new'].status, 'available');
  // An entry without an originId (older publish) on an id that is installed:
  // installed, but not verified — never "taken" without proof.
  const legacy = mgr.installStates([e('io.taken', undefined, '1.0.0', 'official')])['io.taken'];
  assert.deepEqual([legacy.status, legacy.verified, legacy.localAppId], ['installed', false, 'io.taken']);
  assert.equal(st['com.ex.editor'].verified, true);
  assert.deepEqual([st['com.sys'].status, st['com.sys'].canUninstall, st['com.sys'].updateAvailable], ['installed', false, false]);
});
