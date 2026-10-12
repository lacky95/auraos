import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PortManager } from '../dist/app-manager/PortManager.js';

const spec = { kind: 'host', sourceAppId: 'test.source', sourcePort: 5174, port: 15174, bindAddr: '192.0.2.10' };
function fixture(t, failure) {
  const calls = [];
  let probes = 0;
  t.mock.method(net, 'createServer', () => {
    probes++;
    const server = new EventEmitter();
    server.listen = () => { queueMicrotask(() => server.emit('error', Object.assign(new Error('container has no host NIC'), { code: 'EADDRNOTAVAIL' }))); return server; };
    server.close = callback => { callback?.(); return server; };
    return server;
  });
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'docker');
    calls.push(args);
    failure?.(args);
    if (args[0] === 'ps') return '';
    if (args[0] === 'create') return Buffer.from('new-forwarder-id\n');
    if (args[0] === 'inspect') return 'true\n';
    return Buffer.from('');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const manager = new PortManager({ dataDir: '/unused', runner: { isRunning: () => true }, registry: {}, resolveRunningInstance: () => ({ instanceId: 'test.source' }) });
  return { manager, calls, probes: () => probes };
}
function dockerError(message) { return Object.assign(new Error('docker failed'), { stderr: Buffer.from(message) }); }

test('publishes a host interface absent from the shell container', async t => {
  const { manager, calls, probes } = fixture(t);
  const result = await manager.expose('test.source', spec);
  assert.equal(result.bindAddr, '192.0.2.10');
  assert.equal(result.port, 15174);
  assert.equal(probes(), 0, 'host ports must not be probed inside the shell network namespace');
  const create = calls.find(args => args[0] === 'create');
  assert.equal(create[create.indexOf('-p') + 1], '192.0.2.10:15174:5000');
  assert.ok(calls.some(args => args[0] === 'start' && args[1] === 'new-forwarder-id'));
});

test('reports a real Docker bind conflict and removes only the newly created forwarder', async t => {
  const { manager, calls } = fixture(t, args => { if (args[0] === 'start') throw dockerError('bind: address already in use'); });
  await assert.rejects(manager.expose('test.source', spec), /conflicts: bind: address already in use/);
  assert.deepEqual(calls.filter(args => args[0] === 'rm'), [['rm', '-f', 'new-forwarder-id']]);
});

test('preserves address-unavailable errors instead of claiming the port is occupied', async t => {
  const { manager, calls } = fixture(t, args => { if (args[0] === 'start') throw dockerError('bind: cannot assign requested address'); });
  await assert.rejects(manager.expose('test.source', spec), /could not start forwarder: bind: cannot assign requested address/);
  assert.deepEqual(calls.filter(args => args[0] === 'rm'), [['rm', '-f', 'new-forwarder-id']]);
});

test('does not remove an existing container on a Docker create/name conflict', async t => {
  const { manager, calls } = fixture(t, args => { if (args[0] === 'create') throw dockerError('Conflict. Container name already in use'); });
  await assert.rejects(manager.expose('test.source', spec), /conflicts/);
  assert.equal(calls.filter(args => args[0] === 'rm').length, 0);
});

test('into forwarding still joins the target namespace without publishing a host port', async t => {
  const { manager, calls } = fixture(t);
  const result = await manager.expose('test.target', { kind: 'into', sourceAppId: 'test.source', sourcePort: 5174 });
  assert.equal(result.kind, 'into');
  const create = calls.find(args => args[0] === 'create');
  assert.equal(create[create.indexOf('--network') + 1], 'container:aura-test.target');
  assert.equal(create.includes('-p'), false);
});
