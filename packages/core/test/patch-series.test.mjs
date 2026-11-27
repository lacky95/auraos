// Patch series (core patches/series.ts): save a work tree's commits as
// patches/NNNN-*.patch + aura-patches.yaml in one patch-repo commit, and
// apply a series to a base — a compatible new base keeps the change, a
// conflicting one names the patch. Run via:
//   node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applySeries, baseCommitIn, buildTree, checkoutBase, exportPatches, formatSeries, initRepo, parseSeries,
  readPatches, readSeries, safeDirectoryArgs, saveSeries, SERIES_FILE, SeriesError,
} from '../dist/patches/series.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
  { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** An upstream repo with an app file; returns helpers to add upstream commits. */
function upstream(sub = '') {
  const root = mkdtempSync(join(tmpdir(), 'aura-series-'));
  const repo = join(root, 'upstream');
  const app = sub ? join(repo, sub) : repo;
  execFileSync('mkdir', ['-p', app]);
  writeFileSync(join(app, 'status.js'), 'export const status = "idle";\nexport const color = "grey";\n\n\n\nexport const footer = "v1";\n');
  writeFileSync(join(app, 'app.manifest.json'), '{"id":"io.test.app"}\n');
  if (sub) writeFileSync(join(repo, 'README'), 'monorepo\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'one');
  const commit = (file, text, msg) => {
    writeFileSync(join(app, file), text);
    git(repo, 'commit', '-qam', msg);
    return git(repo, 'rev-parse', 'HEAD');
  };
  return { root, repo, app, base: git(repo, 'rev-parse', 'HEAD'), commit };
}

/** A workspace on the base with one customization committed. */
function customize(u, base) {
  const ws = join(u.root, `ws-${Math.random().toString(36).slice(2)}`);
  const baseCommit = checkoutBase(ws, base);
  const f = join(ws, 'status.js');
  writeFileSync(f, readFileSync(f, 'utf-8').replace('"idle"', '"busy"'));
  git(ws, 'commit', '-qam', 'Status shows busy');
  return { ws, baseCommit };
}

test('series file round-trips and rejects bad input', () => {
  const s = { v: 2, target: { kind: 'app', appId: 'io.test.app' }, base: { repository: 'file:///x', commit: 'abcdef1' }, patches: [{ file: 'patches/0001-a.patch', subject: 'A', enabled: true }] };
  assert.deepEqual(parseSeries(formatSeries(s)), s);
  assert.throws(() => parseSeries('app: x\nbase: { commit: nothex }\n'), SeriesError);
  assert.throws(() => parseSeries('app: x\nbase: { commit: abcdef1, path: ../etc }\n'), SeriesError);
  assert.throws(() => parseSeries('app: x\nbase: { commit: abcdef1 }\npatches: [{ file: /etc/passwd, subject: x }]\n'), SeriesError);
});

test('initRepo makes a main branch with one commit of the files, honouring .gitignore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-init-'));
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  execFileSync('mkdir', ['-p', join(dir, 'node_modules/x')]);
  writeFileSync(join(dir, 'node_modules/x/i.js'), '1');
  const sha = initRepo(dir, 'Initial commit');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.deepEqual(git(dir, 'ls-files').split('\n').sort(), ['.gitignore', 'a.txt']);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(initRepo(dir, 'again'), null, 'an existing repo is left alone');
});

