// Phase 5 stream T2 (owner decision 2026-11-27): the Terminal server runs as
// its own non-login service uid; every session command runs as the session
// user through the session launcher (os/term-launch). The helpers that route
// to it, and, when this runs as root with a C compiler, the real launcher:
// for the owner's uid and a member's, a session can't read the server's
// /proc (environ, fd, maps), signal it or attach to it, and gets no lifecycle
// token; a peer other than the server is refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tc = await import('../src/tmux-control.ts');
// A launcher socket of this test process's own (suites run side by side in one network namespace).
process.env.AURA_TERM_LAUNCH_NAME = `test-${process.pid}`;
const LAUNCH_ENV = { AURA_TERM_LAUNCH: '/usr/local/libexec/aura-term-launch', AURA_SESSION_UID: '1000' };

test('T2: the launcher is used only when this server is not the session user', () => {
  assert.equal(tc.sessionLauncher(LAUNCH_ENV, 990), '/usr/local/libexec/aura-term-launch');
  assert.equal(tc.sessionLauncher(LAUNCH_ENV, 1000), null, 'the server is the user (no launcher needed)');
  assert.equal(tc.sessionLauncher({ AURA_SESSION_UID: '1000' }, 990), null);
  assert.equal(tc.sessionLauncher({ AURA_TERM_LAUNCH: '/x' }, 990), null);
  assert.deepEqual(tc.asSessionUser('/bin/bash', ['-l'], LAUNCH_ENV), { file: '/usr/local/libexec/aura-term-launch', args: ['run', '--', '/bin/bash', '-l'] });
  assert.deepEqual(tc.asSessionUser('/bin/bash', ['-l'], {}), { file: '/bin/bash', args: ['-l'] });
});

test('T2: the tmux socket is the session user\'s (/run/aura-term/<session uid>), never the server\'s', () => {
  assert.deepEqual(tc.tmuxSocketArgs(LAUNCH_ENV, 990), ['-S', '/run/aura-term/1000/tmux.sock']);
  assert.deepEqual(tc.tmuxSocketArgs({ ...LAUNCH_ENV, AURA_SESSION_UID: '100000' }, 990), ['-S', '/run/aura-term/100000/tmux.sock']);
});

test('T2: the session env under the launcher names no service account (the launcher sets USER/LOGNAME/HOME)', () => {
  const env = tc.sessionEnv({ ...LAUNCH_ENV, USER: 'aura-terminal', LOGNAME: 'aura-terminal', PATH: '/usr/bin' });
  assert.notEqual(env.USER, 'aura-terminal');
  assert.equal(env.HOME, '/home/aura');
  assert.equal(env.AURA_TERM_LAUNCH, undefined);
});

// ── The real launcher ────────────────────────────────────────────────────────
const SRC = new URL('../../../os/term-launch/term-launch.c', import.meta.url).pathname;
const root = process.getuid?.() === 0;
const cc = root && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'aura-term-launch-'));
after(() => rmSync(dir, { recursive: true, force: true }));
chmodSync(dir, 0o755);
const built = cc && spawnSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', join(dir, 'aura-term-launch'), SRC], { encoding: 'utf-8' });
const usable = !!built && built.status === 0 && spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !root ? 'needs root' : !cc ? 'no C compiler' : !usable ? `build failed: ${built?.stderr ?? ''}` : false;
if (usable) symlinkSync('aura-term-launch', join(dir, 'aura-term-tmux'));

