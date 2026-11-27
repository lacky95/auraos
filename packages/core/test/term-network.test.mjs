// The private Terminal network (D58, Phase 5 stream N): one internal Docker
// network per user, the System Terminal on it and on the shared network (the
// shared one carrying its default route), its servers listening only on its
// private address, and the shell dialling that address.
//
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { TermNetworks, termNetworkName, TERM_NETWORK_CONTAINER_LABEL } from '../dist/runtimes/container/networks.js';
import {
  TERMINAL_APP_ID, containerNetworkArgs, containerNetworkEnv, containerShellBase, terminalNetworkUser,
} from '../dist/runtimes/spawn/networkArgs.js';
import { LISTEN_HOST_SHELL } from '../dist/app-manager/provisioning.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';

/** A fake docker CLI over an in-memory set of networks and the shell's attachments. */
function fakeDocker({ networks = {}, shellNets = ['aura-net'], failCreate = null } = {}) {
  const calls = [];
  const fail = (stderr) => { const e = new Error('docker failed'); e.stderr = stderr; throw e; };
  const docker = (args) => {
    calls.push(args.join(' '));
    const [a, b] = args;
    if (a === 'network' && b === 'inspect') {
      const n = networks[args.at(-1)];
      if (!n) fail(`Error response from daemon: network ${args.at(-1)} not found`);
      return `${n.internal}\t${n.user ?? '<no value>'}\t${(n.subnets ?? []).map((s) => `${s} `).join('')}\n`;
    }
    if (a === 'network' && b === 'create') {
      if (failCreate) fail(failCreate);
      const name = args.at(-1);
      const user = args[args.indexOf('--label') + 1].split('=')[1];
      networks[name] = { internal: args.includes('--internal'), user, subnets: ['172.30.0.0/16'] };
      return 'id\n';
    }
    if (a === 'network' && b === 'ls') return Object.entries(networks).filter(([, n]) => n.user).map(([k]) => k).join('\n') + '\n';
    if (a === 'network' && b === 'connect') { shellNets.push(args[2]); return ''; }
    if (a === 'inspect') return JSON.stringify(Object.fromEntries(shellNets.map((n) => [n, {}]))) + '\n';
    fail(`unexpected ${args.join(' ')}`);
  };
  return { docker, calls, networks, shellNets };
}

test('termNetworkName: aura-term-<userId>, only for a valid user id', () => {
  assert.equal(termNetworkName('default'), 'aura-term-default');
  assert.equal(termNetworkName('u-2.x'), 'aura-term-u-2.x');
  for (const bad of ['', 'Owner', '../x', 'a b', '-x', 'x'.repeat(65)]) assert.throws(() => termNetworkName(bad));
});

test('ensure creates the user network --internal and labelled, and the shell joins it', () => {
  const f = fakeDocker();
  const nets = new TermNetworks(() => 'shell-id', f.docker);
  assert.deepEqual(nets.ensure('default'), { name: 'aura-term-default', subnet: '172.30.0.0/16' });
  assert.ok(f.calls.includes('network create --internal --label aura.term.user=default aura-term-default'));
  assert.ok(f.calls.includes('network connect aura-term-default shell-id'));
  // Again: nothing created or connected twice.
  const before = f.calls.length;
  nets.ensure('default');
  assert.equal(f.calls.slice(before).filter((c) => /create|connect/.test(c)).length, 0);
});

test('ensure fails closed on a network it must not use', () => {
  const cases = [
    [{ internal: false, user: 'default', subnets: ['172.30.0.0/16'] }, /not an internal network/],
    [{ internal: true, user: 'mallory', subnets: ['172.30.0.0/16'] }, /not labelled/],
    [{ internal: true, subnets: ['172.30.0.0/16'] }, /not labelled/],
    [{ internal: true, user: 'default', subnets: ['fd00::/64'] }, /no IPv4 subnet/],
  ];
  for (const [net, re] of cases) {
    const f = fakeDocker({ networks: { 'aura-term-default': net } });
    assert.throws(() => new TermNetworks(() => 'shell', f.docker).ensure('default'), re);
    assert.ok(!f.calls.some((c) => c.startsWith('network connect')), 'the shell never joins a refused network');
  }
  const noShell = fakeDocker();
  assert.throws(() => new TermNetworks(() => null, noShell.docker).ensure('default'), /own container is unknown/);
  const createFails = fakeDocker({ failCreate: 'permission denied' });
  assert.throws(() => new TermNetworks(() => 'shell', createFails.docker).ensure('default'), /cannot create aura-term-default/);
});

