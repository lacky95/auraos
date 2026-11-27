// Phase 7a (D68, Q23): the shared patch mechanisms.
//   - series v2: target, per-patch sha256, enabled flag, the series digest, v1 compatibility
//   - per-patch validation (refusals and approval flags)
//   - the activation lock (contention, stale holders, parallel targets)
//   - the approval binding (base + series digest + order + target)
//   - the atomic exchange switch: a crash at each step, then boot recovery
//   - an unsupported filesystem (or a missing helper) refuses installs
//   - validate before the swap: a failing build leaves the running tree untouched
//
//   node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applySeries, buildTree, exportPatches, formatSeries, initRepo, loadSeries, parseSeries, readPatches, readSeries,
  safeDirectoryArgs, saveSeries, SeriesError,
} from '../dist/patches/series.js';
import { patchBinding, seriesDigest, sha256Hex } from '../dist/patches/digest.js';
import { patchFiles, touchedPaths, validatePatch } from '../dist/patches/validate.js';
import { ActivationBusyError, acquireActivation, activationHolder, activationLockPath, heldAppActivations } from '../dist/release/lock.js';
import { Installer, InstallAtomicityError } from '../dist/nexus/Installer.js';
import { NexusManager } from '../dist/nexus/NexusManager.js';
import { payloadHash } from '../dist/approvals/state.js';
import { exchangeHelper } from './rename-exchange-helper.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args]).toString().trim();
const APP = { kind: 'app', appId: 'io.test.app' };

