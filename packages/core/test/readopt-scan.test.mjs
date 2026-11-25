// Re-adoption after a shell restart: the survivor scan and the adoption of
// what it finds. Live 2026-11-25: the scan's `docker ps --format {{json .}}`
// made the daemon compute every container's disk size, timed out at boot, and
// the failure looked like "no survivors" — nothing was adopted, sidecars of
// the survivors were reaped, and the untracked containers kept running.
//
// A fake `docker` on PATH answers the scan (no Docker needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { PortAllocator } from '../dist/app-manager/PortAllocator.js';

let dir;
let savedPath;
const psLog = () => (existsSync(join(dir, 'ps.log')) ? readFileSync(join(dir, 'ps.log'), 'utf-8') : '');

/** One `docker inspect` answer. `env` and `labels` as docker reports them. */
function container(name, { env = {}, labels = {}, ip = '172.26.0.9' } = {}) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    Config: { Env: Object.entries(env).map(([k, v]) => `${k}=${v}`), Labels: labels },
    State: { Pid: 4242 },
    NetworkSettings: { Networks: { 'aura-net': { IPAddress: ip } } },
  }));
}
const appEnv = (appId, instanceId, port = 4001) => ({ APP_ID: appId, APP_INSTANCE_ID: instanceId, APP_PORT: String(port) });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'readopt-scan-'));
  const docker = join(dir, 'docker');
  writeFileSync(docker, `#!/bin/sh
D="${dir}"
case "$1" in
  ps) echo "$*" >> "$D/ps.log"; [ -f "$D/ps.fail" ] && exit 1; cat "$D/ps.out" ;;
  inspect) cat "$D/$2.json" 2>/dev/null || exit 1 ;;
  *) exit 1 ;;
esac
`);
  chmodSync(docker, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;

  container('aura-shell', { env: appEnv('x', 'x') });
  container('aura-com.aura.terminal-3', { env: appEnv('com.aura.terminal', 'com.aura.terminal-3'), labels: { 'aura.owner': 'default', 'aura.token.nonce': 'n3' } });
  // A warm-pool member is spawned without an owner; docker labels never change on claim.
  container('aura-com.aura.terminal-4', { env: appEnv('com.aura.terminal', 'com.aura.terminal-4') });
  container('aura-io.ex.board', { env: appEnv('io.ex.board', 'io.ex.board', 4013), labels: { 'aura.owner': 'default' } });
  container('aura-io.ex.board--db', { env: appEnv('io.ex.board', 'io.ex.board'), labels: { 'aura.parent': 'io.ex.board' } });
  container('aura-aura-base-1', { labels: { 'com.docker.compose.project': 'aura' } });
  writeFileSync(join(dir, 'ps.out'), [
    'aura-shell', 'aura-com.aura.terminal-3', 'aura-com.aura.terminal-4',
    'aura-io.ex.board', 'aura-io.ex.board--db', 'aura-aura-base-1', 'aura-gone',
  ].join('\n') + '\n');
});
after(() => { process.env.PATH = savedPath; rmSync(dir, { recursive: true, force: true }); });

const runner = () => Object.create(ContainerRunner.prototype);

test('the scan lists names only: no {{json .}}, which makes docker compute container sizes', async () => {
  rmSync(join(dir, 'ps.log'), { force: true });
  await runner().listOrphanRecords();
  const args = psLog();
  assert.match(args, /--format \{\{\.Names\}\}/);
  assert.doesNotMatch(args, /json|Size/);
});

test('every app container is found from its env; the shell, sidecars and foreign containers are not', async () => {
  const recs = await runner().listOrphanRecords();
  assert.deepEqual(recs.map((r) => r.instanceId).sort(), ['com.aura.terminal-3', 'com.aura.terminal-4', 'io.ex.board']);
  const t3 = recs.find((r) => r.instanceId === 'com.aura.terminal-3');
  assert.equal(t3.appId, 'com.aura.terminal');
  assert.equal(t3.port, 4001);
  assert.equal(t3.hostname, 'aura-com.aura.terminal-3');
  assert.equal(t3.ownerLabel, 'default');
  assert.equal(t3.tokenNonce, 'n3');
  assert.equal(recs.find((r) => r.instanceId === 'com.aura.terminal-4').ownerLabel, undefined);
});

