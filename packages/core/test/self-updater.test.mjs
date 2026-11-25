// SelfUpdater reads (the Settings → About status, `GET /api/admin/self-update`)
// never write, a job id is never a path, and a branch is never a git option.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfUpdater, UPDATE_BRANCH_RE, UPDATE_JOB_ID_RE } from '../dist/updater/SelfUpdater.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-self-updater-'));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const u = new SelfUpdater(DATA_DIR);
const ID = '2020-01-01T10-00-00-000Z';

test('a job id is a timestamp, never a path; a branch never an option', () => {
  assert.ok(UPDATE_JOB_ID_RE.test(ID));
  for (const bad of ['../../secrets/admin', '..', '', 'x.json', `${ID}/../x`]) assert.equal(UPDATE_JOB_ID_RE.test(bad), false, bad);
  assert.ok(UPDATE_BRANCH_RE.test('main') && UPDATE_BRANCH_RE.test('phase3/C'));
  for (const bad of ['--upload-pack=touch /tmp/x', '-u', 'a b', '']) assert.equal(UPDATE_BRANCH_RE.test(bad), false, bad);
});

test('readJob and readLog refuse an id that is not a job id', () => {
  mkdirSync(join(DATA_DIR, 'aura'), { recursive: true });
  writeFileSync(join(DATA_DIR, 'aura', 'outside.json'), JSON.stringify({ id: 'x', phase: 'done', steps: [], log: [] }));
  writeFileSync(join(DATA_DIR, 'aura', 'outside.log'), 'not a transcript');
  assert.equal(u.readJob('../outside'), null);
  assert.equal(u.readLog('../outside'), null);
});

test('reading an abandoned job shows it closed without writing the file', () => {
  const dir = u.jobsDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ID}.json`);
  const stored = JSON.stringify({
    id: ID, phase: 'building', startedAt: '2020-01-01T10:00:00.000Z', mode: 'update', branch: 'main', dryRun: false,
    steps: [{ key: 'complete', status: 'pending' }], log: [],
  }, null, 2);
  writeFileSync(file, stored);
  // The updater container is gone (docker is unreachable in tests): the read says failed...
  assert.equal(u.readJob(ID)?.phase, 'failed');
  assert.equal(u.readJob()?.phase, 'failed');
  assert.equal(u.isRunning(), false);
  // ...and the file is untouched.
  assert.equal(readFileSync(file, 'utf-8'), stored);
});

test('preflight and start refuse a branch that could be a git option, before running git', () => {
  const pre = u.preflight('--upload-pack=touch /tmp/x');
  assert.deepEqual(pre.blockers, ['Invalid branch name: --upload-pack=touch /tmp/x']);
  const res = u.start({ branch: '-u', dryRun: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Invalid branch name/);
});
