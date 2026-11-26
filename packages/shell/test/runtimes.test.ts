// Phase 5 stream R: `/api/admin/runtimes/**` (lib/runtimes.ts) with the real
// `ownerAction`: a change from Settings or the Terminal needs the owner's
// `fresh` approval, the host operator acts directly, every change is audited.
// The registry is core's, with stub runners; the record is the sealed store
// on a memory Valkey. Plus the route manifest rows (moved out of `reserved`).
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, AuditInput } from '@aura/core';
import { ownerAction, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import {
  deleteOverride, getRuntimes, postCheck, postEnabled, postMigrate, putDefault, putSettings, type RuntimesDeps,
} from '../src/lib/runtimes.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';

class MemoryApprovals {
  records = new Map<string, ApprovalRecord>();
  now = 1_800_000_000_000;
  async create(request: ApprovalRequest): Promise<ApprovalResult> {
    const record = core.newApprovalRecord(request, core.newApprovalId(), this.now);
    this.records.set(record.id, record);
    return { ok: true, record };
  }
  async get(id: string) { return this.records.get(id) ?? null; }
  async listPending() { return [...this.records.values()].filter((r) => r.state === 'pending'); }
  private apply(id: string, event: core.ApprovalEvent): ApprovalResult {
    const r = this.records.get(id);
    if (!r) return { ok: false, reason: 'not-found' };
    const t = core.transitionApproval(r, event, this.now);
    if (t.ok) this.records.set(id, t.record);
    return t;
  }
  async approve(id: string, by: ApprovalDecider) { return this.apply(id, { type: 'approve', by }); }
  async deny(id: string, by: ApprovalDecider) { return this.apply(id, { type: 'deny', by }); }
  async consume(id: string, claim: ApprovalClaim) { return this.apply(id, { type: 'consume', claim }); }
  async isBlocked() { return false; }
  async block() { /* not used */ }
  async unblock() { return false; }
  async listBlocked() { return []; }
}

function memoryRedis() {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string, nx?: string) => { if (nx === 'NX' && data.has(k)) return null; data.set(k, v); return 'OK'; },
    eval: async (_s: string, _n: number, k: string, expected: string, next: string) => { if (data.get(k) !== expected) return 0; data.set(k, next); return 1; },
  };
}

const SETTINGS: CallerPrincipal = {
  kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified',
  through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' },
} as CallerPrincipal;
const OPERATOR: CallerPrincipal = { kind: 'operator', verification: 'verified' };
const FRESH_OWNER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: true };

const TMP = mkdtempSync(join(tmpdir(), 'runtimes-route-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);
const CONTAINER_CAPS: core.RuntimeCapabilities = {
  isolation: 'namespace', privateHomeSession: false, sessionExec: false, identity: 'none', readOnlyBinds: true,
  mounts: true, portExpose: true, sidecars: true, warmPool: true, survivesShellRestart: true,
};
const PROOT_CAPS: core.RuntimeCapabilities = {
  ...CONTAINER_CAPS, isolation: 'ptrace', readOnlyBinds: false, mounts: false, portExpose: false, sidecars: false, survivesShellRestart: false,
};

const parse = (m: Record<string, unknown>) => core.AppManifestSchema.parse({ name: 'A', version: '1.0.0', ...m });

let approvals: MemoryApprovals;
let caller: CallerPrincipal;
let audits: Array<{ action: string; opts: any }>;
let stopped: string[];
let instances: Array<Record<string, unknown>>;
let mgr: RuntimesDeps['mgr'];
let settings: core.RuntimeSettingsStore;

function ownerDeps(): OwnerActionDeps {
  return {
    approvals: {
      store: approvals as never,
      appName: (id) => (id === 'com.aura.settings' ? 'Settings' : null),
      audit: async (_e: AuditInput) => { /* approvals' own audit */ },
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => ({ identity: {} }),
  };
}

function deps(): RuntimesDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req, ownerDeps()),
    audit: async (_actor, action, opts) => { audits.push({ action, opts }); },
    mgr,
    env: { AURA_USE_PROOT: 'true' },
  };
}

beforeEach(() => {
  approvals = new MemoryApprovals();
  caller = OPERATOR;
  audits = [];
  stopped = [];
  instances = [{ instanceId: 'io.ex.kept-1', appId: 'io.ex.kept', state: 'resumed', sandbox: 'proot', runtimeSource: 'migration' }];
  const runtimes = new core.RuntimeRegistry();
  runtimes.register(core.containerRuntime({ capabilities: () => CONTAINER_CAPS } as never));
  runtimes.register(core.prootRuntime({ capabilities: () => PROOT_CAPS } as never, { baseRootfs: ROOTFS, env: { AURA_USE_PROOT: 'true' } }));
  const kv = memoryRedis();
  settings = new core.RuntimeSettingsStore({ identityKeyFile: join(mkdtempSync(join(TMP, 'k-')), 'identity.key'), redis: () => kv as never, registry: runtimes });
  const apps: core.MigrationApp[] = [
    { appId: 'io.ex.kept', manifest: parse({ id: 'io.ex.kept' }), installationId: 'i-kept', sourceMode: 'open' },
    { appId: 'io.ex.direct', manifest: parse({ id: 'io.ex.direct', useProot: false }), installationId: 'i-direct', sourceMode: 'open' },
    { appId: 'io.ex.closed', manifest: parse({ id: 'io.ex.closed' }), installationId: 'i-closed', sourceMode: 'closed' },
    { appId: 'io.ex.box', manifest: parse({ id: 'io.ex.box', sandbox: 'container' }), installationId: 'i-box', sourceMode: 'closed' },
    { appId: 'io.ex.new', manifest: parse({ id: 'io.ex.new' }), installationId: 'i-new', sourceMode: 'closed' },
  ];
  mgr = {
    runtimes, runtimeSettings: settings,
    runtimeApps: async () => apps,
    getAllInstances: () => instances as never,
    stop: async (id: string) => { stopped.push(id); },
  } as RuntimesDeps['mgr'];
});