test('a failed scan is null ("unknown"), never an empty list ("no survivors")', async () => {
  writeFileSync(join(dir, 'ps.fail'), '');
  try { assert.equal(await runner().listOrphanRecords(), null); }
  finally { rmSync(join(dir, 'ps.fail')); }
});

// ── AppManager.adoptOrphans ────────────────────────────────────────────────

function fakeManager(records, { pooled = [], running = [] } = {}) {
  const calls = { registered: [], tokens: [], exits: [], providers: [] };
  const fake = {
    instances: new Map(),
    nextInstanceNum: new Map(),
    fsm: { set: () => {} },
    ports: new PortAllocator(4001, 4010),
    tokens: { register: (id, nonce) => calls.tokens.push([id, nonce]) },
    registry: { getById: (appId) => (appId === 'io.ex.gone' ? undefined : { id: appId }) },
    providers: { registerInstance: (i) => calls.providers.push(i.instanceId) },
    interfaces: { registerInstance: () => {} },
    runners: {
      container: {
        listOrphanRecords: async () => records,
        isRunning: (id) => running.includes(id),
        registerAdopted: (o) => calls.registered.push(o.instanceId),
        onExit: (id) => calls.exits.push(id),
      },
    },
    loadPoolIds: () => new Set(pooled),
    handleUnexpectedExit: () => {},
  };
  return { fake, calls, adopt: () => AppManager.prototype.adoptOrphans.call(fake) };
}
const rec = (instanceId, appId, extra = {}) => ({ instanceId, appId, port: 4001, hostname: `aura-${instanceId}`, pid: 1, ...extra });

test('a failed scan adopts nothing and reports it (the caller retries)', async () => {
  const { fake, adopt } = fakeManager(null);
  assert.equal(await adopt(), false);
  assert.equal(fake.instances.size, 0);
});

test('owner label cases: labelled, unlabelled (pre-owner or claimed pool member), idle pool member', async () => {
  const { fake, calls, adopt } = fakeManager([
    rec('com.aura.terminal-3', 'com.aura.terminal', { ownerLabel: 'default', tokenNonce: 'n3' }),
    rec('com.aura.terminal-4', 'com.aura.terminal'),
    rec('com.aura.terminal-5', 'com.aura.terminal'),
    rec('io.ex.board', 'io.ex.board', { ownerLabel: 'BAD OWNER' }),
  ], { pooled: ['com.aura.terminal-5'] });
  assert.equal(await adopt(), true);
  const i = (id) => fake.instances.get(id);
  assert.equal(i('com.aura.terminal-3').owner, 'default');
  assert.equal(i('com.aura.terminal-3').state, 'resumed');
  assert.equal(i('com.aura.terminal-3').sandbox, 'container');
  assert.equal(i('com.aura.terminal-4').owner, 'default');
  assert.equal(i('com.aura.terminal-4').inPool, false);
  assert.equal(i('com.aura.terminal-5').owner, undefined);
  assert.equal(i('com.aura.terminal-5').inPool, true);
  assert.equal(i('io.ex.board').owner, 'default', 'a malformed label falls back to the local owner');
  assert.deepEqual(calls.tokens, [['com.aura.terminal-3', 'n3']]);
  assert.equal(calls.registered.length, 4);
  assert.equal(calls.exits.length, 4, 'every adopted container has its exit watcher');
  assert.equal(fake.nextInstanceNum.get('com.aura.terminal'), 5, 'new spawns never reuse an adopted name');
});

test('a late pass (reconciler) skips instances already tracked or still the runner\'s', async () => {
  const { fake, calls, adopt } = fakeManager([
    rec('com.aura.docs', 'com.aura.docs'),
    rec('com.aura.terminal-2', 'com.aura.terminal'),
    rec('com.aura.notepad', 'com.aura.notepad'),
  ], { running: ['com.aura.terminal-2'] });
  const tracked = { instanceId: 'com.aura.docs', appId: 'com.aura.docs', state: 'resumed' };
  fake.instances.set('com.aura.docs', tracked);
  assert.equal(await adopt(), true);
  assert.equal(fake.instances.get('com.aura.docs'), tracked, 'untouched');
  assert.equal(fake.instances.has('com.aura.terminal-2'), false, 'mid-stop: not adopted back');
  assert.deepEqual(calls.registered, ['com.aura.notepad']);
});

