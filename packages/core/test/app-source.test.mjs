// App source: where an app is developed, and `aura dev checkout`. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/app-source.test.mjs
//
// Bundles never ship .git. A release records its source repo + commit
// (.nexus-published.json, OCI source/revision annotations), and checkoutApp
// turns an installed copy into a git checkout of it without touching a file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPublishMarker, checkoutApp, cloneUrl, isDevCheckout, readAppSource, readPublishMarker,
  resolveAppRepository, stampManifest, PUBLISH_MARKER,
} from '../dist/nexus/AppSource.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { buildStoreAnnotations, parseStoreAnnotations } from '../dist/nexus/ociMetadata.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
  { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const manifestOf = (extra = {}) => AppManifestSchema.parse({ id: 'io.test.app', name: 'App', version: '1.2.0', ...extra });

/** A bare "remote" with one commit of an app, plus the author's clone. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aura-src-'));
  const remote = join(root, 'remote.git');
  const author = join(root, 'author');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, author], { stdio: 'ignore' });
  writeFileSync(join(author, 'app.manifest.json'), JSON.stringify({ id: 'io.test.app', name: 'App', version: '1.2.0' }));
  writeFileSync(join(author, 'index.js'), 'console.log(1)\n');
  writeFileSync(join(author, '.gitignore'), 'node_modules/\n');
  git(author, 'add', '-A');
  git(author, 'commit', '-qm', 'one');
  git(author, 'push', '-q', 'origin', 'HEAD:main');
  return { root, remote, author, url: `file://${remote}` };
}

/** What an install leaves: the files, no .git, the release's marker. */
function install(from, root, marker) {
  const dir = join(root, 'apps', 'io.test.app');
  mkdirSync(dir, { recursive: true });
  cpSync(from, dir, { recursive: true, filter: (p) => !/\/\.git(\/|$)/.test(p) });
  if (marker) writeFileSync(join(dir, PUBLISH_MARKER), JSON.stringify(marker));
  return dir;
}

test('repository is an optional manifest field, separate from publish.repo', () => {
  const m = manifestOf({ repository: { url: 'gitlab.com/o/r', branch: 'dev' } });
  assert.deepEqual(m.repository, { url: 'gitlab.com/o/r', branch: 'dev' });
  assert.equal(manifestOf().repository, undefined);
  assert.equal(AppManifestSchema.safeParse({ id: 'a.b', name: 'X', version: '1.0.0', repository: { url: '' } }).success, false);
  // commit: a hash, or "" as the placeholder kept in the repo.
  assert.equal(manifestOf({ repository: { url: 'x/y', commit: '' } }).repository.commit, '');
  assert.equal(manifestOf({ repository: { url: 'x/y', commit: 'a1b2c3d4' } }).repository.commit, 'a1b2c3d4');
  assert.equal(AppManifestSchema.safeParse({ id: 'a.b', name: 'X', version: '1.0.0', repository: { url: 'x/y', commit: 'main' } }).success, false);
});

test('publish stamps branch + commit into the released manifest of an app that declares repository', () => {
  const raw = '{\n    "id": "a.b",\n    "repository": { "url": "gitlab.com/o/r", "commit": "" },\n    "tools": ["git"]\n}\n';
  const out = stampManifest(raw, { repository: 'https://gitlab.com/o/r.git', branch: 'dev', commit: 'abc1234' });
  const doc = JSON.parse(out);
  assert.deepEqual(doc.repository, { url: 'gitlab.com/o/r', commit: 'abc1234', branch: 'dev' });
  assert.deepEqual(Object.keys(doc), ['id', 'repository', 'tools'], 'key order kept, no defaults added');
  assert.ok(out.startsWith('{\n    "id"') && out.endsWith('}\n'), 'indentation and final newline kept');
  // Nothing declared, or no commit known: the manifest ships as it is.
  assert.equal(stampManifest('{"id":"a.b"}', { commit: 'abc1234' }), null);
  assert.equal(stampManifest(raw, { repository: 'x' }), null);
});

test('cloneUrl takes what authors write', () => {
  assert.equal(cloneUrl('gitlab.com/o/r'), 'https://gitlab.com/o/r.git');
  assert.equal(cloneUrl('gitlab.com/o/r.git'), 'https://gitlab.com/o/r.git');
  assert.equal(cloneUrl('https://github.com/o/r'), 'https://github.com/o/r');
  assert.equal(cloneUrl('git@gitlab.com:o/r.git'), 'git@gitlab.com:o/r.git');
  assert.equal(cloneUrl('file:///tmp/x.git'), 'file:///tmp/x.git');
});

test('readAppSource records repo, branch, commit and uncommitted changes', () => {
  const f = fixture();
  const head = git(f.author, 'rev-parse', 'HEAD');
  const src = readAppSource(f.author, manifestOf());
  assert.deepEqual(src, { repository: f.remote, branch: 'main', commit: head });
  // The manifest's declaration wins over the clone's origin.
  assert.equal(readAppSource(f.author, manifestOf({ repository: { url: 'gitlab.com/o/r' } })).repository, 'https://gitlab.com/o/r.git');
  writeFileSync(join(f.author, 'index.js'), 'changed\n');
  assert.equal(readAppSource(f.author, manifestOf()).dirty, true);
  // Not a git tree: only the declaration.
  const plain = mkdtempSync(join(tmpdir(), 'aura-src-plain-'));
  assert.deepEqual(readAppSource(plain, manifestOf()), {});
  assert.deepEqual(readAppSource(plain, manifestOf({ repository: { url: 'gitlab.com/o/r', branch: 'dev' } })),
    { repository: 'https://gitlab.com/o/r.git', branch: 'dev' });
});

test('the release source rides on OCI annotations and back', () => {
  const ann = buildStoreAnnotations(manifestOf(), { source: { repository: 'https://gitlab.com/o/r.git', commit: 'abc123' } });
  assert.equal(ann['org.opencontainers.image.source'], 'https://gitlab.com/o/r.git');
  assert.equal(ann['org.opencontainers.image.revision'], 'abc123');
  const meta = parseStoreAnnotations(ann);
  assert.equal(meta.repository, 'https://gitlab.com/o/r.git');
  assert.equal(meta.revision, 'abc123');
  assert.equal(buildStoreAnnotations(manifestOf())['org.opencontainers.image.source'], undefined);
});

test('checkoutApp puts HEAD on the release commit without touching the files', () => {
  const f = fixture();
  const m = manifestOf({ repository: { url: f.url } });
  const marker = buildPublishMarker(m, readAppSource(f.author, m));
  // The branch moves on after the release.
  writeFileSync(join(f.author, 'later.js'), 'x\n');
  git(f.author, 'add', '-A'); git(f.author, 'commit', '-qm', 'two'); git(f.author, 'push', '-q', 'origin', 'HEAD:main');

  const dir = install(f.author, f.root, marker);
  rmSync(join(dir, 'later.js'));
  const before = readFileSync(join(dir, 'index.js'), 'utf-8');
  assert.equal(isDevCheckout(dir), false);

  const r = checkoutApp(dir, m);
  assert.equal(r.created, true);
  assert.equal(r.target.how, 'release-commit');
  assert.equal(r.repoFrom, 'manifest');
  assert.equal(r.branch, 'main');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), marker.source.commit);
  assert.deepEqual(r.changes, [], 'the marker is excluded, the files match the commit');
  assert.equal(readFileSync(join(dir, 'index.js'), 'utf-8'), before);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
  assert.equal(isDevCheckout(dir), true);

  // Idempotent: a checkout is only reported on.
  const again = checkoutApp(dir, m);
  assert.equal(again.created, false);
});

