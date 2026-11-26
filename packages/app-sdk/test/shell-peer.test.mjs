// The shell-peer check (H3, H4 stopgap): an app server that acts for the
// owner answers only connections from the shell's address and its own loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellPeer } from '../dist/shell-peer.js';

test('only the shell (by OS_API_BASE DNS) and loopback count; misses re-resolve at most every 2 s', async () => {
  let lookups = 0;
  let t = 0;
  const fromShell = createShellPeer({
    base: () => 'http://aura-shell:3000',
    resolve: async (host) => { lookups++; assert.equal(host, 'aura-shell'); return ['172.20.0.2']; },
    now: () => t,
  });
  assert.equal(await fromShell('172.20.0.2'), true, 'the shell, by its DNS address');
  assert.equal(await fromShell('::ffff:172.20.0.2'), true);
  assert.equal(await fromShell('127.0.0.1'), true, 'this container itself');
  assert.equal(await fromShell('::1'), true);
  assert.equal(await fromShell('172.20.0.9'), false, 'another container on aura-net');
  assert.equal(await fromShell(undefined), false);
  assert.equal(await fromShell('not-an-ip'), false);
  const before = lookups;
  await fromShell('172.20.0.9');
  assert.equal(lookups, before, 'no lookup storm from unknown peers');
  t += 5_000;
  await fromShell('172.20.0.9');
  assert.equal(lookups, before + 1);
});