test('adopted ports stay taken: the next spawn gets another port', async () => {
  const { fake, adopt } = fakeManager([
    rec('com.aura.terminal-1', 'com.aura.terminal', { port: 4001 }),
    rec('com.aura.docs', 'com.aura.docs', { port: 4003 }),
  ]);
  assert.equal(await adopt(), true);
  assert.ok(fake.ports.isInUse(4001) && fake.ports.isInUse(4003));
  const next = [await fake.ports.allocate('a'), await fake.ports.allocate('b')];
  assert.ok(!next.includes(4001) && !next.includes(4003), `got ${next}`);
});

test('after adoption every running UI instance holds its App Host slot; pool members and services do not; never while adoption is pending', async () => {
  const claimed = [];
  const released = [];
  const slots = { 'com.aura.terminal': ['com.aura.terminal-1', 'com.aura.terminal-9'] };
  const manifests = { 'com.aura.terminal': {}, 'com.aura.svc': { componentType: 'service' } };
  const fake = {
    adoptionPending: false,
    instances: new Map([
      ['com.aura.terminal-1', { instanceId: 'com.aura.terminal-1', appId: 'com.aura.terminal', state: 'resumed' }],
      ['com.aura.terminal-3', { instanceId: 'com.aura.terminal-3', appId: 'com.aura.terminal', state: 'resumed' }],
      ['com.aura.terminal-5', { instanceId: 'com.aura.terminal-5', appId: 'com.aura.terminal', state: 'resumed', inPool: true }],
      ['com.aura.svc', { instanceId: 'com.aura.svc', appId: 'com.aura.svc', state: 'resumed' }],
      ['com.aura.terminal-7', { instanceId: 'com.aura.terminal-7', appId: 'com.aura.terminal', state: 'stopping' }],
    ]),
    registry: { getAll: () => Object.keys(manifests).map((id) => ({ id })), getById: (id) => manifests[id] },
    claimHostSlot: async (appId, id) => { claimed.push(id); },
  };
  const lifecycle = {
    releaseDeadSlots: async (appId, isLive) => { for (const id of slots[appId] ?? []) if (!isLive(id)) released.push(id); },
  };
  const settleSlots = (f) => AppManager.prototype.settleAdoptedSlots.call(f, lifecycle);
  await settleSlots(fake);
  assert.deepEqual(released, ['com.aura.terminal-9'], 'a slot whose instance did not survive is freed');
  assert.deepEqual(claimed, ['com.aura.terminal-1', 'com.aura.terminal-3'], 'held or restored (assignSlot is idempotent)');
  claimed.length = 0; released.length = 0;
  await settleSlots({ ...fake, adoptionPending: true });
  assert.deepEqual([claimed, released], [[], []], 'survivors unknown: nothing freed, nothing claimed');
});

test('while the survivors are unknown, sidecars are never reaped', async () => {
  const fake = {
    adoptionPending: true,
    runners: { container: { listSidecars: async () => { throw new Error('must not list'); } } },
  };
  await AppManager.prototype.syncSidecars.call(fake, 1);
});

test('M6: boot tries the scan once and leaves retries to the reconciler; the runner refuses survivors meanwhile; inspect is async', async () => {
  const src = readFileSync(new URL('../src/app-manager/AppManager.ts', import.meta.url), 'utf-8');
  const init = src.slice(src.indexOf('async init(): Promise<void> {'), src.indexOf('private async adoptOrphans('));
  assert.equal((init.match(/this\.adoptOrphans\(\)/g) ?? []).length, 1, 'one try in init');
  assert.doesNotMatch(init, /setTimeout/, 'no sleep in init');
  assert.match(src, /survivorsUnknown = \(\) => this\.adoptionPending/);
  const runnerSrc = readFileSync(new URL('../src/app-manager/ContainerRunner.ts', import.meta.url), 'utf-8');
  const scan = runnerSrc.slice(runnerSrc.indexOf('public async listOrphanRecords()'), runnerSrc.indexOf('public registerAdopted('));
  assert.doesNotMatch(scan, /execSync/, 'no blocking docker call in the scan');
  assert.match(runnerSrc, /survivorsUnknown: \(\) => this\.survivorsUnknown\(\)/);
  // The async inspect still reads every survivor.
  const recs = await runner().listOrphanRecords();
  assert.equal(recs.length, 3);
});
