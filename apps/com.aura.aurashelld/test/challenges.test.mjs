// Stop/kill confirmation codes: single use, bound to instance + mode, expire.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { issueChallenge, verifyChallenge, CHALLENGE_TTL_MS, _resetForTests } = await import('../src/challenges.ts');

beforeEach(() => _resetForTests());

test('a code verifies once, for the instance and mode it was issued for', () => {
  const code = issueChallenge('com.aura.terminal-2', 'stop');
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.deepEqual(verifyChallenge(code, 'com.aura.terminal-2', 'stop'), { ok: true });
  assert.deepEqual(verifyChallenge(code, 'com.aura.terminal-2', 'stop'), { ok: false, reason: 'unknown' });
});

test('a stop code cannot kill, and a code for one instance cannot touch another', () => {
  const code = issueChallenge('com.aura.terminal-2', 'stop');
  assert.deepEqual(verifyChallenge(code, 'com.aura.terminal-2', 'kill'), { ok: false, reason: 'mismatch' });
  assert.deepEqual(verifyChallenge(code, 'com.aura.notepad-1', 'stop'), { ok: false, reason: 'mismatch' });
  assert.deepEqual(verifyChallenge(code, 'com.aura.terminal-2', 'stop'), { ok: true }, 'a mismatch does not consume it');
});

test('codes expire after the TTL and are case-insensitive on the way in', () => {
  const t0 = 1_000_000;
  const code = issueChallenge('x', 'kill', t0);
  assert.deepEqual(verifyChallenge(code.toLowerCase(), 'x', 'kill', t0 + 1000), { ok: true });
  const code2 = issueChallenge('x', 'kill', t0);
  assert.deepEqual(verifyChallenge(code2, 'x', 'kill', t0 + CHALLENGE_TTL_MS + 1), { ok: false, reason: 'expired' });
});
