// F0a follow-up: a container adopted after a shell restart gets the
// lifecycle checks a fresh start makes (health identity + the runtime check
// of the health guard), recorded as its `lifecycle` status and never used to
// stop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { AppManager } from '../dist/app-manager/AppManager.js';

const HEADER = 'x-aura-lifecycle';
function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
const close = (server) => new Promise((r) => server.close(r));

/** A runner tracking one adopted container, without the constructor's Docker side effects. */
function runnerWith(rec) {
  const r = Object.create(ContainerRunner.prototype);
  r.containers = new Map([[rec.instanceId, { containerId: rec.hostname, logTail: null, exitCb: null, expectingKill: false, ...rec }]]);
  return r;
}

const APP = 'com.ex.notes';
const ID = 'com.ex.notes-1';

test('a guarded app: identity match, 401 on the wrong token; the right token goes only to the bound address', async () => {
  const seen = [];
  const { server, port } = await listen((req, res) => {
    const t = req.headers[HEADER];
    seen.push(t ?? null);
    if (t !== undefined && t !== 'tok') { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, appId: APP, instanceId: ID }));
  });
  try {
    const r = runnerWith({ instanceId: ID, appId: APP, hostname: 'aura-x', address: '127.0.0.1', lifecycleToken: 'tok', port });
    const st = await r.measureAdopted(ID);
    assert.deepEqual(st, { identity: 'match', guard: '401' });
    assert.deepEqual(r.lifecycleStatus(ID), st);
    assert.equal(seen[0], 'tok');
    assert.notEqual(seen[1], 'tok');
  } finally { await close(server); }
});

test('an unguarded legacy app is measured and reported, not refused', async () => {
  const { server, port } = await listen((_req, res) => { res.writeHead(200).end('ok'); });
  try {
    const r = runnerWith({ instanceId: ID, appId: APP, hostname: 'aura-x', address: '127.0.0.1', lifecycleToken: 'tok', port });
    assert.deepEqual(await r.measureAdopted(ID), { identity: 'legacy', guard: 'accepted-wrong-token' });
    assert.ok(r.containers.has(ID), 'still tracked: an adopted instance is never stopped for it');
  } finally { await close(server); }
});

test('no health answer: not measured; unknown instance: null', async () => {
  const { server, port } = await listen((_req, res) => { res.writeHead(503).end(); });
  try {
    const r = runnerWith({ instanceId: ID, appId: APP, hostname: 'aura-x', address: '127.0.0.1', lifecycleToken: 'tok', port });
    assert.equal(await r.measureAdopted(ID), null);
    assert.equal(r.lifecycleStatus(ID), null);
    assert.equal(await r.measureAdopted('nope'), null);
  } finally { await close(server); }
});

test('without a bound address the token is never sent', async () => {
  const seen = [];
  const { server, port } = await listen((req, res) => {
    seen.push(req.headers[HEADER] ?? null);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ appId: APP, instanceId: ID }));
  });
  try {
    // The DNS name is unreachable in a test; use the loopback name instead.
    const r = runnerWith({ instanceId: ID, appId: APP, hostname: '127.0.0.1', address: null, lifecycleToken: 'tok', port });
    await r.measureAdopted(ID);
    assert.equal(seen.includes('tok'), false);
  } finally { await close(server); }
});

test('AppManager records the adopted instance\'s status', async () => {
  const inst = { instanceId: ID, appId: APP };
  const fake = {
    instances: new Map([[ID, inst]]),
    runners: { container: { measureAdopted: async () => ({ identity: 'match', guard: '401' }) } },
  };
  await AppManager.prototype.measureAdopted.call(fake, ID);
  assert.deepEqual(inst.lifecycle, { identity: 'match', guard: '401' });
  fake.runners.container.measureAdopted = async () => { throw new Error('boom'); };
  await AppManager.prototype.measureAdopted.call(fake, ID); // never throws
});
