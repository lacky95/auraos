// OPEN_TERMINAL intents: extras validation + conflict rules (launch-intent.ts),
// the page-side readiness gate for `command` (launch-gate.ts), and the
// one-shot pending-command store (launch-commands.ts). No tmux, no network.
// Run via:
//   pnpm --filter com.aura.terminal test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AURA_TERM_TMUX = '0';
process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'term-launch-'));

const { parseOpenTerminal, screenSettled, OPEN_TERMINAL_ACTION, MAX_COMMAND_LENGTH } = await import('../src/launch-intent.ts');
const { createLaunchGate } = await import('../src/launch-gate.ts');
const { queueLaunchCommand, hasLaunchCommand, takeLaunchCommand, dropLaunchCommand } = await import('../src/launch-commands.ts');

const LOCAL = 'com.aura.terminal-3';
const open = (extras, flags) => parseOpenTerminal({ action: OPEN_TERMINAL_ACTION, ...(extras ? { extras } : {}), ...(flags ? { flags } : {}) }, LOCAL);
const rejected = (res, code, status) => {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.rejection.code, code);
  if (status) assert.equal(res.rejection.status, status);
  assert.ok(res.rejection.message.length > 0);
};

test('no extras = the launcher default: new session, no command, windowed', () => {
  assert.deepEqual(open(), { ok: true, opts: { background: false } });
  assert.deepEqual(open({}), { ok: true, opts: { background: false } });
});

test('sessionId on this instance, command, background each parse', () => {
  assert.deepEqual(open({ sessionId: `${LOCAL}#a2` }), { ok: true, opts: { sessionId: `${LOCAL}#a2`, background: false } });
  assert.deepEqual(open({ command: 'htop' }), { ok: true, opts: { command: 'htop', background: false } });
  assert.deepEqual(open({ sessionId: `${LOCAL}#a2`, command: 'ls -la && git status' }).opts.command, 'ls -la && git status');
  assert.deepEqual(open({ background: true, command: 'make watch' }), { ok: true, opts: { command: 'make watch', background: true } });
  // NEW_INSTANCE + a new session is fine (it's only sessionId that conflicts)
  assert.equal(open({ command: 'x' }, ['NEW_INSTANCE']).ok, true);
});

test('other actions are refused, not treated as a plain open', () => {
  rejected(parseOpenTerminal({ action: 'aura.intent.action.VIEW' }, LOCAL), 'unsupported-action', 400);
});

test('unknown extras and intent-level fields put in extras are refused with a hint', () => {
  rejected(open({ sesionId: 'x' }), 'unknown-extra', 400);
  for (const k of ['instanceId', 'newInstance', 'flags']) {
    const res = open({ [k]: 'x' });
    rejected(res, 'misplaced-option', 400);
    assert.match(res.rejection.hint, /intent\.instanceId|NEW_INSTANCE/);
  }
});

test('command validation: type, empty, length, control characters', () => {
  rejected(open({ command: 42 }), 'bad-command');
  rejected(open({ command: '   ' }), 'bad-command');
  rejected(open({ command: 'x'.repeat(MAX_COMMAND_LENGTH + 1) }), 'bad-command');
  rejected(open({ command: 'ls\nrm -rf /' }), 'bad-command');
  rejected(open({ command: 'ls\r' }), 'bad-command');
  rejected(open({ command: '\u001b[31m' }), 'bad-command');
  assert.equal(open({ command: 'printf "a\tb"' }).ok, true);   // a TAB is fine
  rejected(open({ background: 'yes' }), 'bad-background');
});