test('ensure tolerates a concurrent create of the same network', () => {
  const f = fakeDocker({ failCreate: 'network with name aura-term-default already exists' });
  // The racing creator made it: the inspect after the failed create finds it.
  const docker = (args) => {
    if (args[0] === 'network' && args[1] === 'create') f.networks['aura-term-default'] = { internal: true, user: 'default', subnets: ['172.31.0.0/16'] };
    return f.docker(args);
  };
  assert.deepEqual(new TermNetworks(() => 'shell', docker).ensure('default'), { name: 'aura-term-default', subnet: '172.31.0.0/16' });
});

test('joinExisting: at boot the shell joins every internal Terminal network it is not on', () => {
  const f = fakeDocker({
    networks: {
      'aura-term-default': { internal: true, user: 'default', subnets: ['172.30.0.0/16'] },
      'aura-term-u2': { internal: true, user: 'u2', subnets: ['172.31.0.0/16'] },
      'aura-term-open': { internal: false, user: 'open', subnets: ['172.32.0.0/16'] },
    },
    shellNets: ['aura-net', 'aura-term-u2'],
  });
  new TermNetworks(() => 'shell', f.docker).joinExisting();
  assert.deepEqual(f.calls.filter((c) => c.startsWith('network connect')), ['network connect aura-term-default shell']);
});

test('only the built-in System Terminal gets a private network; an unclaimed pool member is the owner\'s', () => {
  assert.equal(TERMINAL_APP_ID, 'com.aura.terminal');
  const sys = `/workspace/apps/${TERMINAL_APP_ID}`;
  assert.equal(terminalNetworkUser(TERMINAL_APP_ID, { appDir: sys, owner: 'u-2' }), 'u-2');
  assert.equal(terminalNetworkUser(TERMINAL_APP_ID, { appDir: sys }), 'default');
  assert.equal(terminalNetworkUser(TERMINAL_APP_ID, { appDir: `/data/scopes/users/default/apps/${TERMINAL_APP_ID}`, owner: 'default' }), null,
    'a same-id copy outside the system scope is no trusted Terminal');
  assert.equal(terminalNetworkUser('com.aura.counter', { appDir: '/workspace/apps/com.aura.counter', owner: 'default' }), null);
});

test('network argv: two networks, the shared one with gateway priority; env after the context env', () => {
  assert.deepEqual(containerNetworkArgs({ network: 'aura-net' }), ['--network', 'aura-net']);
  assert.deepEqual(containerNetworkEnv({ shellHostname: 'aura-shell' }), []);
  const term = { name: 'aura-term-default', subnet: '172.30.0.0/16' };
  assert.deepEqual(containerNetworkArgs({ network: 'aura-net', term }), [
    '--network', 'name=aura-term-default',
    '--network', 'name=aura-net,gw-priority=1',
    '--label', `${TERM_NETWORK_CONTAINER_LABEL}=aura-term-default`,
  ]);
  assert.deepEqual(containerNetworkEnv({ term, shellHostname: 'aura-shell' }), [
    '-e', 'AURA_LISTEN_SUBNET=172.30.0.0/16',
    '-e', 'AURA_SHELL_PEERS=aura-shell.aura-term-default',
  ]);
});