/** The server's probe script: runs as the service uid, asks the launcher to run commands as the session user. */
const PROBE = `#!/bin/sh
L="$1"
me=$$
echo "server_uid=$(id -u)"
echo "session_uid=$($L run id -u)"
echo "session_groups=$($L run id -G)"
echo "session_capeff=$($L run sh -c "awk '/^CapEff/ {print \\$2}' /proc/self/status")"
echo "session_token=$($L run sh -c 'echo \${AURA_LIFECYCLE_TOKEN:-none}')"
echo "environ=$($L run sh -c "cat /proc/$me/environ >/dev/null 2>&1 && echo read || echo refused")"
echo "fd=$($L run sh -c "ls /proc/$me/fd >/dev/null 2>&1 && echo read || echo refused")"
echo "maps=$($L run sh -c "cat /proc/$me/maps >/dev/null 2>&1 && echo read || echo refused")"
echo "kill=$($L run sh -c "kill -0 $me 2>/dev/null && echo allowed || echo refused")"
echo "launcher_environ=$($L run sh -c "cat /proc/$PPID/environ >/dev/null 2>&1 && echo read || echo refused")"
echo "launcher_kill=$($L run sh -c "kill -0 $PPID 2>/dev/null && echo allowed || echo refused")"
$L run sh -c 'exit 7'; echo "status=$?"
echo "stdin=$(echo piped | $L run cat)"
`;

for (const [who, uid] of [['owner', 1000], ['member', 100000]]) {
  test(`T2 (${who}): the real launcher: sessions as uid ${uid} can't inspect, signal or read the server; no token`, { skip }, () => {
    writeFileSync(join(dir, 'probe.sh'), PROBE, { mode: 0o755 });
    // As the container starts it: root with only SETUID/SETGID, no-new-privileges.
    const r = spawnSync('setpriv', ['--bounding-set=-all,+setuid,+setgid', '--inh-caps=-all', '--no-new-privs', '--',
      join(dir, 'aura-term-launch'), 'serve', '--service', '990:990', '--user', `${uid}:${uid}`, '--', join(dir, 'probe.sh'), join(dir, 'aura-term-launch')],
      { encoding: 'utf-8', cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin', AURA_LIFECYCLE_TOKEN: 'lt-secret', AURA_TERM_LAUNCH_NAME: process.env.AURA_TERM_LAUNCH_NAME }, timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    const kv = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(kv.server_uid, '990');
    assert.equal(kv.session_uid, String(uid));
    assert.equal(kv.session_groups, String(uid), 'only its own group');
    assert.match(kv.session_capeff, /^0+$/);
    assert.equal(kv.session_token, 'none', 'the lifecycle token never reaches a session');
    assert.deepEqual([kv.environ, kv.fd, kv.maps, kv.kill], ['refused', 'refused', 'refused', 'refused'], 'the server is out of reach');
    assert.deepEqual([kv.launcher_environ, kv.launcher_kill], ['refused', 'refused'], 'so is the launcher');
    assert.equal(kv.status, '7');
    assert.equal(kv.stdin, 'piped');
  });
}

test('T2: the launcher serves its server only: a request from any other uid (the user, root) is refused', { skip }, () => {
  const L = join(dir, 'aura-term-launch');
  // The launcher's peer check: the session user and root (anyone but the service uid) are refused.
  const outside = spawnSync('sh', ['-c', `(${L} serve --service 990:990 --user 1000:1000 -- sleep 2 &) ; sleep 0.4; setpriv --reuid=1000 --regid=1000 --clear-groups ${L} run true; echo "user=$?"; ${L} run true; echo "root=$?"`],
    { encoding: 'utf-8', cwd: '/', timeout: 20_000 });
  assert.match(outside.stdout, /user=125/);
  assert.match(outside.stdout, /root=125/);
  assert.match(outside.stderr, /refused a request from uid 1000/);
});

test('T2: serve refuses to make the session user root or the service itself', { skip }, () => {
  const L = join(dir, 'aura-term-launch');
  for (const args of [['--service', '990:990', '--user', '0:0'], ['--service', '0:0', '--user', '1000:1000'], ['--service', '1000:1000', '--user', '1000:1000']]) {
    const r = spawnSync(L, ['serve', ...args, '--', 'true'], { encoding: 'utf-8' });
    assert.equal(r.status, 125, args.join(' '));
  }
});
