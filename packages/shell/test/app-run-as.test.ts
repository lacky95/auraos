// Phase 5 stream A (P5-3): the owner's per-installation runAs flip
// (`POST /api/admin/apps/run-as`) and the privilege review route row.
// A change from Settings needs the owner's `fresh` approval, the host
// operator acts directly, every flip is compare-and-set and audited.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, AuditInput } from '@aura/core';
import { ownerAction, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import { postRunAs, type RunAsDeps } from '../src/lib/appRunAs.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { effectiveRule } from '../src/lib/access/resolve.ts';

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

const SETTINGS: CallerPrincipal = {
  kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified',
  through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' },
} as CallerPrincipal;
const OPERATOR: CallerPrincipal = { kind: 'operator', verification: 'verified' };
const FRESH_OWNER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: true };

let approvals: MemoryApprovals;
let caller: CallerPrincipal;
let audits: Array<{ action: string; opts: any }>;
let records: Map<string, core.AppInstallation>;

function deps(): RunAsDeps {
  const ownerDeps: OwnerActionDeps = {
    approvals: {
      store: approvals as never,
      appName: (id) => (id === 'com.aura.settings' ? 'Settings' : null),
      audit: async (_e: AuditInput) => { /* approvals' own audit */ },
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => ({ identity: {} }),
  };
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req, ownerDeps),
    audit: async (_actor, action, opts) => { audits.push({ action, opts }); },
    mgr: {
      registry: {
        getById: (id: string) => (id === 'org.a.notes' || id === 'org.a.new' ? { id, scopeId: 'global' }
          : id === 'org.a.rooted' ? { id, scopeId: 'global', execution: { runAs: 'root', reason: 'binds port 80 inside' } } : undefined),
      },
      getAllInstances: () => [{ instanceId: 'org.a.notes', appId: 'org.a.notes' }],
    } as never,
    hosts: {
      findInstallation: async (appId: string) => [...records.values()].find((r) => r.appId === appId) ?? null,
      setRunAs: async (id: string, runAs: 'app' | 'root', expect?: 'app' | 'root', execution?: core.ExecutionApproval) => {
        const cur = records.get(id)!;
        if (expect !== undefined && (cur.runAs ?? 'root') !== expect) return { ok: false, installation: cur };
        const { execution: _old, ...rest } = cur;
        const next = { ...rest, runAs, ...(execution ? { execution } : {}) };
        records.set(id, next);
        return { ok: true, installation: next };
      },
    },
    rootPolicy: async () => rootPolicy,
  };
}

let rootPolicy: core.AppRootExecutionPolicy = 'approve';

beforeEach(() => {
  approvals = new MemoryApprovals();
  caller = OPERATOR;
  audits = [];
  rootPolicy = 'approve';
  records = new Map([['i-notes', {
    installationId: 'i-notes', appId: 'org.a.notes', originId: null, scope: 'global', userId: 'default',
    source: { kind: 'oci', ref: 'x' }, state: 'active', createdAt: 0, updatedAt: 0,
  } as core.AppInstallation], ['i-rooted', {
    installationId: 'i-rooted', appId: 'org.a.rooted', originId: null, scope: 'global', userId: 'default', runAs: 'app',
    source: { kind: 'oci', ref: 'y' }, state: 'active', createdAt: 0, updatedAt: 0,
  } as core.AppInstallation]]);
});

const req = (body: unknown, approval?: string) => ({
  request: new Request('http://shell.test/api/admin/apps/run-as', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(approval ? { 'x-aura-approval': approval } : {}) }, body: JSON.stringify(body),
  }),
  cookies: {} as never,
});
const read = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });

test('from Settings the flip needs the owner\'s password (fresh); then it is recorded and audited', async () => {
  caller = SETTINGS;
  const first = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }), deps()));
  assert.equal(first.status, 202);
  const rec = approvals.records.get(first.body.approvalId)!;
  assert.equal(rec.level, 'fresh');
  assert.equal(records.get('i-notes')!.runAs, undefined, 'nothing changed yet');
  await approvals.approve(rec.id, FRESH_OWNER);
  const done = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }, rec.id), deps()));
  assert.deepEqual([done.status, done.body.changed, done.body.runAs, done.body.running], [200, true, 'app', 1]);
  assert.equal(records.get('i-notes')!.runAs, 'app');
  assert.deepEqual(audits.map((a) => [a.action, a.opts.target, a.opts.detail]), [['app.run-as-changed', 'installation:i-notes', { appId: 'org.a.notes', from: 'root', to: 'app' }]]);
});

