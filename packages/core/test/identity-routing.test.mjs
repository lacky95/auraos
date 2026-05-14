// Regression tests for the Identity-Safe App Routing plan. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/identity-routing.test.mjs
//
// These tests cover the three structural invariants that, taken together,
// make the "wrong-content" bug class impossible:
//
//   1. PortAllocator refuses to hand out a port that is already bound at the
//      OS level (squatter test).
//   2. verifyHealthIdentity rejects a health response whose declared identity
//      doesn't match the expected (appId, instanceId) pair (identity-drift).
//   3. killProcessGroup terminates the entire process group of a detached
//      child, not just the spawned root (process-group kill).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

import { PortAllocator } from '../dist/app-manager/PortAllocator.js';
import { verifyHealthIdentity, killProcessGroup } from '../dist/app-manager/ProotRunner.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('PortAllocator refuses ports that are bound at the OS level', async () => {
  // Squat the first port in the range. The allocator's in-memory bookkeeping
  // would happily hand it out — only the OS-bind probe stops it.
  const SQUAT_PORT = 4001;
  const squatter = net.createServer();
  await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(SQUAT_PORT, '0.0.0.0', resolve);
  });

  try {
    const allocator = new PortAllocator(SQUAT_PORT, SQUAT_PORT + 5);
    const got = await allocator.allocate('test.squatter');
    assert.notEqual(got, SQUAT_PORT, 'allocator must not return a port the OS is already using');
    assert.ok(got > SQUAT_PORT && got <= SQUAT_PORT + 5, `expected a port in (${SQUAT_PORT}, ${SQUAT_PORT + 5}], got ${got}`);
  } finally {
    await new Promise((r) => squatter.close(r));
  }
});

test('verifyHealthIdentity rejects mismatched appId / instanceId', () => {
  // Mismatch: live upstream answers as the wrong app.
  const bad = verifyHealthIdentity(
    JSON.stringify({ ok: true, appId: 'com.aura.wrong', instanceId: 'com.aura.wrong' }),
    'com.aura.right',
    'com.aura.right',
  );
  assert.equal(bad.kind, 'mismatch', `expected mismatch verdict, got ${bad.kind}`);
  if (bad.kind === 'mismatch') {
    assert.equal(bad.claimedApp, 'com.aura.wrong');
    assert.equal(bad.claimedInstance, 'com.aura.wrong');
  }

  // Match: identity lines up.
  const ok = verifyHealthIdentity(
    JSON.stringify({ ok: true, appId: 'com.aura.right', instanceId: 'com.aura.right' }),
    'com.aura.right',
    'com.aura.right',
  );
  assert.equal(ok.kind, 'match');

  // Legacy app without identity body — accepted, since the rollout has to
  // tolerate older app templates until they're retrofitted.
  const legacy = verifyHealthIdentity(JSON.stringify({ ok: true }), 'com.aura.x', 'com.aura.x');
  assert.equal(legacy.kind, 'legacy');
});

test('verifyHealthIdentity rejects identity-drift live via a fake HTTP upstream', async () => {
  // Real over-the-wire test: stand up a tiny HTTP server pretending to be the
  // wrong app, fetch its /api/lifecycle/health, run the verdict. Catches any
  // future regression that breaks the fetch → JSON → verify chain end-to-end.
  const server = http.createServer((req, res) => {
    if (req.url === '/api/lifecycle/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, appId: 'com.aura.wrong', instanceId: 'com.aura.wrong-1' }));
    } else {
      res.writeHead(404).end();
    }
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/lifecycle/health`);
    const body = await res.text();
    const verdict = verifyHealthIdentity(body, 'com.aura.expected', 'com.aura.expected-1');
    assert.equal(verdict.kind, 'mismatch');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('killProcessGroup terminates detached descendants, not just the root', async () => {
  // Spawn a bash that spawns a long-running sleep in its own subshell. Without
  // process-group kill, signalling the bash pid leaves the sleep behind — the
  // classic squatter source. With kill(-pgid) both go.
  const child = spawn('bash', ['-c', 'sleep 60 & echo $! && wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // Wait for the inner sleep pid to come over stdout so we can verify it later.
  const innerPid = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    setTimeout(() => reject(new Error('inner pid never arrived')), 2000);
  });

  // Sanity: both pids are alive right now.
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'bash should be alive');
  assert.doesNotThrow(() => process.kill(innerPid, 0), 'inner sleep should be alive');

  killProcessGroup(child.pid, 'SIGKILL');

  // Poll for both pids to disappear — give it up to 2s.
  const deadline = Date.now() + 2000;
  const isDead = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  while (Date.now() < deadline) {
    if (isDead(child.pid) && isDead(innerPid)) break;
    await sleep(50);
  }
  assert.equal(isDead(child.pid),  true, `bash pid ${child.pid} should be gone after group kill`);
  assert.equal(isDead(innerPid),   true, `inner pid ${innerPid} should be gone after group kill`);
});