async function migrate(): Promise<void> {
  const apps = (await mgr.runtimeApps()).filter((a) => a.appId !== 'io.ex.new');
  const r = await core.migrateLegacyRuntimes(apps, { store: settings, env: { useProotEnv: 'true', rootfsPresent: true }, dataDir: mkdtempSync(join(TMP, 'd-')) });
  assert.equal(r.ran, true);
}

const req = (method: string, body?: unknown) => ({
  request: new Request('http://shell.test/api/admin/runtimes', {
    method, headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }),
  cookies: {} as never,
});
const read = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });

test('GET: every runtime with its schema, capabilities and health; each installation\'s resolution and source; overrides and open decisions', async () => {
  await migrate();
  const { status, body } = await read(await getRuntimes(req('GET'), deps()));
  assert.equal(status, 200);
  assert.equal(body.default, 'container');
  const proot = body.runtimes.find((r: any) => r.id === 'proot');
  assert.deepEqual(proot.settingsSchema.properties.placement.enum, ['master', 'pool']);
  assert.deepEqual([proot.settings, proot.enabled, proot.health.status, proot.capabilities.readOnlyBinds], [{ placement: 'master' }, true, 'ok', false]);
  assert.deepEqual(proot.instances, [{ instanceId: 'io.ex.kept-1', appId: 'io.ex.kept', state: 'resumed', source: 'migration' }]);
  const by = Object.fromEntries(body.installations.map((i: any) => [i.appId, i]));
  assert.deepEqual([by['io.ex.kept'].runtime, by['io.ex.kept'].source], ['proot', 'migration']);
  assert.deepEqual([by['io.ex.box'].runtime, by['io.ex.box'].source], ['container', 'manifest']);
  assert.deepEqual([by['io.ex.new'].runtime, by['io.ex.new'].source, by['io.ex.new'].sandbox], ['container', 'default', 'omitted']);
  assert.equal(by['io.ex.direct'].error.code, 'runtime-decision-needed');
  assert.deepEqual(body.overrides.map((o: any) => [o.installationId, o.source, o.legacy]), [['i-kept', 'migration', 'proot-master']]);
  assert.deepEqual(body.pending.map((p: any) => p.appId).sort(), ['io.ex.closed', 'io.ex.direct']);
  assert.ok(body.migration.d75);
});

test('a change from Settings needs the owner\'s password (fresh); the operator acts directly; audited', async () => {
  caller = SETTINGS;
  const first = await read(await putDefault(req('PUT', { runtime: 'proot' }), deps()));
  assert.equal(first.status, 202);
  const rec = approvals.records.get(first.body.approvalId)!;
  assert.equal(rec.level, 'fresh');
  assert.equal((await settings.get()).default, 'container', 'nothing changed yet');
  await approvals.approve(rec.id, FRESH_OWNER);
  const again = new Request('http://shell.test/api/admin/runtimes/default', {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-aura-approval': rec.id }, body: JSON.stringify({ runtime: 'proot' }),
  });
  const done = await read(await putDefault({ request: again, cookies: {} as never }, deps()));
  assert.deepEqual([done.status, done.body.default], [200, 'proot']);
  assert.deepEqual(audits.map((a) => a.action), ['runtime.default-changed']);
  caller = OPERATOR;
  assert.equal((await putDefault(req('PUT', { runtime: 'gvisor' }), deps())).status, 404, 'unknown runtime');
});

test('disable: refused while instances run unless stopInstances; container and the default cannot be disabled', async () => {
  const refused = await read(await postEnabled(req('POST', {}), 'proot', false, deps()));
  assert.deepEqual([refused.status, refused.body.error, refused.body.instances], [409, 'instances-running', ['io.ex.kept-1']]);
  const ok = await read(await postEnabled(req('POST', { stopInstances: true }), 'proot', false, deps()));
  assert.deepEqual([ok.status, ok.body.enabled, ok.body.stopped], [200, ['container'], ['io.ex.kept-1']]);
  assert.deepEqual(stopped, ['io.ex.kept-1']);
  assert.deepEqual(audits.map((a) => a.action), ['runtime.disabled']);
  instances = [];
  assert.equal((await postEnabled(req('POST', {}), 'container', false, deps())).status, 409);
  assert.equal((await postEnabled(req('POST'), 'proot', true, deps())).status, 200);
  await putDefault(req('PUT', { runtime: 'proot' }), deps());
  const busy = await read(await postEnabled(req('POST', {}), 'proot', false, deps()));
  assert.deepEqual([busy.status, busy.body.error], [409, 'cannot-disable']);
});