test('a shell that moved address (restart) is found again; no base or a failed lookup admits loopback only', async () => {
  let addr = '172.20.0.2';
  let t = 0;
  const fromShell = createShellPeer({ base: () => 'http://aura-shell:3000', resolve: async () => [addr], now: () => t });
  assert.equal(await fromShell('172.20.0.2'), true);
  addr = '172.20.0.5';
  t += 3_000;
  assert.equal(await fromShell('172.20.0.5'), true);
  const literal = createShellPeer({ base: () => 'http://10.1.2.3:3000', resolve: async () => { throw new Error('no dns'); } });
  assert.equal(await literal('10.1.2.3'), true);
  const none = createShellPeer({ base: () => undefined, resolve: async () => ['172.20.0.2'] });
  assert.equal(await none('172.20.0.2'), false);
  assert.equal(await none('127.0.0.1'), true);
  const failing = createShellPeer({ base: () => 'http://aura-shell:3000', resolve: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(await failing('172.20.0.2'), false);
});

test("the container's own addresses count as itself", async () => {
  const fromShell = createShellPeer({ base: () => 'http://aura-shell:3000', resolve: async () => ['172.20.0.2'], own: () => ['172.20.0.7', 'fe80::1'] });
  assert.equal(await fromShell('172.20.0.7'), true);
  assert.equal(await fromShell('172.20.0.8'), false);
});

test('the shell on a private Terminal network (D58): its AURA_SHELL_PEERS name counts too', async () => {
  const dns = { 'aura-shell': ['172.20.0.2'], 'aura-shell.aura-term-default': ['172.30.0.2'] };
  const asked = [];
  const fromShell = createShellPeer({
    base: () => 'http://aura-shell:3000',
    peers: () => ['aura-shell.aura-term-default', ' ', ''],
    resolve: async (host) => { asked.push(host); if (!dns[host]) throw new Error('ENOTFOUND'); return dns[host]; },
  });
  assert.equal(await fromShell('172.30.0.2'), true, 'the shell, by its address on the private network');
  assert.equal(await fromShell('172.20.0.2'), true, 'and on the app network');
  assert.equal(await fromShell('172.30.0.3'), false, 'another Terminal on the private network is no shell');
  assert.deepEqual([...new Set(asked)].sort(), ['aura-shell', 'aura-shell.aura-term-default']);
  // A peer name that does not resolve costs nothing else.
  const partial = createShellPeer({
    base: () => 'http://aura-shell:3000', peers: () => ['nope.example'], resolve: async (h) => { if (h !== 'aura-shell') throw new Error('x'); return ['172.20.0.2']; },
  });
  assert.equal(await partial('172.20.0.2'), true);
  // No base, no shell: peers alone admit nobody.
  const none = createShellPeer({ base: () => undefined, peers: () => ['aura-shell.aura-term-default'], resolve: async () => ['172.30.0.2'] });
  assert.equal(await none('172.30.0.2'), false);
});

// D89 B4: the relay claim on a call from the shell's address.
import { createShellRelay } from '../dist/shell-peer.js';
import { relayKey, signRelayClaim } from '../dist/relayClaim.js';

test('relay: self needs no claim, another container never passes, the shell is checked', async () => {
  const peer = createShellPeer({ base: () => 'http://aura-shell:3000', resolve: async () => ['172.20.0.2'], own: () => ['172.20.0.7'] });
  assert.equal(await peer.peerKind('127.0.0.1'), 'self');
  assert.equal(await peer.peerKind('172.20.0.7'), 'self');
  assert.equal(await peer.peerKind('172.20.0.2'), 'shell');
  assert.equal(await peer.peerKind('172.20.0.9'), null);
  let mode = 'warn';
  const reports = [];
  const check = createShellRelay({
    peerKind: peer.peerKind, lifecycleToken: () => 'lt-1', instanceId: () => 'com.aura.terminal-2', mode: () => mode,
    report: (v, call) => reports.push([v, call.method, call.path, call.mode]),
  });
  const good = signRelayClaim(relayKey('lt-1'), { i: 'com.aura.terminal-2', m: 'GET', p: '/ws?session=a', u: 'owner-1', c: 'user' });
  const call = (p, header, path = '/ws?session=a') => check({ peer: p, header, method: 'GET', path });

  assert.deepEqual(await call('127.0.0.1', undefined), { ok: true, verdict: 'self', claim: null });
  assert.deepEqual(await call('172.20.0.9', good), { ok: false, verdict: null, claim: null }, 'a claim never makes another address the shell');
  const valid = await call('172.20.0.2', good);
  assert.equal(valid.ok, true);
  assert.equal(valid.verdict, 'valid');
  assert.equal(valid.claim.u, 'owner-1', 'the user the shell authorized');
  assert.deepEqual(await call('172.20.0.2', [good]), valid, 'Node may hand an array');

  // warn: served, reported
  assert.equal((await call('172.20.0.2', undefined)).ok, true);
  assert.equal((await call('172.20.0.2', 'agr1.bad.mac')).verdict, 'invalid');
  assert.equal((await call('172.20.0.2', good, '/api/sessions')).verdict, 'invalid', 'bound to its path');
  assert.deepEqual(reports, [['missing', 'GET', '/ws?session=a', 'warn'], ['invalid', 'GET', '/ws?session=a', 'warn'], ['invalid', 'GET', '/api/sessions', 'warn']]);

  // strict: refused
  mode = 'strict';
  assert.equal((await call('172.20.0.2', undefined)).ok, false);
  assert.equal((await call('172.20.0.2', 'agr1.bad.mac')).ok, false);
  assert.equal((await call('172.20.0.2', good)).ok, true);
  assert.equal((await call('127.0.0.1', undefined)).ok, true, 'self still needs none');
});

test('relay: without a lifecycle token (an app started by hand) nothing verifies; warn still serves', async () => {
  const check = createShellRelay({
    peerKind: async () => 'shell', lifecycleToken: () => undefined, instanceId: () => 'x-1', mode: () => undefined,
  });
  const r = await check({ peer: '172.20.0.2', header: 'agr1.a.b', method: 'GET', path: '/' });
  assert.deepEqual(r, { ok: true, verdict: 'invalid', claim: null });
});

test('relay: the live check reads AURA_RELAY_STRICT and the start\'s token at call time', async () => {
  const { checkShellRelay, relayCounts } = await import('../dist/shell-peer.js');
  const prev = { ...process.env };
  try {
    process.env.OS_API_BASE = 'http://10.77.0.2:3000';
    process.env.AURA_LIFECYCLE_TOKEN = 'lt-live';
    process.env.APP_INSTANCE_ID = 'com.aura.aurashelld-1';
    delete process.env.AURA_RELAY_STRICT;
    const before = relayCounts.missing;
    assert.equal((await checkShellRelay({ peer: '10.77.0.2', header: null, method: 'POST', path: '/api/mcp/shell' })).ok, true);
    assert.equal(relayCounts.missing, before + 1);
    process.env.AURA_RELAY_STRICT = 'strict';
    assert.equal((await checkShellRelay({ peer: '10.77.0.2', header: null, method: 'POST', path: '/api/mcp/shell' })).ok, false);
    const good = signRelayClaim(relayKey('lt-live'), { i: 'com.aura.aurashelld-1', m: 'POST', p: '/api/mcp/shell' });
    assert.equal((await checkShellRelay({ peer: '10.77.0.2', header: good, method: 'POST', path: '/api/mcp/shell' })).verdict, 'valid');
  } finally {
    for (const k of ['OS_API_BASE', 'AURA_LIFECYCLE_TOKEN', 'APP_INSTANCE_ID', 'AURA_RELAY_STRICT']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
});
