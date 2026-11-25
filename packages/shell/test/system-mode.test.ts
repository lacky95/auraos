// D60: the system mode (lib/systemMode.ts) and its routes' refusals that need
// no owner: the default and the overrides, the clean-tree listing, the patch
// export, the automatic clean-up to a dev/<date> branch, and the Developer
// Mode gate of `aura dev rebuild|restart`.
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SYSTEM_MODE, devBackupsDir, exportPatches, moveToDevBranch, pruneDevBackups, systemMode,
  systemModeFile, systemModeState, workspaceTree, writeSystemMode,
} from '../src/lib/systemMode.ts';
import { PUT as systemModePut } from '../src/pages/api/admin/system-mode.ts';
import { POST as devRestartPost } from '../src/pages/api/admin/dev/restart.ts';

let root: string;
let ws: string;
const saved = { data: process.env['AURA_DATA_DIR'], ws: process.env['AURA_WORKSPACE_DIR'], mode: process.env['AURA_SYSTEM_MODE'] };

const git = (...args: string[]) => execFileSync('git', ['-C', ws, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf-8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aura-sysmode-'));
  ws = join(root, 'ws');
  mkdirSync(ws);
  process.env['AURA_DATA_DIR'] = join(root, 'data');
  process.env['AURA_WORKSPACE_DIR'] = ws;
  delete process.env['AURA_SYSTEM_MODE'];
  git('init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'a.txt'), 'one\n');
  writeFileSync(join(ws, '.gitignore'), 'node_modules/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'release');
  git('remote', 'add', 'origin', 'https://example.invalid/aura.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [['AURA_DATA_DIR', saved.data], ['AURA_WORKSPACE_DIR', saved.ws], ['AURA_SYSTEM_MODE', saved.mode]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function dirty(): void {
  writeFileSync(join(ws, 'a.txt'), 'two\n');                      // uncommitted
  writeFileSync(join(ws, 'b.txt'), 'local\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'local work');                          // a local commit
  writeFileSync(join(ws, 'new.txt'), 'untracked\n');               // untracked
  mkdirSync(join(ws, 'node_modules'));
  writeFileSync(join(ws, 'node_modules', 'x.js'), 'ignored\n');    // ignored: never listed, never touched
}

test('the mode: developer by default (until Phase 6), the switch file, AURA_SYSTEM_MODE wins', () => {
  assert.equal(DEFAULT_SYSTEM_MODE, 'developer');
  assert.deepEqual(systemModeState(), { mode: 'developer', configured: null, env: null, default: 'developer', normalEnforced: false });
  writeSystemMode('normal');
  assert.equal(readFileSync(systemModeFile(), 'utf8'), 'normal\n');
  assert.equal(systemModeState().mode, 'normal');
  assert.equal(systemMode(), 'normal', 'a write drops the cache');
  process.env['AURA_SYSTEM_MODE'] = 'developer';
  assert.deepEqual([systemModeState().mode, systemModeState().env, systemModeState().configured], ['developer', 'developer', 'normal']);
  process.env['AURA_SYSTEM_MODE'] = 'bogus';
  assert.equal(systemModeState().mode, 'normal', 'an invalid override is ignored');
  writeFileSync(systemModeFile(), 'root\n');
  delete process.env['AURA_SYSTEM_MODE'];
  assert.equal(systemModeState().mode, 'developer', 'an invalid file falls back to the default');
});

test('workspaceTree: clean at the release; lists uncommitted, untracked and local commits, never ignored files', () => {
  const clean = workspaceTree();
  assert.equal(clean.clean, true);
  assert.equal(clean.branch, 'main');
  assert.equal(clean.release?.ref, 'origin/main');
  dirty();
  const t = workspaceTree();
  assert.equal(t.clean, false);
  assert.deepEqual(t.uncommitted, ['a.txt']);
  assert.deepEqual(t.untracked, ['new.txt']);
  assert.deepEqual(t.localCommits.map((c) => c.subject), ['local work']);
  assert.deepEqual(t.counts, { uncommitted: 1, untracked: 1, localCommits: 1 });
});

test('workspaceTree: no fetched remote main means no release, and no git means no tree', () => {
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(workspaceTree().release, null);
  rmSync(join(ws, '.git'), { recursive: true, force: true });
  assert.equal(workspaceTree().git, false);
});

test('exportPatches: commits as format-patch files, uncommitted and untracked diffs, a README; the tree is unchanged', () => {
  dirty();
  const before = execFileSync('git', ['-C', ws, 'status', '--porcelain'], { encoding: 'utf-8' });
  const out = exportPatches();
  assert.ok(out.dir.startsWith(join(root, 'data', 'aura', 'dev-patches')));
  assert.deepEqual(out.files.map((f) => f.replace(/^commits\/0001-.*$/, 'commits/0001')).sort(), ['README.txt', 'commits/0001', 'uncommitted.diff', 'untracked.diff']);
  assert.match(readFileSync(join(out.dir, 'uncommitted.diff'), 'utf8'), /^\+two$/m);
  assert.match(readFileSync(join(out.dir, 'untracked.diff'), 'utf8'), /new\.txt[\s\S]*\+untracked/);
  assert.doesNotMatch(readFileSync(join(out.dir, 'untracked.diff'), 'utf8'), /node_modules/);
  assert.equal(execFileSync('git', ['-C', ws, 'status', '--porcelain'], { encoding: 'utf-8' }), before);
});

test('moveToDevBranch: everything on dev/<date>, a backup, main reset to the release, ignored files kept', () => {
  dirty();
  const release = git('rev-parse', 'refs/remotes/origin/main');
  const r = moveToDevBranch(new Date('2026-11-25T18:30:05Z'));
  assert.equal(r.branch, 'dev/2026-11-25T18-30-05');
  assert.equal(git('rev-parse', 'HEAD'), release, 'reset to the release');
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git('status', '--porcelain'), '', 'clean');
  assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(existsSync(join(ws, 'node_modules', 'x.js')), 'ignored files stay');
  // The branch holds all of it.
  assert.equal(git('show', `${r.branch}:a.txt`), 'two');
  assert.equal(git('show', `${r.branch}:b.txt`), 'local');
  assert.equal(git('show', `${r.branch}:new.txt`), 'untracked');
  assert.ok(existsSync(join(r.backup, 'dev.bundle')));
  assert.ok(existsSync(join(r.backup, 'patches', 'README.txt')));
  assert.equal(workspaceTree().clean, true);
  assert.throws(() => moveToDevBranch(new Date('2026-11-25T18:30:05Z')), /exists already/);
});

test('moveToDevBranch: on another branch, main\'s own commits are kept on a branch too', () => {
  writeFileSync(join(ws, 'm.txt'), 'main work\n');
  git('add', 'm.txt');
  git('commit', '-q', '-m', 'main work');
  git('checkout', '-q', '-b', 'feature', 'refs/remotes/origin/main');
  writeFileSync(join(ws, 'f.txt'), 'feature\n');
  const r = moveToDevBranch(new Date('2026-11-25T19:00:00Z'));
  assert.equal(r.mainBranch, 'dev/2026-11-25T19-00-00-main');
  assert.equal(git('show', `${r.mainBranch}:m.txt`), 'main work');
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
});

test('moveToDevBranch: refused without a known release', () => {
  git('update-ref', '-d', 'refs/remotes/origin/main');
  writeFileSync(join(ws, 'a.txt'), 'two\n');
  assert.throws(() => moveToDevBranch(), /no release commit is known/);
  assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'two\n', 'nothing changed');
});

test('pruneDevBackups: only backups older than 30 days go', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  for (const [name, days] of [['old', 31], ['recent', 29]] as const) {
    const p = join(devBackupsDir(), name);
    mkdirSync(p, { recursive: true });
    const t = new Date(now.getTime() - days * 86_400_000);
    utimesSync(p, t, t);
  }
  assert.deepEqual(pruneDevBackups(now), ['old']);
  assert.deepEqual(readdirSync(devBackupsDir()), ['recent']);
});

const put = (body: unknown) => new Request('http://x/api/admin/system-mode', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('PUT system-mode: bad bodies are 400; switching off with a tree that differs is 409 with the list and the recommendations', async () => {
  const status = async (body: unknown) => (await systemModePut({ request: put(body) } as never) as Response).status;
  assert.equal(await status({ mode: 'root' }), 400);
  assert.equal(await status({ mode: 'normal', cleanup: 'reset' }), 400);
  assert.equal(await status({ mode: 'developer', cleanup: 'branch' }), 400);
  dirty();
  const r = await systemModePut({ request: put({ mode: 'normal' }) } as never) as Response;
  assert.equal(r.status, 409);
  const body = await r.json() as { error: string; tree: { counts: unknown }; recommend: Array<{ step: string }> };
  assert.equal(body.error, 'tree-not-clean');
  assert.deepEqual(body.tree.counts, { uncommitted: 1, untracked: 1, localCommits: 1 });
  assert.deepEqual(body.recommend.map((s) => s.step), ['a', 'b', 'c']);
  assert.equal(systemModeState().mode, 'developer', 'the mode is unchanged');
});

test('aura dev rebuild|restart: refused outside Developer Mode, before anyone is asked', async () => {
  process.env['AURA_SYSTEM_MODE'] = 'normal';
  const r = await devRestartPost({
    request: new Request('http://x/api/admin/dev/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"build":true}' }),
  } as never) as Response;
  assert.equal(r.status, 409);
  assert.equal((await r.json() as { error: string }).error, 'not-developer-mode');
});
