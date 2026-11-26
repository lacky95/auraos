// Phase 5 stream T (D69): a Terminal instance is one user's session host.
// The session env (never the server's lifecycle token, HOME=/home/aura), the
// per-session hook token, the explicit tmux socket per uid, and a real tmux
// session's environment.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AURA_LIFECYCLE_TOKEN = 'lt-of-this-start';
process.env.AURA_TERM_TMUX_SOCKET = `aura-host-test-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';

const { hookToken, hookTokenValid, HOOK_TOKEN_ENV } = await import('../src/hook-token.ts');
const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const tc = await import('../src/tmux-control.ts');

after(() => { if (haveTmux) spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); });

test('hook token: per session, keyed from this start, constant-time check', () => {
  const a = hookToken('com.aura.terminal-2#a1');
  assert.equal(a, hookToken('com.aura.terminal-2#a1', 'lt-of-this-start'), 'the start\'s lifecycle token keys it');
  assert.notEqual(a, hookToken('com.aura.terminal-2#a2'), 'another session');
  assert.notEqual(a, hookToken('com.aura.terminal-2#a1', 'another-start'), 'another start');
  assert.equal(hookTokenValid('com.aura.terminal-2#a1', a), true);
  assert.equal(hookTokenValid('com.aura.terminal-2#a2', a), false, 'one session\'s token never reports for another');
  assert.equal(hookTokenValid('com.aura.terminal-2#a1', ''), false);
  assert.equal(hookTokenValid('com.aura.terminal-2#a1', null), false);
  assert.equal(hookTokenValid('com.aura.terminal-2#a1', `${a}x`), false);
});

test('session env: none of the server\'s own variables (the lifecycle token first), the user\'s context keys stay, HOME=/home/aura', () => {
  const env = tc.sessionEnv({
    AURA_LIFECYCLE_TOKEN: 'secret', AURA_RELAY_STRICT: 'strict', AURA_LISTEN_SUBNET: '172.30.0.0/16', AURA_SHELL_PEERS: 'x',
    PORT: '4001', APP_PORT: '4001', HOST: '172.30.0.3', NODE_ENV: 'production', npm_config_x: '1', ASTRO_NODE_AUTOSTART: 'disabled',
    AURA_INSTANCE_TOKEN: 'aura1.x.y', OS_API_BASE: 'http://s:3000', PATH: '/aura/my-tools/bin:/usr/bin', LAKNERIO_KEY: 'v', HOME: '/root',
    TERM: 'xterm-256color', LANG: 'C.UTF-8',
  });
  for (const k of ['AURA_LIFECYCLE_TOKEN', 'AURA_RELAY_STRICT', 'AURA_LISTEN_SUBNET', 'AURA_SHELL_PEERS', 'PORT', 'APP_PORT', 'HOST', 'NODE_ENV', 'npm_config_x', 'ASTRO_NODE_AUTOSTART']) {
    assert.equal(env[k], undefined, k);
  }
  assert.equal(env.AURA_INSTANCE_TOKEN, 'aura1.x.y', 'the aura CLI acts as this instance');
  assert.equal(env.LAKNERIO_KEY, 'v', 'a context key the user was given');
  assert.equal(env.HOME, '/home/aura');
  assert.equal(env.OS_API_BASE, 'http://s:3000');
  assert.ok(env.AURA_TERM_LABEL);
});

test('tmux socket: -S /run/aura-term/<uid>/tmux.sock in the session host\'s tmpfs, a named test socket keeps -L', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-term-run-'));
  try {
    assert.deepEqual(tc.tmuxSocketArgs({ AURA_TERM_TMUX_DIR: root }, 1000), ['-S', join(root, '1000', 'tmux.sock')]);
    assert.equal(statSync(join(root, '1000')).mode & 0o777, 0o700);
    assert.deepEqual(tc.tmuxSocketArgs({ AURA_TERM_TMUX_SOCKET: 'name' }, 1000), ['-L', 'name']);
    assert.deepEqual(tc.TMUX_SOCKET_ARGS, ['-L', process.env.AURA_TERM_TMUX_SOCKET]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real session: its own hook token and id in its env, never the lifecycle token', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const id = 'com.aura.terminal-9#a4';
  await tc.newSession(id, 80, 24);
  const out = spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'show-environment', '-t', tc.tmuxName(id)], { encoding: 'utf-8' }).stdout;
  assert.match(out, new RegExp(`^${HOOK_TOKEN_ENV}=${hookToken(id).replace(/[-_]/g, '.')}$`, 'm'));
  assert.match(out, /^AURA_TERM_SESSION=com\.aura\.terminal-9#a4$/m);
  const global = spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'show-environment', '-g'], { encoding: 'utf-8' }).stdout;
  assert.doesNotMatch(out + global, /AURA_LIFECYCLE_TOKEN/, 'the server\'s lifecycle token never reaches a session');
  assert.match(global, /^HOME=\/home\/aura$/m);
  tc.tmuxKill(id);
});