/** An upstream repo, a work tree with two commits on it, and their patches. */
function upstreamWithPatches() {
  const root = mkdtempSync(join(tmpdir(), 'aura-p7-'));
  const repo = join(root, 'upstream');
  put(join(repo, 'a.txt'), 'one\n');
  put(join(repo, 'b.txt'), 'two\n');
  initRepo(repo, 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const ws = join(root, 'ws');
  execFileSync('git', ['clone', '-q', repo, ws]);
  put(join(ws, 'a.txt'), 'one patched\n'); git(ws, 'commit', '-qam', 'patch a');
  put(join(ws, 'b.txt'), 'two patched\n'); git(ws, 'commit', '-qam', 'patch b');
  return { root, repo, base, ws, patches: exportPatches(ws, base) };
}

// ── series v2 ────────────────────────────────────────────────────────────────

test('series v2: saves target, sha256 and enabled; a v1 file reads as v2; the next save writes v2', () => {
  const u = upstreamWithPatches();
  const store = join(u.root, 'store');
  const saved = saveSeries(store, { target: APP, base: { repository: u.repo, commit: u.base }, patches: u.patches, message: 's' });
  const text = readFileSync(join(store, 'aura-patches.yaml'), 'utf8');
  assert.match(text, /^  "v": 2,$/m, 'v2, written as JSON (YAML too; the builder reads it without a YAML parser)');
  assert.match(text, /"kind": "app"/);
  assert.equal(saved.series.patches.every((p) => /^[0-9a-f]{64}$/.test(p.sha256) && p.enabled === true), true);
  assert.deepEqual(parseSeries(formatSeries(saved.series)), saved.series, 'round trip');
  // v1 (Track P): app + file/subject only.
  const v1 = parseSeries(`app: io.test.app\nbase: { commit: ${u.base} }\npatches:\n  - { file: patches/0001-x.patch, subject: x }\n`);
  assert.deepEqual(v1.target, { kind: 'app', appId: 'io.test.app' });
  assert.deepEqual([v1.v, v1.patches[0].enabled, v1.patches[0].sha256], [2, true, undefined]);
  // A v2 file must be valid v2 (no silent fallback to v1).
  assert.throws(() => parseSeries(`v: 2\napp: io.test.app\nbase: { commit: ${u.base} }\n`), SeriesError);
  // A recorded sha256 that does not match the file is refused.
  writeFileSync(join(store, saved.series.patches[0].file), u.patches[0].content.replace('one patched', 'one tampered'));
  assert.throws(() => readPatches(store, saved.series), /does not match its sha256/);
});

test('series digest: stable across YAML form and subjects; changes with order, a flag, a byte, the base or the target', () => {
  const p = (c, enabled = true) => ({ sha256: sha256Hex(c), enabled });
  const base = { commit: 'a'.repeat(40) };
  const d = seriesDigest({ target: APP, base, patches: [p('x'), p('y')] });
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(seriesDigest({ target: { ...APP, scope: 'user' }, base: { commit: base.commit }, patches: [p('x'), p('y')] }), d, 'scope belongs to the installation');
  assert.notEqual(seriesDigest({ target: APP, base, patches: [p('y'), p('x')] }), d, 'order');
  assert.notEqual(seriesDigest({ target: APP, base, patches: [p('x'), p('y', false)] }), d, 'enabled flag');
  assert.notEqual(seriesDigest({ target: APP, base, patches: [p('x'), p('y!')] }), d, 'one byte');
  assert.notEqual(seriesDigest({ target: APP, base: { commit: 'b'.repeat(40) }, patches: [p('x'), p('y')] }), d, 'base');
  assert.notEqual(seriesDigest({ target: { kind: 'system' }, base, patches: [p('x'), p('y')] }), d, 'target');
  assert.equal(seriesDigest({ target: APP, base, patches: [] }), seriesDigest({ target: APP, base, patches: [] }), 'empty series: fixed');
  // Reading the same series from a re-formatted file with another subject: same digest.
  const u = upstreamWithPatches();
  const store = join(u.root, 'store');
  const s = saveSeries(store, { target: APP, base: { repository: u.repo, commit: u.base }, patches: u.patches, message: 's' });
  const first = loadSeries(store, s.commit).digest;
  const yaml = readFileSync(join(store, 'aura-patches.yaml'), 'utf8').replace(/subject: .*/g, 'subject: "renamed"');
  writeFileSync(join(store, 'aura-patches.yaml'), `# reformatted\n${yaml}`);
  git(store, 'commit', '-qam', 'reformat');
  assert.equal(loadSeries(store, 'HEAD').digest, first);
});

test('enabled: a disabled patch is skipped; an all-disabled series builds the base unchanged', () => {
  const u = upstreamWithPatches();
  const store = join(u.root, 'store');
  const off = u.patches.map((p, i) => ({ ...p, enabled: i !== 0 }));
  const s = saveSeries(store, { target: APP, base: { repository: u.repo, commit: u.base }, patches: off, message: 's' });
  const one = buildTree(join(u.root, 'one'), s.series.base, readPatches(store, s.series, s.commit));
  assert.deepEqual([one.ok, one.applied], [true, 1]);
  assert.equal(readFileSync(join(u.root, 'one', 'a.txt'), 'utf8'), 'one\n');
  assert.equal(readFileSync(join(u.root, 'one', 'b.txt'), 'utf8'), 'two patched\n');
  const none = saveSeries(store, { target: APP, base: s.series.base, patches: u.patches.map((p) => ({ ...p, enabled: false })), message: 'off' });
  const bare = buildTree(join(u.root, 'none'), none.series.base, readPatches(store, none.series, none.commit));
  assert.deepEqual([bare.ok, bare.applied, bare.head], [true, 0, u.base]);
});

// ── validation ───────────────────────────────────────────────────────────────

const diffOf = (path, { mode = '100644', add = 'x', status = 'new', from } = {}) => [
  'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001',
  'Subject: [PATCH] t', '', '---',
  `diff --git a/${from ?? path} b/${path}`,
  ...(status === 'new' ? [`new file mode ${mode}`, 'index 0000000..1111111', '--- /dev/null'] : [`index 1111111..2222222 ${mode}`, `--- a/${from ?? path}`]),
  `+++ b/${path}`, '@@ -0,0 +1 @@', `+${add}`, '-- ', '2.43.0', '',
].join('\n');

test('validatePatch: refuses escapes, git internals, submodules, the series itself, outward symlinks, size; the system trust anchor', () => {
  const refused = (content, target = APP) => validatePatch(content, { target }).refused.map((f) => f.code);
  assert.deepEqual(refused(diffOf('src/ok.ts')), []);
  assert.deepEqual(refused(diffOf('../etc/passwd')), ['path-escape']);
  assert.deepEqual(refused(diffOf('src/../../x')), ['path-escape']);
  assert.ok(refused(diffOf('x').replace('+++ b/x', '+++ /etc/passwd')).includes('absolute-path'));
  assert.deepEqual(refused(diffOf('.git/hooks/pre-commit')), ['git-internal']);
  assert.deepEqual(refused(diffOf('sub/.git/config')), ['git-internal']);
  assert.deepEqual(refused(diffOf('.gitmodules')), ['submodule']);
  assert.deepEqual(refused(diffOf('vendor/lib', { mode: '160000', add: 'Subproject commit abc' })), ['submodule']);
  assert.deepEqual(refused(diffOf('aura-patches.yaml')), ['series-file']);
  assert.deepEqual(refused(diffOf('patches/0001-x.patch')), ['series-file']);
  assert.deepEqual(refused(diffOf('link', { mode: '120000', add: '../../etc/shadow' })), ['symlink-escape']);
  assert.deepEqual(refused(diffOf('link', { mode: '120000', add: '/etc/shadow' })), ['symlink-escape']);
  assert.deepEqual(refused(diffOf('dir/link', { mode: '120000', add: '../sibling' })), [], 'a symlink inside the tree is fine');
  assert.deepEqual(validatePatch(diffOf('big', { add: 'y'.repeat(2000) }), { target: APP, limits: { maxFileBytes: 1000 } }).refused.map((f) => f.code), ['file-too-large']);
  assert.deepEqual(validatePatch(diffOf('big'), { target: APP, limits: { maxPatchBytes: 10 } }).refused.map((f) => f.code), ['patch-too-large']);
  // System target: the release keys and the verifier are never patched (D71).
  assert.deepEqual(refused(diffOf('os/release-keys/maintainer.pub'), { kind: 'system' }), ['trust-anchor']);
  assert.deepEqual(refused(diffOf('os/release-verify.mjs', { status: 'mod' }), { kind: 'system' }), ['trust-anchor']);
  assert.deepEqual(refused(diffOf('os/release-verify.mjs', { status: 'mod' })), [], 'an app has no such anchor');
  // A rename out of the tree counts on both sides.
  assert.ok(refused(diffOf('ok.txt', { status: 'mod', from: '../outside' })).includes('path-escape'));
});

test('validatePatch: flags binaries, mode changes, image inputs and dependency changes for the approval', () => {
  const flags = (content) => validatePatch(content, { target: APP }).flags.map((f) => f.code);
  assert.deepEqual(flags(diffOf('run.sh', { mode: '100755' })), ['mode-change']);
  assert.deepEqual(flags(diffOf('Dockerfile', { status: 'mod' })), ['image-file']);
  assert.deepEqual(flags(diffOf('os/new.sh')), ['image-file']);
  assert.deepEqual(flags(diffOf('package.json', { status: 'mod' })), ['dependencies']);
  assert.deepEqual(flags(diffOf('pnpm-lock.yaml', { status: 'mod' })), ['dependencies']);
  const binary = 'diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/img.png differ\n';
  assert.deepEqual(flags(binary), ['binary']);
  const chmod = 'diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n';
  assert.deepEqual(flags(chmod), ['mode-change']);
  assert.deepEqual(patchFiles(chmod).map((f) => [f.path, f.oldMode, f.newMode]), [['x.sh', '100644', '100755']]);
  assert.deepEqual(touchedPaths([{ content: diffOf('a/b.ts') }, { content: diffOf('new.ts', { status: 'mod', from: 'old.ts' }) }]), ['a/b.ts', 'new.ts', 'old.ts']);
  // A quoted path with an escape.
  const quoted = 'diff --git "a/sp ace\\tx" "b/sp ace\\tx"\nindex 1..2 100644\n--- "a/sp ace\\tx"\n+++ "b/sp ace\\tx"\n@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual(patchFiles(quoted).map((f) => f.path), ['sp ace\tx']);
});

test('save and apply refuse a refused patch (validate on save and before every apply)', () => {
  const u = upstreamWithPatches();
  const evil = { file: 'patches/0003-evil.patch', subject: 'evil', content: diffOf('.git/hooks/post-checkout') };
  assert.throws(() => saveSeries(join(u.root, 'store'), { target: APP, base: { repository: u.repo, commit: u.base }, patches: [...u.patches, evil], message: 's' }),
    /refused patch content: patches\/0003-evil\.patch/);
  const work = join(u.root, 'apply');
  execFileSync('git', ['clone', '-q', u.repo, work]);
  assert.throws(() => applySeries(work, [{ ...evil, enabled: true }]), SeriesError);
  assert.equal(git(work, 'rev-parse', 'HEAD'), u.base, 'nothing applied');
});

test('safeDirectoryArgs trusts the system patch store root (7b)', () => {
  const data = mkdtempSync(join(tmpdir(), 'aura-p7-data-'));
  const before = process.env['AURA_DATA_DIR'];
  process.env['AURA_DATA_DIR'] = data;
  try {
    const dir = join(data, 'patches', 'system');
    assert.deepEqual(safeDirectoryArgs(dir + '/x'), ['-c', `safe.directory=${dir}/x`]);
    assert.deepEqual(safeDirectoryArgs(join(data, 'patches', 'systemx', 'y')), []);
  } finally {
    if (before === undefined) delete process.env['AURA_DATA_DIR']; else process.env['AURA_DATA_DIR'] = before;
  }
});

// ── approval binding ─────────────────────────────────────────────────────────

test('binding: base, revision, order, a flag or one byte change the payload an approval is bound to', () => {
  const p = (c, enabled = true) => ({ sha256: sha256Hex(c), enabled });
  const target = { kind: 'app', appId: 'io.test.app', scope: 'global' };
  const series = { target: APP, base: { commit: 'a'.repeat(40) }, patches: [p('x'), p('y')] };
  const install = (patch) => ({ action: 'app.patch.activate', appId: 'io.test.app', digest: 't', scope: 'global', patch });
  const approved = payloadHash(install(patchBinding(series, 'r1', { target })));
  const variants = {
    base: patchBinding({ ...series, base: { commit: 'b'.repeat(40) } }, 'r1', { target }),
    revision: patchBinding(series, 'r2', { target }),
    order: patchBinding({ ...series, patches: [p('y'), p('x')] }, 'r1', { target }),
    flag: patchBinding({ ...series, patches: [p('x'), p('y', false)] }, 'r1', { target }),
    byte: patchBinding({ ...series, patches: [p('x'), p('y ')] }, 'r1', { target }),
    target: patchBinding(series, 'r1', { target: { ...target, scope: 'user' } }),
  };
  for (const [what, b] of Object.entries(variants)) assert.notEqual(payloadHash(install(b)), approved, what);
  assert.equal(payloadHash(install(patchBinding(series, 'r1', { target }))), approved, 'the same binding hashes the same');
  const b = patchBinding({ ...series, patches: [p('x'), p('y', false)] }, 'r1', { target });
  assert.deepEqual([b.order.length, b.disabled.length], [1, 1]);
});

// ── activation lock ──────────────────────────────────────────────────────────

test('lock: a second activation of the same target is busy; other targets run in parallel; release frees it', () => {
  const data = mkdtempSync(join(tmpdir(), 'aura-lock-'));
  const a = acquireActivation(data, 'app:global:io.test.app', { by: 'app.patch.activate' });
  assert.throws(() => acquireActivation(data, 'app:global:io.test.app'), (err) => err instanceof ActivationBusyError
    && err.code === 'activation-busy' && err.heldBy.jobId === a.holder.jobId && err.heldBy.by === 'app.patch.activate');
  const other = acquireActivation(data, 'app:global:io.other.app');
  const user = acquireActivation(data, 'app:user:io.test.app');
  assert.deepEqual(heldAppActivations(data).map((h) => h.appId).sort(), ['io.other.app', 'io.test.app', 'io.test.app']);
  a.release(); a.release();
  assert.equal(activationHolder(data, 'app:global:io.test.app'), null);
  acquireActivation(data, 'app:global:io.test.app').release();
  other.release(); user.release();
  assert.equal(activationLockPath(data, 'system'), join(data, 'aura', 'release', 'lock'), 'the system target keeps Phase 6\'s path');
  assert.throws(() => activationLockPath(data, 'app:global:../../x'), /invalid activation target/);
});

test('lock: a holder whose process is gone is stale and taken over; a foreign host only by isStale', () => {
  const data = mkdtempSync(join(tmpdir(), 'aura-lock-'));
  const path = activationLockPath(data, 'app:user:io.test.app');
  mkdirSync(join(path, '..'), { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  writeFileSync(path, JSON.stringify({ jobId: 'old', pid: Number(dead), host: (await_hostname()), start: null, at: 1 }));
  const l = acquireActivation(data, 'app:user:io.test.app');
  assert.notEqual(l.holder.jobId, 'old');
  l.release();
  writeFileSync(path, JSON.stringify({ jobId: 'updater', pid: 1, host: 'aura-updater', start: null, at: 1 }));
  assert.throws(() => acquireActivation(data, 'app:user:io.test.app'), ActivationBusyError);
  acquireActivation(data, 'app:user:io.test.app', {}, { isStale: (h) => h.host === 'aura-updater' }).release();
});
function await_hostname() { return execFileSync('hostname').toString().trim(); }

// ── atomic switch, crash recovery ────────────────────────────────────────────

const ID = 'io.test.app';
const manifest = (version) => ({ id: ID, name: 'App', version });
const resolved = { source: 'local', rawRef: '/src', digest: 'd' };

function scopeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'aura-xchg-'));
  const appsDir = join(root, 'apps'), dataDir = join(root, 'data');
  const stage = (version) => {
    const dir = mkdtempSync(join(root, 'stage-'));
    put(join(dir, 'app.manifest.json'), JSON.stringify(manifest(version)));
    put(join(dir, 'index.js'), `v${version}\n`);
    return dir;
  };
  return { root, appsDir, dataDir, stage, appDir: join(appsDir, ID), installer: new Installer({ exchangeHelper: exchangeHelper(), appsDir, dataDir, scope: 'user' }) };
}

