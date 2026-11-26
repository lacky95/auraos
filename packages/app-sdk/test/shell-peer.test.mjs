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
