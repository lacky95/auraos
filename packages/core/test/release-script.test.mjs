// Phase 6 stream U: the updater's release program (SelfUpdater modes
// `release` and `rollback`), RUN with a fake docker/curl against a real data
// root and the real os/release/activate.mjs: the activation reaches "accepting
// writes"; a release that fails before that is rolled back with its data
// (the marker key is gone); a rollback restores the data only when chosen; a
// second job is refused by the lock. Like updater-script.test.mjs, this is
// generated shell: only running it proves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, V, tmp, write } from './release-fixtures.mjs';
import { RELEASE_STEPS, renderReleaseScript } from '../dist/index.js';

const LAYOUT = await import(join(ROOT, 'os/release/layout.mjs'));
const A = await import(join(ROOT, 'os/release/activate.mjs'));
const ACT = join(ROOT, 'os/release/activate.mjs');
const JOB = '2026-11-27T12-00-00-000Z';
const AID = 'main-aaaaaaaaaaaa-11111111';
const BID = 'main-bbbbbbbbbbbb-22222222';

function putRelease(data, id, apps = {}) {
  const dir = LAYOUT.layout(data).release(id);
  write(dir, 'package.json', `{"name":"aura","release":"${id}"}\n`);
  const rec = {
    v: 1, id, version: null, commit: 'c'.repeat(40), gitTree: 't'.repeat(40), channel: 'main', maturity: null,
    meta: { signed: false, metaDigest: null, securityUpdate: false }, provenance: 'upstream-unsigned',
    series: { digest: 'sha256:0', base: null, order: [] }, composition: 'desktop',
    components: { source: Object.entries(apps).map(([name, tree]) => ({ name, kind: 'app', path: `apps/${name}`, tree })), built: [], deployed: [], skipped: [] },
    images: { shell: 'aura-shell:same', base: 'aura-base:x', target: 'release' },
    node: { required: null, base: 'v22', shell: 'v22' }, lockfileHash: null, infraDigest: null, auraContract: 1, ari: 1,
    builtAt: 'x', builderJob: JOB, treeDigest: `sha256:${V.gitTreeOfDir(dir, { algo: 'sha256', skip: ['release.json', '.complete'] })}`,
  };
  writeFileSync(join(dir, 'release.json'), JSON.stringify(rec));
  writeFileSync(join(dir, '.complete'), 'x\n');
}

/**
 * A fake docker: stop/start flip a state file; `start` boots "the kernel" of
 * whatever release the pointer names (status.json), and a release listed in
 * FAIL_RELEASE writes a marker key and fails its boot.
 */