test('without a release commit: the v<version> tag, else the branch tip with a warning', () => {
  const f = fixture();
  git(f.author, 'tag', 'v1.2.0'); git(f.author, 'push', '-q', 'origin', 'v1.2.0');
  const tagged = git(f.author, 'rev-parse', 'HEAD');
  writeFileSync(join(f.author, 'index.js'), 'two\n');
  git(f.author, 'commit', '-qam', 'two'); git(f.author, 'push', '-q', 'origin', 'HEAD:main');

  const m = manifestOf({ repository: { url: f.url } });
  const a = install(f.author, join(f.root, 'a'));
  const r = checkoutApp(a, m);
  assert.equal(r.target.how, 'version-tag');
  assert.equal(git(a, 'rev-parse', 'HEAD'), tagged);
  assert.deepEqual(r.changes, [' M index.js'], 'differences show as local changes, never overwritten');
  assert.equal(readFileSync(join(a, 'index.js'), 'utf-8'), 'two\n');

  const b = install(f.author, join(f.root, 'b'));
  const r2 = checkoutApp(b, manifestOf({ version: '9.9.9', repository: { url: f.url } }));
  assert.equal(r2.target.how, 'branch');
  assert.ok(r2.warnings.some((w) => w.includes('tip of main')));
});

test('the repo comes from the flag, the manifest, the release, then publish.repo', () => {
  const marker = { publishedBy: 'aura-nexus', publishedAt: '', publishedVersion: '1', source: { repository: 'https://r.example/rel.git' } };
  assert.deepEqual(resolveAppRepository(manifestOf(), marker, 'gitlab.com/f/f'), { url: 'https://gitlab.com/f/f.git', from: 'flag' });
  assert.equal(resolveAppRepository(manifestOf({ repository: { url: 'gitlab.com/m/m' } }), marker).from, 'manifest');
  assert.equal(resolveAppRepository(manifestOf(), marker).from, 'release');
  assert.equal(resolveAppRepository(manifestOf({ publish: { repo: 'gitlab.com/p/p' } }), null).from, 'publish.repo');
  assert.equal(resolveAppRepository(manifestOf(), null), null);
});

test('checkoutApp uses the commit stamped into the manifest', () => {
  const f = fixture();
  const first = git(f.author, 'rev-parse', 'HEAD');
  writeFileSync(join(f.author, 'later.js'), 'x\n');
  git(f.author, 'add', '-A'); git(f.author, 'commit', '-qm', 'two'); git(f.author, 'push', '-q', 'origin', 'HEAD:main');
  const dir = install(f.author, f.root);   // no publish marker at all
  rmSync(join(dir, 'later.js'));
  const r = checkoutApp(dir, manifestOf({ repository: { url: f.url, branch: 'main', commit: first } }));
  assert.equal(r.target.how, 'release-commit');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), first);
  assert.deepEqual(r.changes, []);
});

test('a failed checkout leaves no .git behind', () => {
  const f = fixture();
  const dir = install(f.author, f.root);
  assert.throws(() => checkoutApp(dir, manifestOf()), /does not say where its source lives/);
  assert.throws(() => checkoutApp(dir, manifestOf({ repository: { url: `file://${f.root}/missing.git` } })), /could not fetch/);
  assert.equal(existsSync(join(dir, '.git')), false);
  assert.throws(() => checkoutApp(dir, manifestOf({ repository: { url: f.url } }), { ref: 'nope' }), /'nope' is not a commit/);
  assert.equal(existsSync(join(dir, '.git')), false);
  assert.equal(readPublishMarker(dir), null);
});