test('save: patches/NNNN-*.patch plus aura-patches.yaml in one patch-repo commit', () => {
  const u = upstream();
  const base = { repository: u.repo, commit: u.base };
  const { ws, baseCommit } = customize(u, base);
  const repo = join(u.root, 'patches-repo');
  const patches = exportPatches(ws, baseCommit);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].file, 'patches/0001-Status-shows-busy.patch');
  assert.equal(patches[0].subject, 'Status shows busy');
  const r = saveSeries(repo, { target: { kind: 'app', appId: 'io.test.app' }, base, patches, message: 'save: Status shows busy' });
  assert.equal(r.changed, true);
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    [SERIES_FILE, 'patches/0001-Status-shows-busy.patch']);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(readSeries(repo, r.commit), r.series);
  // Same change again: nothing new to commit.
  const again = saveSeries(repo, { target: { kind: 'app', appId: 'io.test.app' }, base, patches: exportPatches(ws, baseCommit), message: 'save again' });
  assert.equal(again.changed, false);
  assert.equal(again.commit, r.commit);
  // A second change: the series grows, old files are replaced, one more commit.
  writeFileSync(join(ws, 'extra.js'), 'export default 1;\n');
  git(ws, 'add', '-A'); git(ws, 'commit', '-qm', 'Add extra');
  const two = saveSeries(repo, { target: { kind: 'app', appId: 'io.test.app' }, base, patches: exportPatches(ws, baseCommit), message: 'save: Add extra' });
  assert.deepEqual(two.series.patches.map((p) => p.file), ['patches/0001-Status-shows-busy.patch', 'patches/0002-Add-extra.patch']);
  assert.deepEqual(readdirSync(join(repo, 'patches')).sort(), ['0001-Status-shows-busy.patch', '0002-Add-extra.patch']);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2');
});

test('apply to a new base: compatible keeps the change, conflicting names the patch', () => {
  const u = upstream();
  const base = { repository: u.repo, commit: u.base };
  const { ws, baseCommit } = customize(u, base);
  const repo = join(u.root, 'patches-repo');
  const saved = saveSeries(repo, { target: { kind: 'app', appId: 'io.test.app' }, base, patches: exportPatches(ws, baseCommit), message: 'save' });
  const patches = readPatches(repo, saved.series, saved.commit);

  // Compatible upstream change (another line of the same file).
  const compatible = u.commit('status.js', readFileSync(join(u.app, 'status.js'), 'utf-8').replace('"v1"', '"v2"'), 'footer v2');
  const ok = buildTree(join(u.root, 'cand-ok'), { ...base, commit: compatible }, patches);
  assert.equal(ok.ok, true);
  const text = readFileSync(join(u.root, 'cand-ok', 'status.js'), 'utf-8');
  assert.match(text, /"busy"/);
  assert.match(text, /"v2"/);

  // Conflicting upstream change (the same line).
  const conflicting = u.commit('status.js', readFileSync(join(u.app, 'status.js'), 'utf-8').replace('"idle"', '"waiting"'), 'status waiting');
  const bad = buildTree(join(u.root, 'cand-bad'), { ...base, commit: conflicting }, patches);
  assert.equal(bad.ok, false);
  assert.equal(bad.failed.file, 'patches/0001-Status-shows-busy.patch');
  assert.equal(bad.failed.subject, 'Status shows busy');
  assert.equal(bad.failed.index, 0);
  assert.equal(bad.inProgress, false);
  // Backed out: the tree is the new base, no am session left.
  assert.equal(git(join(u.root, 'cand-bad'), 'rev-parse', 'HEAD'), bad.baseCommit);
  assert.equal(existsSync(join(u.root, 'cand-bad', '.git', 'rebase-apply')), false);

  // Repair mode keeps the conflict for someone to fix.
  const fix = join(u.root, 'fix');
  checkoutBase(fix, { ...base, commit: conflicting });
  const kept = applySeries(fix, patches, { keepConflict: true });
  assert.equal(kept.ok, false);
  assert.equal(kept.inProgress, true);
  assert.deepEqual(kept.conflicts, ['status.js']);
  assert.equal(existsSync(join(fix, '.git', 'rebase-apply')), true);
});