function stubs(dir, data) {
  mkdirSync(dir, { recursive: true });
  const put = (name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  put('docker', `
STATE=${dir}/state
case "$*" in
  *"inspect -f {{.State.Running}}"*) [ "$(cat $STATE 2>/dev/null)" = stopped ] && echo false || echo true ;;
  *"inspect -f {{.Config.Image}}"*)  echo aura-shell:same ;;
  stop*)  echo stopped > $STATE ;;
  start*)
    echo running > $STATE
    node -e '
      const fs=require("fs"); const [data, fail]=process.argv.slice(1);
      const cur=JSON.parse(fs.readFileSync(data+"/aura/release/pointer.json","utf8")).current;
      const now=new Date().toISOString();
      const held=fs.existsSync(data+"/aura/boot/writes-held");
      let st={v:1,startedAt:now,kernelReadyAt:now,acceptingWrites:!held,services:{"io.e2e.svc":{state:"resumed",readyAt:now}},kv:{version:"8.1.3"}};
      if (fail && cur===fail) { fs.writeFileSync(data+"/kv/dump.rdb","REDIS0011 with B marker"); st={...st,kernelReadyAt:null,error:"migration threw"}; }
      fs.mkdirSync(data+"/aura/boot",{recursive:true}); fs.writeFileSync(data+"/aura/boot/status.json", JSON.stringify(st));
    ' "${data}" "\${FAIL_RELEASE:-}" ;;
  *compose*) echo "compose must not run: the image is the same" >&2; exit 9 ;;
  *) : ;;
esac`);
  put('curl', 'echo 200');
  // os/release-ctl.sh (stream L, the one compose.env writer): env <id> / up are logged.
  put('release-ctl.sh', `echo "$*" >> ${dir}/ctl.log`);
  return dir;
}

function setup() {
  const data = tmp('aura-relscript-');
  putRelease(data, AID, { 'com.aura.settings': 's1' });
  putRelease(data, BID, { 'com.aura.settings': 's2' });
  mkdirSync(join(data, 'aura/release'), { recursive: true });
  writeFileSync(LAYOUT.layout(data).pointer, JSON.stringify({ v: 1, current: AID, previous: null, switchedAt: 'x', jobId: JOB }));
  write(data, 'kv/dump.rdb', 'REDIS0011 original');
  return data;
}

function run(data, { mode = 'release', from = AID, to = BID, restoreSnapshot = null, env = {} } = {}) {
  const work = tmp('aura-relscript-run-');
  const jobFile = join(work, 'job.json');
  writeFileSync(jobFile, JSON.stringify({
    id: JOB, phase: 'queued', mode, steps: RELEASE_STEPS.map((s) => ({ ...s, status: s.key === 'action' || s.key === 'drain' ? 'done' : 'pending' })), log: [],
  }));
  const script = renderReleaseScript({
    jobFile, logFile: join(work, 'job.log'), jobId: JOB, mode, from, to, restoreSnapshot, fromImage: 'aura-shell:same', toImage: 'aura-shell:same',
    confirmInsecure: '', dataDir: data, activate: ACT, releaseCtl: join(work, 'bin', 'release-ctl.sh'), shellUrl: 'http://shell.invalid', healthBudget: 4, poll: 1,
  });
  const file = join(work, 'run.sh');
  writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
  const bin = stubs(join(work, 'bin'), data);
  let status = 0;
  try {
    execFileSync('bash', [file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` } });
  } catch (e) { status = e.status ?? 1; }
  const job = JSON.parse(readFileSync(jobFile, 'utf8'));
  const ctl = existsSync(join(bin, 'ctl.log')) ? readFileSync(join(bin, 'ctl.log'), 'utf8') : '';
  return { status, job, ctl, step: (k) => job.steps.find((s) => s.key === k), log: readFileSync(join(work, 'job.log'), 'utf8') };
}

const pointer = (data) => JSON.parse(readFileSync(LAYOUT.layout(data).pointer, 'utf8'));

test('release: lock, verify, stop, snapshot, switch (held), start, health, accept — and the lock is released', () => {
  const data = setup();
  const r = run(data);
  assert.equal(r.status, 0, r.log);
  assert.equal(r.job.phase, 'done');
  for (const k of ['lock', 'verify', 'stop', 'snapshot', 'switch', 'start', 'health', 'accept', 'complete']) assert.equal(r.step(k).status, 'done', k);
  assert.equal(r.step('rollback').status, 'skipped');
  assert.deepEqual([pointer(data).current, pointer(data).previous], [BID, AID]);
  assert.equal(A.readWritesHeld(data), null, 'writes accepted (the marker, since no API answers here)');
  assert.match(r.step('accept').detail, /marker/);
  assert.ok(r.job.snapshot && existsSync(join(data, 'aura/release/snapshots', r.job.snapshot, 'snapshot.json')));
  assert.equal(existsSync(LAYOUT.layout(data).lock), false);
  assert.ok(!r.job.steps.some((s) => s.status === 'running'));
  assert.equal(r.ctl.trim(), `env ${BID}`, 'compose.env through release-ctl.sh; same image: a plain start, no up');
});

test('boot-fails-before-writes: automatic rollback, release AND data (the marker key is gone)', () => {
  const data = setup();
  const r = run(data, { env: { FAIL_RELEASE: BID } });
  assert.equal(r.status, 1);
  assert.equal(r.job.phase, 'rolled-back', r.log);
  assert.equal(r.step('health').status, 'failed');
  assert.match(r.step('health').detail, /migration threw/);
  assert.equal(r.step('rollback').status, 'done');
  assert.equal(r.step('complete').status, 'done');
  assert.equal(pointer(data).current, AID);
  assert.equal(readFileSync(join(data, 'kv/dump.rdb'), 'utf8'), 'REDIS0011 original', 'snapshot restored');
  assert.equal(A.readWritesHeld(data), null);
  assert.match(r.job.error, /migration threw/);
});

test('rollback after accepting writes: release only by default; the data only when chosen', () => {
  const data = setup();
  assert.equal(run(data).status, 0);
  write(data, 'kv/dump.rdb', 'REDIS0011 a write after accept');
  // release only
  let r = run(data, { mode: 'rollback', from: BID, to: AID });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.step('restore').status, 'skipped');
  assert.deepEqual([pointer(data).current, pointer(data).previous], [AID, null]);
  assert.equal(readFileSync(join(data, 'kv/dump.rdb'), 'utf8'), 'REDIS0011 a write after accept', 'the write survives');
  // forward again, then roll back WITH the data
  assert.equal(run(data).status, 0);
  const snap = A.status(data).snapshots.find((s) => s.toRelease === BID && s.jobId === JOB)?.id;
  write(data, 'kv/dump.rdb', 'REDIS0011 later');
  r = run(data, { mode: 'rollback', from: BID, to: AID, restoreSnapshot: snap });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.step('restore').status, 'done');
  assert.equal(readFileSync(join(data, 'kv/dump.rdb'), 'utf8'), 'REDIS0011 a write after accept', 'the snapshot of that switch is back');
});

test('concurrent: a second job is refused by the lock and changes nothing', async () => {
  const data = setup();
  const holder = spawn(process.execPath, [ACT, 'hold-lock', '--data', data, '--job', '2026-11-27T11-00-00-000Z'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  holder.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('"ok": true'); i++) await new Promise((r) => setTimeout(r, 50));
  try {
    const r = run(data);
    assert.equal(r.status, 1);
    assert.equal(r.step('lock').status, 'failed');
    assert.match(r.job.log.join('\n'), /activation-busy/);
    assert.equal(pointer(data).current, AID);
    assert.equal(r.step('stop').status, 'pending', 'the kernel was never stopped');
  } finally {
    holder.kill('SIGTERM');
    await new Promise((r) => holder.once('exit', r));
  }
});

test('a tampered target is refused at verify, before the kernel stops', () => {
  const data = setup();
  writeFileSync(join(LAYOUT.layout(data).release(BID), 'package.json'), '{"evil":true}\n');
  const r = run(data);
  assert.equal(r.status, 1);
  assert.equal(r.step('verify').status, 'failed');
  assert.match(r.step('verify').detail, /changed after it was built/);
  assert.equal(r.step('stop').status, 'pending');
  assert.equal(pointer(data).current, AID);
});

test('interrupted-switch: an abandoned hold (pointer switched, never accepted) is rolled back with its data and the hold ends', () => {
  const data = setup();
  const snap = A.snapshot(data, { from: AID, to: BID, jobId: JOB });
  A.switchTo(data, { to: BID, jobId: JOB, snapshot: snap.id });
  write(data, 'kv/dump.rdb', 'REDIS0011 written by B at boot');
  assert.ok(A.readWritesHeld(data));
  const r = run(data, { mode: 'rollback', from: BID, to: AID, restoreSnapshot: snap.id });
  assert.equal(r.status, 0, r.log);
  assert.equal(pointer(data).current, AID);
  assert.equal(A.readWritesHeld(data), null, 'the rolled-back release does not boot held');
  assert.equal(readFileSync(join(data, 'kv/dump.rdb'), 'utf8'), 'REDIS0011 original');
});
