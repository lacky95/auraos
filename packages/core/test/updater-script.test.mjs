/**
 * The updater is generated shell executed inside a throwaway container, so
 * the type checker can prove nothing about it and a mistake only surfaces
 * mid-update on a real machine — the worst possible place. Two bugs already
 * shipped this way: a backtick in a comment silently truncated the template,
 * and a variable that only the `update` path assigns aborted a successful
 * rebuild under `set -u` right before it could record its result.
 *
 * So: render the script for every mode and RUN it, with docker/git/curl
 * replaced by stubs. Anything that reaches the end must leave the job file
 * with the final acknowledgement written — which is exactly what the two bugs
 * above would have failed.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderUpdaterScript, UPDATE_STEPS } from '../dist/index.js';

/** A fake `docker`/`git`/`curl` that answers plausibly and changes nothing. */
function stubBin(dir) {
  mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  };
  // Container ids differ before/after the rebuild so `recreate` verifies true.
  write('docker', `
case "$*" in
  *"inspect -f {{.Id}}"*)          [ -f /tmp/rebuilt ] && echo newidnewidnewid || echo oldidoldidoldid ;;
  *"inspect -f {{.State.Running}}"*) echo true ;;
  *"inspect -f {{.State.StartedAt}}"*) [ -f /tmp/restarted ] && echo 2026-01-01T00:00:01Z || echo 2026-01-01T00:00:00Z ;;
  *"compose version"*)             echo 2.40.3 ;;
  *"compose"*up*)                  touch /tmp/rebuilt; echo "Container aura-shell Recreated" ;;
  *restart*)                       touch /tmp/restarted; echo aura-shell ;;
  *logs*)                          echo "some build output" ;;
  *)                               echo "docker $*" ;;
esac`);
  write('git', `
case "$*" in
  *"rev-parse --git-dir"*)     echo .git ;;
  *"status --porcelain"*)      : ;;                       # clean tree
  *"rev-parse --abbrev-ref"*)  echo main ;;
  *"rev-parse HEAD"*)          [ -f /tmp/rebased ] && echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb || echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  *"rev-parse FETCH_HEAD"*)    echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  *fetch*)                     : ;;
  *"rev-list --count"*)        echo 0 ;;
  *rebase*)                    touch /tmp/rebased ;;
  *)                           : ;;
esac`);
  write('curl', 'echo 200');            // health check always answers
  write('stat',  'echo 1000:1000');     // workspace owner
  write('chown', 'true');
  return dir;
}

function runMode(mode, { dryRun = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'aura-updater-'));
  const jobFile = join(work, 'job.json');
  const logFile = join(work, 'job.log');
  // Seed the job the way SelfUpdater.start() does: `action` records which
  // button was pressed and is already done before the script runs.
  writeFileSync(jobFile, JSON.stringify({
    id: 'test', phase: 'queued', mode, branch: 'main', dryRun,
    steps: UPDATE_STEPS.map((s) => (s.key === 'action'
      ? { ...s, status: 'done', detail: `${mode} (test)` }
      : { ...s, status: 'pending' })),
    log: [],
  }, null, 2));

  const script = renderUpdaterScript({
    jobFile, logFile, fetchUrl: 'https://example.invalid/repo.git', mode, branch: 'main', dryRun,
  });
  const scriptFile = join(work, 'run.sh');
  writeFileSync(scriptFile, script);

  // Syntax first: a truncated template fails here with a clear message.
  execFileSync('bash', ['-n', scriptFile], { stdio: ['ignore', 'pipe', 'pipe'] });

  for (const f of ['/tmp/rebuilt', '/tmp/restarted', '/tmp/rebased']) rmSync(f, { force: true });
  const bin = stubBin(join(work, 'bin'));
  let status = 0;
  try {
    execFileSync('bash', [scriptFile], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  } catch (err) {
    status = err.status ?? 1;
  }
  const job = JSON.parse(readFileSync(jobFile, 'utf-8'));
  rmSync(work, { recursive: true, force: true });
  return { status, job, step: (k) => job.steps.find((s) => s.key === k) };
}

for (const mode of ['update', 'rebuild', 'restart']) {
  test(`updater script completes and acknowledges: ${mode}`, () => {
    const { status, job, step } = runMode(mode);
    assert.equal(status, 0, `script exited ${status} for mode=${mode}`);
    // The regression that started this test: the run did its work but died
    // before recording it, leaving the job stuck on its last phase.
    assert.equal(step('complete').status, 'done',
      `mode=${mode} never acknowledged completion (phase left at "${job.phase}")`);
    assert.equal(job.phase, 'done', `mode=${mode} ended in phase "${job.phase}"`);
    assert.equal(step('action').status, 'done', 'the script must not clobber the recorded action');
    assert.ok(!job.steps.some((s) => s.status === 'running'),
      `mode=${mode} left a step marked running: ${job.steps.filter((s) => s.status === 'running').map((s) => s.key)}`);
  });
}

test('dry run stops before touching the container, and still acknowledges', () => {
  const { status, step } = runMode('update', { dryRun: true });
  assert.equal(status, 0);
  assert.equal(step('complete').status, 'done');
  assert.equal(step('build').status, 'skipped');
  assert.equal(step('recreate').status, 'skipped');
});

test('rebuild and restart do not touch git', () => {
  for (const mode of ['rebuild', 'restart']) {
    const { step } = runMode(mode);
    for (const key of ['inspect', 'fetch', 'rebase']) {
      assert.equal(step(key).status, 'skipped', `${mode} should skip ${key}`);
    }
  }
});