/** Install `version` in a child process that dies (SIGKILL) at `point`. */
function crashAt(w, version, point) {
  const stage = w.stage(version);
  const script = `
    import { Installer } from ${JSON.stringify(join(HERE, '..', 'dist', 'nexus', 'Installer.js'))};
    const i = new Installer({ exchangeHelper: ${JSON.stringify(exchangeHelper())}, appsDir: ${JSON.stringify(w.appsDir)}, dataDir: ${JSON.stringify(w.dataDir)}, scope: 'user',
      fault: (p) => { if (p === ${JSON.stringify(point)}) process.kill(process.pid, 'SIGKILL'); } });
    await i.install(${JSON.stringify(stage)}, ${JSON.stringify(manifest(version))}, ${JSON.stringify(resolved)});
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.signal, 'SIGKILL', `the install died at ${point}: ${r.stderr}`);
}

const leftovers = (w) => readdirSync(w.appsDir).filter((n) => n.includes('.tmp.'));
const journal = (w) => (existsSync(join(w.dataDir, 'nexus', 'journal')) ? readdirSync(join(w.dataDir, 'nexus', 'journal')).filter((n) => n.endsWith('.json')) : []);

for (const [point, expect] of [
  ['installer:after-stage', 'old'], ['installer:after-carry', 'old'], ['installer:after-exchange', 'new'], ['installer:after-record', 'new'],
]) {
  test(`crash at ${point}: reconcile leaves the complete ${expect} tree, the data once, no tmp, no journal`, async () => {
    const w = scopeWorld();
    await w.installer.install(w.stage('1.0.0'), manifest('1.0.0'), resolved);
    put(join(w.appDir, ID, 'notes.json'), '[1]');          // an instance's data
    put(join(w.appDir, '.sidecars', 'db', 'x'), 'db');
    crashAt(w, '2.0.0', point);
    assert.equal(journal(w).length, 1, 'the journal survived the crash');

    const results = w.installer.reconcile();
    assert.deepEqual(results.map((r) => [r.appId, r.outcome]), [[ID, expect === 'old' ? 'undone' : 'completed']]);
    assert.equal(readFileSync(join(w.appDir, 'index.js'), 'utf8'), expect === 'old' ? 'v1.0.0\n' : 'v2.0.0\n');
    assert.equal(JSON.parse(readFileSync(join(w.appDir, 'app.manifest.json'), 'utf8')).version, expect === 'old' ? '1.0.0' : '2.0.0');
    assert.equal(readFileSync(join(w.appDir, ID, 'notes.json'), 'utf8'), '[1]', 'data in place');
    assert.equal(readFileSync(join(w.appDir, '.sidecars', 'db', 'x'), 'utf8'), 'db');
    assert.deepEqual(leftovers(w), []);
    assert.deepEqual(journal(w), []);
    const record = JSON.parse(readFileSync(join(w.dataDir, 'nexus', 'installed', `${ID}.json`), 'utf8'));
    assert.equal(record.version, expect === 'old' ? '1.0.0' : '2.0.0', 'the record matches the tree');
    if (expect === 'new') {
      const trash = readdirSync(join(w.dataDir, 'nexus', 'trash'));
      assert.equal(trash.length, 1);
      assert.equal(readFileSync(join(w.dataDir, 'nexus', 'trash', trash[0], 'index.js'), 'utf8'), 'v1.0.0\n', 'the old tree is the rollback tree');
      assert.equal(existsSync(join(w.dataDir, 'nexus', 'trash', trash[0], ID)), false, 'the data is not in the trash');
    }
    assert.deepEqual(w.installer.reconcile(), [], 'idempotent');
  });
}

test('crash during a first install: recovery leaves no app (before the rename) or the complete app (after)', async () => {
  for (const [point, present] of [['installer:after-stage', false], ['installer:after-exchange', true]]) {
    const w = scopeWorld();
    crashAt(w, '1.0.0', point);
    w.installer.reconcile();
    assert.equal(existsSync(join(w.appDir, 'app.manifest.json')), present, point);
    assert.deepEqual(leftovers(w), []);
    assert.deepEqual(journal(w), []);
  }
});

test('the switch is one exchange: apps/<id> is never absent, and the old inode becomes the trash entry', async () => {
  const w = scopeWorld();
  await w.installer.install(w.stage('1.0.0'), manifest('1.0.0'), resolved);
  const before = statSync(w.appDir).ino;
  await w.installer.install(w.stage('2.0.0'), manifest('2.0.0'), resolved);
  const trash = readdirSync(join(w.dataDir, 'nexus', 'trash'));
  assert.equal(statSync(join(w.dataDir, 'nexus', 'trash', trash[0])).ino, before);
  assert.notEqual(statSync(w.appDir).ino, before);
});

test('an unsupported filesystem or a missing helper refuses installs (fail closed, no two-rename fallback)', async () => {
  const w = scopeWorld();
  const fake = join(w.root, 'fake-exchange');
  writeFileSync(fake, '#!/bin/sh\necho "aura-rename-exchange: exchange x: Invalid argument" >&2\nexit 3\n');
  chmodSync(fake, 0o755);
  const refusing = new Installer({ exchangeHelper: fake, appsDir: w.appsDir, dataDir: w.dataDir, scope: 'user' });
  assert.match(refusing.probeAtomic().reason, /does not support an atomic exchange/);
  await assert.rejects(refusing.install(w.stage('1.0.0'), manifest('1.0.0'), resolved),
    (err) => err instanceof InstallAtomicityError && err.code === 'install-not-atomic');
  assert.equal(existsSync(w.appDir), false, 'nothing installed');
  const missing = new Installer({ exchangeHelper: join(w.root, 'nope'), appsDir: w.appsDir, dataDir: w.dataDir, scope: 'user' });
  assert.match(missing.probeAtomic().reason, /helper .* is missing/);
  // The real helper on this filesystem passes.
  assert.deepEqual(w.installer.probeAtomic(), { ok: true });
});

// ── the install pipeline: lock, build before the swap ────────────────────────

function nexusWorld(prepare) {
  const root = mkdtempSync(join(tmpdir(), 'aura-p7n-'));
  const scope = (id, priority, immutable) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority });
  const scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  const mgr = new NexusManager({ exchangeHelper: exchangeHelper(), scopes, rootDataDir: join(root, 'root'), ...(prepare ? { prepare } : {}) });
  const release = (version, body) => {
    const dir = mkdtempSync(join(root, 'rel-'));
    put(join(dir, 'app.manifest.json'), JSON.stringify({ id: ID, originId: '00000000-0000-4000-8000-000000000001', name: 'App', version }));
    put(join(dir, 'index.js'), body);
    return dir;
  };
  let first = true;
  const run = async (ref, opts = {}) => {
    // Later releases come from another path: the same app, updated (identity answered).
    const identity = first ? {} : { identity: { action: 'update-existing' } };
    const it = mgr.install({ ref, scope: 'global', approval: async () => true, ...identity, ...opts });
    first = false;
    for (let c = await it.next(); !c.done; c = await it.next()) { /* to the end */ }
  };
  return { root, mgr, release, run, appDir: join(scopes[1].appsDir, ID) };
}

test('pipeline: an activation of an app whose lock is held is refused activation-busy before anyone is asked', async () => {
  const w = nexusWorld();
  await w.run(w.release('1.0.0', 'one'));
  const held = acquireActivation(join(w.root, 'root'), 'app:global:io.test.app', { by: 'nexus.update' });
  let asked = false;
  await assert.rejects(w.run(w.release('2.0.0', 'two'), { approval: async () => { asked = true; return true; } }),
    (err) => err.code === 'activation-busy');
  assert.equal(asked, false);
  assert.equal(w.mgr.isInstalling(ID), true, 'the store shows it as installing');
  held.release();
  await w.run(w.release('2.0.0', 'two'));
  assert.equal(readFileSync(join(w.appDir, 'index.js'), 'utf8'), 'two');
  assert.equal(activationHolder(join(w.root, 'root'), 'app:global:io.test.app'), null, 'released after the install');
});

test('pipeline: validate before the swap — after the approval, a failing build installs nothing; a good one installs the built tree', async () => {
  const calls = [];
  let fail = true;
  const w = nexusWorld(async (appId, dir, manifest) => {
    calls.push({ appId, dir, exists: existsSync(join(dir, 'app.manifest.json')), version: manifest.version });
    if (fail) return { ok: false, step: 'build', output: 'error TS2304: Cannot find name x', provisioned: true, built: false };
    put(join(dir, 'dist', 'server.mjs'), 'built');
    return { ok: true, output: '', provisioned: true, built: true, lockfileHash: null, builderImage: 'aura-base' };
  });
  fail = false;
  await w.run(w.release('1.0.0', 'one'));
  fail = true;
  let approvedFirst = false;
  await assert.rejects(w.run(w.release('2.0.0', 'two'), { approval: async () => { approvedFirst = calls.length === 1; return true; } }),
    (err) => err.code === 'install-prepare-failed' && err.step === 'build' && /nothing was installed/.test(err.message));
  assert.equal(approvedFirst, true, 'the build ran after the approval was consumed');
  assert.equal(calls[1].exists, true, 'the staged tree was built in place');
  assert.equal(readFileSync(join(w.appDir, 'index.js'), 'utf8'), 'one', 'the running tree is untouched');
  assert.equal(existsSync(join(w.root, 'global', 'data', 'nexus', 'trash')), false, 'no trash entry: nothing moved');
  fail = false;
  await w.run(w.release('2.0.0', 'two'));
  assert.equal(readFileSync(join(w.appDir, 'dist', 'server.mjs'), 'utf8'), 'built', 'the built output is installed with the tree');
});

test('pipeline: the patch binding is part of the install binding and the record keeps the series facts', async () => {
  const w = nexusWorld();
  await w.run(w.release('1.0.0', 'one'));
  const patch = patchBinding({ target: APP, base: { commit: 'a'.repeat(40) }, patches: [{ sha256: sha256Hex('x'), enabled: true }] }, 'f'.repeat(40),
    { target: { ...APP, scope: 'global' } });
  let bound = null;
  const it = w.mgr.install({ ref: w.release('1.0.1', 'patched'), scope: 'global', action: 'app.patch.activate', patch, approval: async (b) => { bound = b; return true; } });
  let c; for (c = await it.next(); !c.done; c = await it.next()) { /* to the end */ }
  assert.deepEqual(bound.patch, patch);
  const record = JSON.parse(readFileSync(join(w.root, 'global', 'data', 'nexus', 'installed', `${ID}.json`), 'utf8'));
  assert.deepEqual([record.patched.seriesRev, record.patched.seriesDigest, record.patched.baseCommit, record.patched.patches],
    [patch.seriesRev, patch.seriesDigest, patch.baseCommit, 1]);
  assert.equal(record.patched.treeDigest, bound.digest);
  // A later plain install drops it.
  await w.run(w.release('1.0.2', 'plain'));
  assert.equal(JSON.parse(readFileSync(join(w.root, 'global', 'data', 'nexus', 'installed', `${ID}.json`), 'utf8')).patched, undefined);
});

test('pipeline: reconcileInstalls covers every writable scope', async () => {
  const w = nexusWorld();
  assert.deepEqual(w.mgr.reconcileInstalls(), []);
  assert.deepEqual(w.mgr.atomicInstallState().map((s) => [s.scope, s.ok]), [['global', true], ['user', true]]);
});