function listenHost(env) {
  const r = spawnSync('bash', ['-c', `set -e\n${LISTEN_HOST_SHELL}\necho "$LISTEN_HOST"`], {
    encoding: 'utf-8', env: { PATH: process.env.PATH, APP_ID: 'com.aura.terminal', ...env },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('the start script listens on every address, or only on its own address in AURA_LISTEN_SUBNET', () => {
  assert.deepEqual(listenHost({}), { status: 0, out: '0.0.0.0', err: '' });
  assert.deepEqual(listenHost({ AURA_LISTEN_SUBNET: '127.0.0.0/8' }), { status: 0, out: '127.0.0.1', err: '' });
  // No address of this container in the subnet: no start, never 0.0.0.0.
  const none = listenHost({ AURA_LISTEN_SUBNET: '203.0.113.0/24' });
  assert.equal(none.status, 1);
  assert.equal(none.out, '');
  assert.match(none.err, /no address in AURA_LISTEN_SUBNET=203\.0\.113\.0\/24; not starting/);
});

test('getHost: the shell dials a Terminal at its private address, every other container by name', () => {
  const runner = new ContainerRunner({
    baseRootfs: '/nonexistent', toolchainDir: '/nonexistent', appsDir: '/nonexistent', dataDir: '/nonexistent', osApiBase: 'http://127.0.0.1:3000',
  });
  const base = { containerId: 'c', port: 4001, logTail: null, pid: 0, exitCb: null, expectingKill: false };
  runner.containers.set('com.aura.terminal-1', {
    ...base, hostname: 'aura-com.aura.terminal-1', appId: 'com.aura.terminal', address: '172.30.0.3', dialByAddress: true,
    addresses: ['172.18.0.9', '172.30.0.3'],
  });
  runner.containers.set('com.aura.counter-1', {
    ...base, hostname: 'aura-com.aura.counter-1', appId: 'com.aura.counter', address: '172.18.0.5', dialByAddress: false, addresses: ['172.18.0.5'],
  });
  runner.containers.set('com.aura.terminal-2', {
    ...base, hostname: 'aura-com.aura.terminal-2', appId: 'com.aura.terminal', address: null, dialByAddress: true, addresses: [],
  });
  assert.equal(runner.getHost('com.aura.terminal-1'), '172.30.0.3');
  assert.equal(runner.getHost('com.aura.counter-1'), 'aura-com.aura.counter-1');
  assert.equal(runner.getHost('com.aura.terminal-2'), 'aura-com.aura.terminal-2', 'no address read: by name (closed: nothing listens there)');
  assert.equal(runner.getHost('nope'), null);
  assert.deepEqual(runner.addresses('com.aura.terminal-1'), ['172.18.0.9', '172.30.0.3']);
  assert.deepEqual(runner.addresses('nope'), []);
});

test('adoption after a shell restart keeps the Terminal dialled at its private address', () => {
  const runner = new ContainerRunner({
    baseRootfs: '/nonexistent', toolchainDir: '/nonexistent', appsDir: '/nonexistent', dataDir: '/nonexistent', osApiBase: 'http://127.0.0.1:3000',
  });
  runner.registerAdopted({
    instanceId: 'com.aura.terminal-4', appId: 'com.aura.terminal', port: 4001, hostname: 'aura-com.aura.terminal-4', pid: 0,
    address: '172.30.0.4', addresses: ['172.18.0.4', '172.30.0.4'], dialByAddress: true, lifecycleToken: 'tok',
  });
  runner.registerAdopted({
    instanceId: 'com.aura.counter-4', appId: 'com.aura.counter', port: 4002, hostname: 'aura-com.aura.counter-4', pid: 0, address: '172.18.0.5',
  });
  try {
    assert.equal(runner.getHost('com.aura.terminal-4'), '172.30.0.4');
    assert.deepEqual(runner.addresses('com.aura.terminal-4'), ['172.18.0.4', '172.30.0.4']);
    assert.equal(runner.getHost('com.aura.counter-4'), 'aura-com.aura.counter-4');
    assert.deepEqual(runner.addresses('com.aura.counter-4'), []);
  } finally {
    runner.forceKill('com.aura.terminal-4');
    runner.forceKill('com.aura.counter-4');
  }
});



test('D89 B8: a Terminal names the shell by its private-network name; every other app keeps OS_API_BASE', () => {
  const term = { name: 'aura-term-default', subnet: '172.30.0.0/16' };
  assert.equal(containerShellBase({ osApiBase: 'http://aura-shell:3000', shellHostname: 'aura-shell' }), 'http://aura-shell:3000');
  assert.equal(containerShellBase({ osApiBase: 'http://aura-shell:3000', term, shellHostname: 'aura-shell' }), 'http://aura-shell.aura-term-default:3000');
  // A base that does not name the shell (a custom setup) is left alone; so is a network the shell's host policy would refuse.
  assert.equal(containerShellBase({ osApiBase: 'http://aura-shell:3000', term: { name: 'aura-term-u.x', subnet: term.subnet }, shellHostname: 'aura-shell' }), 'http://aura-shell:3000');
  assert.equal(containerShellBase({ osApiBase: 'http://10.0.0.5:3000', term, shellHostname: 'aura-shell' }), 'http://10.0.0.5:3000');
});
