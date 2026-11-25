// Patch series (core patches/series.ts): save a work tree's commits as
// patches/NNNN-*.patch + aura-patches.yaml in one patch-repo commit, and
// apply a series to a base — a compatible new base keeps the change, a
// conflicting one names the patch. Run via:
//   node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applySeries, baseCommitIn, buildTree, checkoutBase, exportPatches, formatSeries, initRepo, parseSeries,
  readPatches, readSeries, saveSeries, SERIES_FILE, SeriesError,
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
  const s = { app: 'io.test.app', base: { repository: 'file:///x', commit: 'abcdef1' }, patches: [{ file: 'patches/0001-a.patch', subject: 'A' }] };
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
  const r = saveSeries(repo, { app: 'io.test.app', base, patches, message: 'save: Status shows busy' });
  assert.equal(r.changed, true);
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    [SERIES_FILE, 'patches/0001-Status-shows-busy.patch']);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(readSeries(repo, r.commit), r.series);
  // Same change again: nothing new to commit.
  const again = saveSeries(repo, { app: 'io.test.app', base, patches: exportPatches(ws, baseCommit), message: 'save again' });
  assert.equal(again.changed, false);
  assert.equal(again.commit, r.commit);
  // A second change: the series grows, old files are replaced, one more commit.
  writeFileSync(join(ws, 'extra.js'), 'export default 1;\n');
  git(ws, 'add', '-A'); git(ws, 'commit', '-qm', 'Add extra');
  const two = saveSeries(repo, { app: 'io.test.app', base, patches: exportPatches(ws, baseCommit), message: 'save: Add extra' });
  assert.deepEqual(two.series.patches.map((p) => p.file), ['patches/0001-Status-shows-busy.patch', 'patches/0002-Add-extra.patch']);
  assert.deepEqual(readdirSync(join(repo, 'patches')).sort(), ['0001-Status-shows-busy.patch', '0002-Add-extra.patch']);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2');
});

test('apply to a new base: compatible keeps the change, conflicting names the patch', () => {
  const u = upstream();
  const base = { repository: u.repo, commit: u.base };
  const { ws, baseCommit } = customize(u, base);
  const repo = join(u.root, 'patches-repo');
  const saved = saveSeries(repo, { app: 'io.test.app', base, patches: exportPatches(ws, baseCommit), message: 'save' });
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