test('the operator flips directly; the rollback is a flip back; bad input and unknown apps are refused', async () => {
  assert.equal((await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }), deps())).status, 200);
  const same = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }), deps()));
  assert.deepEqual([same.status, same.body.changed], [200, false]);
  const back = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'root' }), deps()));
  assert.deepEqual([back.status, back.body.runAs], [200, 'root']);
  assert.equal(records.get('i-notes')!.runAs, 'root');
  assert.equal((await postRunAs(req({ appId: 'org.a.notes', runAs: 'admin' }), deps())).status, 400);
  assert.equal((await postRunAs(req({ appId: 'org.a.gone', runAs: 'app' }), deps())).status, 404);
  assert.equal((await postRunAs(req({ appId: 'org.a.new', runAs: 'app' }), deps())).status, 409, 'no installation record yet');
  assert.deepEqual(audits.map((a) => a.action), ['app.run-as-changed', 'app.run-as-changed']);
});

test('route manifest: the flip is owner-managed, the privilege review an owner view; neither reserved', () => {
  const reserved = ROUTE_ACCESS_MANIFEST.reserved ?? {};
  for (const route of ['/api/admin/apps/run-as', '/api/admin/identity/privilege-review']) assert.ok(!(route in reserved), route);
  const flip = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/admin/apps/run-as', handlers: ['POST'] }, 'POST');
  assert.equal(flip?.systemApp, 'com.aura.terminal');
  assert.ok(!flip?.allow.includes('public' as never));
  const review = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/admin/identity/privilege-review', handlers: ['GET'] }, 'GET');
  assert.deepEqual(review?.allow, ['own-instance', 'owner']);
});

// ── 5-main item 3: run-as root approves an app's own root request ───────────

test('run-as root on a requesting app approves exactly its request at fresh: digest recorded, high risk shown, audited', async () => {
  caller = SETTINGS;
  const digest = core.executionDigest({ v: 1, runAs: 'root' });
  const first = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }), deps()));
  assert.equal(first.status, 202);
  const rec = approvals.records.get(first.body.approvalId)!;
  assert.equal(rec.level, 'fresh');
  assert.equal(rec.display.highRisk?.[0]?.item, 'Root execution (runAs: root)');
  assert.equal(rec.display.reason, 'binds port 80 inside', 'the manifest reason only as the labelled reason');
  assert.ok(rec.display.details.some((d) => d.includes(digest)));
  await approvals.approve(rec.id, FRESH_OWNER);
  const done = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }, rec.id), deps()));
  assert.deepEqual([done.status, done.body.changed], [200, true]);
  const inst = records.get('i-rooted')!;
  assert.deepEqual([inst.runAs, inst.execution?.digest, inst.execution?.via], ['root', digest, 'admin.run-as']);
  assert.deepEqual(audits.map((a) => a.action), ['app.run-as-changed', 'app.execution-approved']);
  // The same approval again: nothing to do. Back to app: the approval is gone.
  caller = OPERATOR;
  assert.equal((await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }), deps()))).body.changed, false);
  await postRunAs(req({ appId: 'org.a.rooted', runAs: 'app' }), deps());
  assert.equal(records.get('i-rooted')!.execution, undefined);
});

test('run-as root on a requesting app is refused while app-root-execution is refuse; a legacy rollback records no approval', async () => {
  rootPolicy = 'refuse';
  const r = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }), deps()));
  assert.deepEqual([r.status, r.body.error], [403, 'root-execution-refused']);
  assert.equal(records.get('i-rooted')!.runAs, 'app');
  // An app without a request: the 5-apps rollback, no approval record (legacy root).
  await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }), deps());
  await postRunAs(req({ appId: 'org.a.notes', runAs: 'root' }), deps());
  assert.deepEqual([records.get('i-notes')!.runAs, records.get('i-notes')!.execution], ['root', undefined]);
});