test('a base with path: the subdirectory is the root, the same base gives the same commit', () => {
  const u = upstream('apps/io.test.app');
  const base = { repository: u.repo, commit: u.base, path: 'apps/io.test.app' };
  const { ws, baseCommit } = customize(u, base);
  assert.equal(existsSync(join(ws, 'README')), false);
  assert.equal(existsSync(join(ws, 'status.js')), true);
  assert.equal(baseCommitIn(ws, base), baseCommit, 'deterministic synthetic base');
  const patches = exportPatches(ws, baseCommit);
  assert.match(patches[0].content, /a\/status\.js/);
  const next = u.commit('status.js', readFileSync(join(u.app, 'status.js'), 'utf-8').replace('"v1"', '"v3"'), 'v3');
  const r = buildTree(join(u.root, 'cand'), { ...base, commit: next }, patches);
  assert.equal(r.ok, true);
  assert.match(readFileSync(join(u.root, 'cand', 'status.js'), 'utf-8'), /"busy"[\s\S]*"v3"/);
});

// Repos the shell creates (as root) and the Terminal opens, or the other way
// round: git trusts the patch repos and workspaces, each by its own path, and
// nothing else (safe.directory on the command line, never in a config file).
test('git ownership: a patch repo or workspace another user owns works; any other repo keeps git\'s check', { skip: process.getuid?.() !== 0 && 'needs root to chown' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-own-'));
  const before = process.env.AURA_PATCHES_DIR;
  process.env.AURA_PATCHES_DIR = join(root, 'patches');
  try {
    const chownAll = (dir) => execFileSync('chown', ['-R', '4321:4321', dir]);
    const u = upstream();
    // A patch repo made by someone else (uid 4321).
    const repo = join(root, 'patches', '00000000-1111-4222-8333-444444444444');
    mkdirSync(repo, { recursive: true });
    const ws = join(root, 'ws');
    checkoutBase(ws, { repository: u.repo, commit: u.base });
    git(ws, 'checkout', '-q', '-b', 'patches');
    writeFileSync(join(ws, 'status.js'), readFileSync(join(ws, 'status.js'), 'utf-8').replace('"idle"', '"busy"'));
    git(ws, 'commit', '-qam', 'busy');
    saveSeries(repo, { target: { kind: 'app', appId: 'io.test.app' }, base: { repository: u.repo, commit: u.base }, patches: exportPatches(ws, u.base), message: 'save' });
    chownAll(repo);
    const plain = () => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.throws(plain, /dubious ownership/, 'git refuses it by default');
    assert.deepEqual(safeDirectoryArgs(repo), ['-c', `safe.directory=${repo}`]);
    assert.equal(readSeries(repo, 'HEAD').patches.length, 1, 'the series library opens it');

    // The same repo outside the trusted roots stays refused.
    assert.deepEqual(safeDirectoryArgs(ws), []);
    chownAll(ws);
    assert.throws(() => exportPatches(ws, u.base), /dubious ownership/);
    assert.deepEqual(safeDirectoryArgs(join(root, 'patches')), [], 'the root itself is no repo');
    assert.deepEqual(safeDirectoryArgs(join(root, 'patches-evil', 'x')), [], 'a sibling with the same prefix');
  } finally {
    if (before === undefined) delete process.env.AURA_PATCHES_DIR; else process.env.AURA_PATCHES_DIR = before;
  }
});

test('git ownership: the patch repo and workspaces the shell binds into a Terminal, and their volume dirs, are the trusted roots', () => {
  const before = process.env.AURA_PATCHES_DIR;
  delete process.env.AURA_PATCHES_DIR;
  try {
    const data = process.env.AURA_DATA_DIR ?? '/data';
    for (const dir of ['/mnt/aura/patches/io.test.app', '/mnt/aura/work/io.test.app', join(data, 'aura', 'patches', 'inst-1'), join(data, 'aura', 'workspaces', 'default', 'inst-1', '2')]) {
      assert.deepEqual(safeDirectoryArgs(dir), ['-c', `safe.directory=${dir}`], dir);
    }
    for (const dir of ['/data/patches/inst-1', '/mnt/aura/io.test.app', '/mnt/aura/patches', join(data, 'scopes', 'x')]) {
      assert.deepEqual(safeDirectoryArgs(dir), [], dir);
    }
  } finally {
    if (before !== undefined) process.env.AURA_PATCHES_DIR = before;
  }
});
