// Phase 6 L: the Normal layout's scripts, against a fake data root and a fake docker CLI:
//   os/release-entry.sh  pointer → a complete release (current, else previous) → /workspace link → exec the shell
//   os/release-ctl.sh    host recovery: status, rollback, use <id>, env, up (lock, pointer, compose.env, restart)
// and the Dockerfile `release` target / docker-compose.release.yml contract.
// The scripts' absolute paths (/os/release, /releases, /workspace, the CLI shim targets) are rewritten
// into a temp dir; nothing outside it is touched.
//
//   node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const A = '0.1.0-aaaaaaaaaaaa-11111111';
const B = '0.2.0-bbbbbbbbbbbb-22222222';

function world({ securityUpdate = false, runningImage = 'aura-shell:fp-b' } = {}) {
  const t = mkdtempSync(join(tmpdir(), 'aura-relrt-'));
  const data = join(t, 'data');
  const rel = (id, extra = {}) => {
    const d = join(data, 'releases', id);
    mkdirSync(join(d, 'packages', 'shell'), { recursive: true });
    mkdirSync(join(d, 'os'), { recursive: true });
    writeFileSync(join(d, 'release.json'), JSON.stringify({ v: 1, id, version: id.split('-')[0], commit: id.split('-')[1], provenance: 'upstream-signed',
      images: { shell: `aura-shell:fp-${id[2] === '1' ? 'a' : 'b'}`, base: 'aura-base:fp', target: 'release' }, meta: { signed: true, securityUpdate }, ...extra }));
    writeFileSync(join(d, 'docker-compose.release.yml'), 'services: {}\n');
    writeFileSync(join(d, 'packages', 'shell', 'server.mjs'), `console.log('SERVED ${id} ' + process.cwd() + ' ' + process.env.NODE_ENV);\n`);
    for (const f of ['aura-cli-shim.sh', 'bashrc.aura.sh', 'toolchain-path.sh']) writeFileSync(join(d, 'os', f), '#\n');
    writeFileSync(join(d, '.complete'), '');
    return d;
  };
  rel(A); rel(B);
  mkdirSync(join(data, 'aura', 'release'), { recursive: true });
  writeFileSync(join(data, 'aura', 'release', 'pointer.json'), JSON.stringify({ v: 1, current: B, previous: A, switchedAt: 'x', jobId: 'y' }));
  // fake docker: logs every call; answers the few questions release-ctl asks
  const bin = join(t, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> ${t}/docker.log
case "$*" in
  "inspect -f {{.Config.Image}} aura-shell") echo ${runningImage} ;;
  inspect*Destination*) echo p_aura-app-data ;;
esac
exit 0
`);
  chmodSync(join(bin, 'docker'), 0o755);
  // the scripts, with their absolute paths moved into the temp dir
  const sub = (text) => text
    .replaceAll("'/os/release/", `'${ROOT}/os/release/`)
    .replace('RELEASES=/releases', `RELEASES=${join(data, 'releases')}`)
    .replace('WORKSPACE=/workspace', `WORKSPACE=${join(t, 'workspace')}`)
    .replaceAll('/usr/local/bin/aura', join(t, 'usr-local-bin-aura'))
    .replaceAll('/os/toolchain/bin/aura', join(t, 'toolchain-aura'))
    .replaceAll('/os/base-rootfs/', `${t}/base-rootfs/`)
    .replaceAll('/etc/profile.d/aura-toolchain.sh', join(t, 'aura-toolchain.sh'))
    .replace(/(?<=\s)\/home\/(master|aura)\b/g, (_m, who) => join(t, `home-${who}`));
  for (const s of ['release-entry.sh', 'release-ctl.sh']) writeFileSync(join(t, s), sub(readFileSync(join(ROOT, 'os', s), 'utf8')));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AURA_DATA_DIR: data, AURA_BOOT_FAIL_HOLD_S: '0', HOSTNAME: 'recovery' };
  const run = (script, args = []) => spawnSync('sh', [join(t, script), ...args], { encoding: 'utf8', env, timeout: 30_000 });
  const pointer = () => JSON.parse(readFileSync(join(data, 'aura', 'release', 'pointer.json'), 'utf8'));
  const dockerLog = () => (existsSync(join(t, 'docker.log')) ? readFileSync(join(t, 'docker.log'), 'utf8') : '');
  return { t, data, run, pointer, dockerLog, rel };
}