test('settings follow the schema: bad values and the pool (until R2) are refused', async () => {
  assert.equal((await putSettings(req('PUT', { placement: 'moon' }), 'proot', deps())).status, 400);
  const pool = await read(await putSettings(req('PUT', { placement: 'pool' }), 'proot', deps()));
  assert.deepEqual([pool.status, pool.body.error], [400, 'invalid-settings']);
  assert.match(pool.body.message, /not available in this release/);
  const ok = await read(await putSettings(req('PUT', { settings: { placement: 'master' } }), 'proot', deps()));
  assert.deepEqual([ok.status, ok.body.settings], [200, { placement: 'master' }]);
  assert.equal(audits.length, 0, 'no change, no audit');
});

test('check: a jump, a mount or a closed app on PRoot is capability-missing; container passes the app checks', async () => {
  const jump = await read(await postCheck(req('POST', { runtime: 'proot', needs: ['jump'] }), deps()));
  assert.deepEqual([jump.body.ok, jump.body.code, jump.body.missing], [false, 'capability-missing', ['sessionExec', 'privateHomeSession']]);
  const mount = await read(await postCheck(req('POST', { runtime: 'proot', needs: ['mount'] }), deps()));
  assert.deepEqual(mount.body.missing, ['mounts']);
  const closed = await read(await postCheck(req('POST', { runtime: 'proot', appId: 'io.ex.closed' }), deps()));
  assert.deepEqual(closed.body.missing, ['readOnlyBinds']);
  const box = await read(await postCheck(req('POST', { runtime: 'container', appId: 'io.ex.closed', needs: ['mount'] }), deps()));
  assert.deepEqual([box.body.ok, box.body.missing], [true, []]);
  assert.equal((await postCheck(req('POST', { runtime: 'proot', needs: ['nope'] }), deps())).status, 400);
});

test('D75 decisions and override removal: owner actions, capability-checked, audited', async () => {
  await migrate();
  const bad = await read(await postMigrate(req('POST', { appId: 'io.ex.closed', decision: 'keep', runtime: 'proot' }), deps()));
  assert.deepEqual([bad.status, bad.body.error], [409, 'invalid-decision']);
  const keep = await read(await postMigrate(req('POST', { appId: 'io.ex.direct', decision: 'keep', runtime: 'proot' }), deps()));
  assert.deepEqual([keep.status, keep.body.runtime], [200, 'proot']);
  const adopt = await read(await postMigrate(req('POST', { appId: 'io.ex.closed', decision: 'adopt-default' }), deps()));
  assert.deepEqual([adopt.status, adopt.body.runtime], [200, 'container']);
  assert.equal((await postMigrate(req('POST', { appId: 'io.ex.closed', decision: 'adopt-default' }), deps())).status, 404, 'decided once');
  const rm = await read(await deleteOverride(req('DELETE'), 'i-kept', deps()));
  assert.deepEqual([rm.status, rm.body.removed.runtime], [200, 'proot']);
  assert.equal((await deleteOverride(req('DELETE'), 'i-kept', deps())).status, 404);
  assert.deepEqual(audits.map((a) => a.action), ['runtime.migration-decided', 'runtime.migration-decided', 'runtime.override-removed']);
  const after = await read(await getRuntimes(req('GET'), deps()));
  assert.deepEqual(after.body.pending, []);
  assert.equal(after.body.installations.find((i: any) => i.appId === 'io.ex.kept').source, 'default', 'the removed override no longer applies');
});

test('route manifest: the runtimes routes are implemented rows, no longer reserved; reads are the owner\'s, writes owner-managed', () => {
  const routes = ROUTE_ACCESS_MANIFEST.routes as Record<string, { methods?: Record<string, { allow: readonly string[]; systemApp?: string }> }>;
  const reserved = ROUTE_ACCESS_MANIFEST.reserved ?? {};
  for (const p of Object.keys(reserved)) assert.doesNotMatch(p, /^\/api\/admin\/runtimes/, `${p} is implemented`);
  assert.deepEqual(routes['/api/admin/runtimes']!.methods!['GET']!.allow, ['owner']);
  assert.deepEqual(routes['/api/admin/runtimes/check']!.methods!['POST']!.allow, ['owner']);
  for (const [p, m] of [['/api/admin/runtimes/default', 'PUT'], ['/api/admin/runtimes/[id]/settings', 'PUT'], ['/api/admin/runtimes/[id]/enable', 'POST'],
    ['/api/admin/runtimes/[id]/disable', 'POST'], ['/api/admin/runtimes/overrides/[installationId]', 'DELETE'], ['/api/admin/runtimes/migrate', 'POST']] as const) {
    assert.equal(routes[p]!.methods![m]!.systemApp, 'com.aura.terminal', `${m} ${p} is owner-managed`);
  }
});