test('sessionId: malformed, other instance, conflicts', () => {
  rejected(open({ sessionId: 'a3' }), 'bad-session-id', 400);
  rejected(open({ sessionId: 'other.app-1#a1' }), 'bad-session-id', 400);
  rejected(open({ sessionId: 7 }), 'bad-session-id', 400);
  const other = open({ sessionId: 'com.aura.terminal-9#a1' });
  rejected(other, 'session-on-other-instance', 409);
  assert.match(other.rejection.hint, /instanceId "com\.aura\.terminal-9"/);
  rejected(open({ sessionId: `${LOCAL}#a1`, background: true }), 'conflicting-options', 400);
  const fresh = open({ sessionId: `${LOCAL}#a1` }, ['NEW_INSTANCE']);
  rejected(fresh, 'conflicting-options', 400);
  assert.match(fresh.rejection.hint, /instanceId "com\.aura\.terminal-3"/);
});

test('screenSettled: needs drawn content and two identical captures', () => {
  assert.equal(screenSettled(null, ['$ ']), false);
  assert.equal(screenSettled(['', ''], ['', '']), false);
  assert.equal(screenSettled(['$'], ['$ ']), false);
  assert.equal(screenSettled(['user@h:~$ ', ''], ['user@h:~$ ', '']), true);
});

// ── launch-gate ────────────────────────────────────────────────────────────

function fakeClock() {
  let now = 0; let seq = 0;
  const timers = new Map();
  return {
    schedule: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    cancel: (id) => { timers.delete(id); },
    async advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); await new Promise((r) => setImmediate(r)); }
      }
    },
    pending: () => timers.size,
  };
}

test('gate fires once, settleMs after the terminal goes live', async () => {
  const clock = fakeClock();
  let fired = 0;
  const gate = createLaunchGate({ fire: async () => { fired++; return 'done'; }, settleMs: 150, ...clock });
  await clock.advance(1000);
  assert.equal(fired, 0, 'never before granted');
  gate.live();
  await clock.advance(100);
  assert.equal(fired, 0);
  await clock.advance(60);
  assert.equal(fired, 1);
  assert.equal(gate.done, true);
  gate.live();              // a reconnect re-grants…
  await clock.advance(1000);
  assert.equal(fired, 1);   // …but the command already ran
});

test('a drop before the settle cancels; the next grant (after reconnect) re-arms', async () => {
  const clock = fakeClock();
  let fired = 0;
  const gate = createLaunchGate({ fire: async () => { fired++; return 'done'; }, settleMs: 150, ...clock });
  gate.live();
  await clock.advance(100);
  gate.lost();
  await clock.advance(1000);
  assert.equal(fired, 0);
  gate.live();
  await clock.advance(150);
  assert.equal(fired, 1);
});

test('network failure retries while live, stops while lost, gives up after maxAttempts', async () => {
  const clock = fakeClock();
  let fired = 0;
  const gate = createLaunchGate({ fire: async () => { fired++; throw new Error('offline'); }, settleMs: 10, retryMs: 100, maxAttempts: 3, ...clock });
  gate.live();
  await clock.advance(10);
  assert.equal(fired, 1);
  gate.lost();
  await clock.advance(500);
  assert.equal(fired, 1, 'no retries while not live');
  gate.live();
  await clock.advance(10);
  await clock.advance(100);
  assert.equal(fired, 3);
  assert.equal(gate.done, true);
  await clock.advance(1000);
  assert.equal(fired, 3);
});

// ── pending-command store ───────────────────────────────────────────────────

test('pending command: queued per window, taken exactly once, dropped on close', () => {
  const W = `${LOCAL}#a5`;
  assert.equal(hasLaunchCommand(W), false);
  assert.equal(hasLaunchCommand(null), false);
  queueLaunchCommand(W, `${LOCAL}#a2`, 'ls');
  assert.equal(hasLaunchCommand(W), true);
  const p = takeLaunchCommand(W);
  assert.equal(p.sessionId, `${LOCAL}#a2`);
  assert.equal(p.command, 'ls');
  assert.equal(takeLaunchCommand(W), null, 'second take (reconnect / other browser) finds nothing');
  assert.equal(hasLaunchCommand(W), false);
  queueLaunchCommand(W, W, 'pwd');
  dropLaunchCommand(W);
  assert.equal(takeLaunchCommand(W), null);
});