test('release-entry: the current complete release is linked at /workspace and served in production', () => {
  const w = world();
  const r = w.run('release-entry.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`SERVED ${B} .*releases/${B}/packages/shell production`), 'through the /workspace link');
  assert.equal(readlinkSync(join(w.t, 'workspace')), join(w.data, 'releases', B));
  assert.equal(readFileSync(join(w.data, 'aura', 'boot', 'phase'), 'utf8').trim(), 'starting');
  assert.ok(existsSync(join(w.t, 'usr-local-bin-aura')), 'the CLI shim from the release');
});

test('release-entry: an incomplete current release falls back to previous; the pointer is unchanged', () => {
  const w = world();
  spawnSync('rm', [join(w.data, 'releases', B, '.complete')]);
  const r = w.run('release-entry.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`SERVED ${A} `));
  assert.match(r.stderr, /FALLBACK to the previous release/);
  assert.equal(w.pointer().current, B);
  assert.match(readFileSync(join(w.data, 'aura', 'boot', 'release-fallback'), 'utf8'), new RegExp(`fallback ${A}`));
});

test('release-entry: nothing complete, or no pointer: fails with the host recovery command (D2)', () => {
  const w = world();
  for (const id of [A, B]) spawnSync('rm', [join(w.data, 'releases', id, '.complete')]);
  const r = w.run('release-entry.sh');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /neither the current release .* nor the previous one .* is complete/);
  assert.match(r.stderr, /\/os\/release-ctl\.sh rollback/);
  const w2 = world();
  spawnSync('rm', [join(w2.data, 'aura', 'release', 'pointer.json')]);
  assert.match(w2.run('release-entry.sh').stderr, /no release pointer/);
});

test('release-entry: a non-empty /workspace (a checkout bind) is refused, never replaced', () => {
  const w = world();
  mkdirSync(join(w.t, 'workspace'));
  writeFileSync(join(w.t, 'workspace', 'file'), 'x');
  const r = w.run('release-entry.sh');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not empty/);
});

test('release-ctl rollback: lock, pointer swap, compose.env, a plain restart when the image is unchanged', () => {
  const w = world({ runningImage: 'aura-shell:fp-a' });
  const r = w.run('release-ctl.sh', ['rollback']);
  assert.equal(r.status, 0, r.stderr);
  const p = w.pointer();
  assert.deepEqual([p.current, p.previous], [A, null], 'a rollback clears previous (activate.mjs revert: one rule)');
  assert.match(p.jobId, /^\d{4}-\d{2}-\d{2}T/);
  const env = readFileSync(join(w.data, 'aura', 'release', 'compose.env'), 'utf8');
  assert.match(env, /^COMPOSE_PROJECT_NAME=p$/m);
  assert.match(env, /^AURA_APP_DATA_VOLUME=p_aura-app-data$/m);
  assert.match(env, /^AURA_SHELL_IMAGE=aura-shell:fp-a$/m);
  assert.match(env, new RegExp(`^AURA_RELEASE=${A}$`, 'm'));
  assert.match(w.dockerLog(), /^restart aura-shell$/m);
  assert.doesNotMatch(w.dockerLog(), /compose/);
  assert.equal(existsSync(join(w.data, 'aura', 'release', 'lock')), false, 'the lock is released');
});

test('release-ctl use: another image → a recreate from the release\'s own compose file', () => {
  const w = world({ runningImage: 'aura-shell:fp-b' });
  const r = w.run('release-ctl.sh', ['use', A]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(w.dockerLog(), new RegExp(`compose -p p --env-file ${w.data}/aura/release/compose.env -f ${w.data}/releases/${A}/docker-compose.release.yml up -d --no-build --force-recreate aura-os`));
});

test('release-ctl refuses: a held lock, an incomplete or unknown release, a bad id, leaving a security update', () => {
  const w = world();
  writeFileSync(join(w.data, 'aura', 'release', 'lock'), JSON.stringify({ jobId: 'other', pid: 1, host: 'elsewhere', at: Date.now(), heartbeatAt: Date.now(), by: 'system.release.build' }));
  let r = w.run('release-ctl.sh', ['rollback']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /activation-busy/);
  assert.equal(w.pointer().current, B, 'nothing switched');
  spawnSync('rm', [join(w.data, 'aura', 'release', 'lock')]);
  spawnSync('rm', [join(w.data, 'releases', A, '.complete')]);
  assert.match(w.run('release-ctl.sh', ['rollback']).stderr, /is not complete/);
  assert.notEqual(w.run('release-ctl.sh', ['use', '../etc']).status, 0);
  const s = world({ securityUpdate: true });
  r = s.run('release-ctl.sh', ['rollback']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /signed security update/);
  assert.equal(s.pointer().current, B);
  r = s.run('release-ctl.sh', ['rollback', '--force-insecure']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.pointer().current, A);
});

test('release-ctl status lists the pointer, the lock and the releases', () => {
  const w = world();
  const r = w.run('release-ctl.sh', ['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`current ${B}, previous ${A}`));
  assert.match(r.stdout, new RegExp(`^\\* ${B}  complete`, 'm'));
  assert.match(r.stdout, new RegExp(`^p ${A}  complete`, 'm'));
  assert.match(r.stdout, /lock: {5}free/);
});

test('the Dockerfile release target and the Normal compose file', () => {
  const df = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(df, /^FROM development AS release$/m);
  assert.match(df, /^CMD \["\/os\/release-entry\.sh"\]$/m);
  assert.doesNotMatch(df, /AS runtime$/m, 'the unused runtime stage is gone (D36)');
  assert.match(df.slice(df.indexOf('FROM base AS development'), df.indexOf('FROM development AS release')), /^CMD \["sh", "\/workspace\/os\/boot\.sh"\]$/m, 'development keeps boot.sh');
  const c = readFileSync(join(ROOT, 'docker-compose.release.yml'), 'utf8');
  assert.doesNotMatch(c, /AURA_HOST_WORKSPACE:|\.:\/workspace|- \.\//, 'no checkout bind, no host workspace');
  assert.match(c, /target: \/releases\n\s+read_only: true\n\s+volume:\n\s+subpath: releases/);
  assert.match(c, /command: \["\/os\/release-entry\.sh"\]/);
});
