// Phase 5 stream A (P5-3): the owner's per-installation runAs flip
// (`POST /api/admin/apps/run-as`) and the privilege review route row.
// A change from Settings needs the owner's `fresh` approval, the host
// operator acts directly, every flip is compare-and-set and audited.
// Owner decision 5-main (run-as reversible): a flip that changes the uid
// moves the app's storage through the reviewed migration: dry run, digest,
// stop, journaled apply, flip, restart only after success; a failure is
// restored and the app stays stopped; an interrupted one blocks until
// `--recover`. (The real ownership changes: core phase5-run-as-migration.)

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
/** What the fake migration saw, in order. */
let steps: string[];
let applyFails: boolean;
let restoreSkips: string[];
const PLAN_DIGEST = (appId: string, runAs: string, journal: string | null) => (`${appId}|${runAs}|${journal ?? ''}`.length.toString(16).padStart(2, '0')).repeat(32);

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
      setRunAs: async (id: string, runAs: 'app' | 'root', expect?: 'app' | 'root', execution?: core.ExecutionApproval, migrated?: { journal: string | null }) => {
        const cur = records.get(id)!;
        if (expect !== undefined && (cur.runAs ?? 'root') !== expect) return { ok: false, installation: cur };
        const { execution: _old, runAsMigration: pending, runAsJournal: journal, ...rest } = cur;
        const next = {
          ...rest, runAs, ...(execution ? { execution } : {}),
          ...(migrated ? (migrated.journal ? { runAsJournal: migrated.journal } : {}) : { ...(pending ? { runAsMigration: pending } : {}), ...(journal ? { runAsJournal: journal } : {}) }),
        };
        records.set(id, next);
        steps.push(`flip ${runAs}`);
        return { ok: true, installation: next };
      },
      setRunAsMigration: async (id: string, expect: 'app' | 'root', m: core.AppRunAsMigration | null) => {
        const cur = records.get(id)!;
        if ((cur.runAs ?? 'root') !== expect || (m && cur.runAsMigration)) return { ok: false, installation: cur };
        const { runAsMigration: _p, ...rest } = cur;
        const next = { ...rest, ...(m ? { runAsMigration: m } : {}) };
        records.set(id, next);
        steps.push(m ? `mark ${m.to}` : 'unmark');
        return { ok: true, installation: next };
      },
    },
    rootPolicy: async () => rootPolicy,
    migration: {
      input: async (appId, runAs) => {
        const rec = [...records.values()].find((r) => r.appId === appId)!;
        const app = { uid: 200001, gid: 200001 }, root = { uid: 0, gid: 0 };
        return {
          appId, installationId: rec.installationId, runAs, appDataRoot: `/d/apps/${appId}`, appDir: `/d/apps/${appId}`, devServed: false, appHomes: [],
          from: (rec.runAs ?? 'root') === 'app' ? app : root, to: runAs === 'app' ? app : root,
          previousJournal: rec.runAsJournal ? `/j/${rec.runAsJournal}` : null,
        };
      },
      plan: async (input) => {
        const journal = input.previousJournal && input.to.uid === 0 ? input.previousJournal.slice(3) : null;
        const plan: core.RunAsOwnershipPlan = {
          version: 1, appId: input.appId, installationId: input.installationId, runAs: input.runAs,
          from: `${input.from.uid}:${input.from.gid}`, to: `${input.to.uid}:${input.to.gid}`,
          rows: [{ path: `/d/apps/${input.appId}/${input.appId}`, kind: 'app-data', from: '0:0', to: `${input.to.uid}:${input.to.gid}`, recursive: true, exists: true, entries: 3, files: 2, bytes: 9, toChange: 3, rootOwned: 3 }],
          refused: [], findings: [], restore: journal ? { journal, entries: 3 } : null,
          digest: PLAN_DIGEST(input.appId, input.runAs, journal),
        };
        return { plan, apply: { rows: [], within: [`/d/apps/${input.appId}/${input.appId}`], ...(journal ? { restore: { journal: `/j/${journal}`, within: [], owner: { uid: input.from.uid } } } : {}) } };
      },
      newJournal: (digest) => `/j/2026-${digest.slice(0, 12)}.ndjson`,
      journalPath: (name) => `/j/${name}`,
      apply: async (_digest, apply, journal) => {
        steps.push(`apply ${journal}${apply.restore ? ` restoring ${apply.restore.journal}` : ''}`);
        if (applyFails) throw new Error('worker died');
        return { rows: [{ path: '/d/x', kind: 'app-data', changed: 3, skipped: 0, skippedSample: [] }], ...(apply.restore ? { restored: { restored: 3, skipped: 0, skippedSample: [] } } : {}) };
      },
      restore: (journal) => { steps.push(`restore ${journal}`); return { restored: 2, skipped: [...restoreSkips] }; },
      stop: async (appId) => { steps.push(`stop ${appId}`); return { stopped: [appId, 'org.b.viewer'], restart: [{ appId }, { appId: 'org.b.viewer' }] }; },
      restart: async (list) => { steps.push(`restart ${list.map((l) => l.appId).join(',')}`); return []; },
      hold: () => undefined,
    },
  };
}

/** The dry run, then its apply (as the caller set). */
async function flip(appId: string, runAs: 'app' | 'root') {
  const dry = await read(await postRunAs(req({ appId, runAs }), deps()));
  assert.equal(dry.body.dryRun, true, JSON.stringify(dry.body));
  return read(await postRunAs(req({ appId, runAs, digest: dry.body.plan.digest }), deps()));
}

let rootPolicy: core.AppRootExecutionPolicy = 'approve';

beforeEach(() => {
  approvals = new MemoryApprovals();
  caller = OPERATOR;
  audits = [];
  steps = [];
  applyFails = false;
  restoreSkips = [];
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

test('from Settings: a dry run first (changes nothing), then the flip of exactly that digest needs the owner\'s password (fresh)', async () => {
  caller = SETTINGS;
  const dry = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }), deps()));
  assert.deepEqual([dry.status, dry.body.dryRun, dry.body.changed, dry.body.plan.to], [200, true, false, '200001:200001']);
  assert.deepEqual(steps, [], 'a dry run stops, marks and changes nothing');
  const digest = dry.body.plan.digest;
  const first = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app', digest }), deps()));
  assert.equal(first.status, 202);
  const rec = approvals.records.get(first.body.approvalId)!;
  assert.equal(rec.level, 'fresh');
  assert.ok(rec.display.details.some((d) => d.includes('0:0 to 200001:200001')));
  assert.equal(records.get('i-notes')!.runAs, undefined, 'nothing changed yet');
  await approvals.approve(rec.id, FRESH_OWNER);
  const done = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app', digest }, rec.id), deps()));
  assert.deepEqual([done.status, done.body.changed, done.body.runAs, done.body.running, done.body.restarted], [200, true, 'app', 1, 2]);
  const journal = `2026-${digest.slice(0, 12)}.ndjson`;
  // Marked before the first change; stopped (the app and its data consumers); applied; flipped; started again after.
  assert.deepEqual(steps, ['mark app', 'stop org.a.notes', `apply /j/${journal}`, 'flip app', 'restart org.a.notes,org.b.viewer']);
  const after = records.get('i-notes')!;
  assert.deepEqual([after.runAs, after.runAsMigration, after.runAsJournal], ['app', undefined, journal]);
  assert.deepEqual(audits.map((a) => [a.action, a.opts.target, a.opts.detail.from, a.opts.detail.to, a.opts.detail.digest, a.opts.detail.journal]),
    [['app.run-as-changed', 'installation:i-notes', 'root', 'app', digest, journal]]);
});

test('the operator flips both ways; the flip back restores the earlier migration\'s journal; bad input and unknown apps are refused', async () => {
  const there = await flip('org.a.notes', 'app');
  assert.equal(there.status, 200);
  const same = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }), deps()));
  assert.deepEqual([same.status, same.body.changed], [200, false]);
  steps = [];
  const dryBack = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'root' }), deps()));
  assert.deepEqual(dryBack.body.plan.restore, { journal: there.body.journal, entries: 3 }, 'the reverse is the exact journal revert where possible');
  const back = await flip('org.a.notes', 'root');
  assert.deepEqual([back.status, back.body.runAs, back.body.restored.restored], [200, 'root', 3]);
  assert.deepEqual(steps, ['mark root', 'stop org.a.notes', `apply /j/${back.body.journal} restoring /j/${there.body.journal}`, 'flip root', 'restart org.a.notes,org.b.viewer']);
  assert.deepEqual([records.get('i-notes')!.runAs, records.get('i-notes')!.runAsJournal], ['root', back.body.journal]);
  assert.equal((await postRunAs(req({ appId: 'org.a.notes', runAs: 'admin' }), deps())).status, 400);
  assert.equal((await postRunAs(req({ appId: 'org.a.notes', runAs: 'app', digest: 'nope' }), deps())).status, 400);
  assert.equal((await postRunAs(req({ appId: 'org.a.gone', runAs: 'app' }), deps())).status, 404);
  assert.equal((await postRunAs(req({ appId: 'org.a.new', runAs: 'app' }), deps())).status, 409, 'no installation record yet');
  assert.deepEqual(audits.map((a) => a.action), ['app.run-as-changed', 'app.run-as-changed']);
});

test('a digest other than the current dry run\'s applies nothing (409 with the new digest)', async () => {
  const r = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app', digest: 'ab'.repeat(32) }), deps()));
  assert.deepEqual([r.status, r.body.error], [409, 'digest-mismatch']);
  assert.match(r.body.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual([steps, records.get('i-notes')!.runAs, audits], [[], undefined, []]);
});

test('a failed apply is restored from its journal: the record stays, the marker goes, nothing is started again', async () => {
  applyFails = true;
  const r = await flip('org.a.notes', 'app');
  assert.deepEqual([r.status, r.body.error, r.body.runAs], [500, 'migration-failed', 'root']);
  assert.match(r.body.message, /restored from the journal.*stays stopped/);
  assert.deepEqual(steps.map((x) => x.split(' ')[0]), ['mark', 'stop', 'apply', 'restore', 'unmark'], 'no flip, no restart');
  const rec = records.get('i-notes')!;
  assert.deepEqual([rec.runAs, rec.runAsMigration], [undefined, undefined]);
  assert.deepEqual(audits.map((a) => [a.action, a.opts.outcome]), [['app.run-as-changed', 'failed']]);
});

test('an interrupted (or not fully restored) migration blocks: no new flip until --recover restores its journal', async () => {
  applyFails = true;
  restoreSkips = ['/d/apps/org.a.notes/org.a.notes/f: EPERM'];
  const r = await flip('org.a.notes', 'app');
  assert.equal(r.status, 500);
  assert.match(r.body.message, /--recover/);
  const pending = records.get('i-notes')!.runAsMigration!;
  assert.equal(pending.to, 'app');
  assert.match(core.runAsMigrationBlock('org.a.notes', records.get('i-notes')!)!, /did not finish.*not started.*--recover/, 'the start gate refuses');
  const again = await read(await postRunAs(req({ appId: 'org.a.notes', runAs: 'app' }), deps()));
  assert.deepEqual([again.status, again.body.error], [409, 'migration-pending']);
  // The recovery: from Settings it needs the password; then the journal is restored and the marker goes.
  caller = SETTINGS;
  restoreSkips = ['/d/apps/org.a.notes/org.a.notes/tmp: gone'];
  steps = [];
  const first = await read(await postRunAs(req({ appId: 'org.a.notes', recover: true }), deps()));
  assert.equal(first.status, 202);
  const rec = approvals.records.get(first.body.approvalId)!;
  assert.equal(rec.level, 'fresh');
  await approvals.approve(rec.id, FRESH_OWNER);
  const done = await read(await postRunAs(req({ appId: 'org.a.notes', recover: true }, rec.id), deps()));
  assert.deepEqual([done.status, done.body.recovered, done.body.runAs, done.body.journal], [200, true, 'root', pending.journal]);
  assert.deepEqual(steps, ['stop org.a.notes', `restore /j/${pending.journal}`, 'unmark'], 'restored, unmarked, not started');
  assert.equal(records.get('i-notes')!.runAsMigration, undefined);
  assert.equal(core.runAsMigrationBlock('org.a.notes', records.get('i-notes')!), null);
  assert.deepEqual(audits.map((a) => [a.action, a.opts.outcome]), [['app.run-as-changed', 'failed'], ['app.run-as-recovered', undefined]]);
  const nothing = await read(await postRunAs(req({ appId: 'org.a.notes', recover: true }), deps()));
  assert.deepEqual([nothing.status, nothing.body.changed], [200, false]);
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
  const dry = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }), deps()));
  const plan = dry.body.plan.digest;
  const first = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root', digest: plan }), deps()));
  assert.equal(first.status, 202);
  const rec = approvals.records.get(first.body.approvalId)!;
  assert.equal(rec.level, 'fresh');
  assert.equal(rec.display.highRisk?.[0]?.item, 'Root execution (runAs: root)');
  assert.equal(rec.display.reason, 'binds port 80 inside', 'the manifest reason only as the labelled reason');
  assert.ok(rec.display.details.some((d) => d.includes(digest)));
  assert.ok(rec.display.details.some((d) => d.includes('200001:200001 to 0:0')), 'its data moves back with the approval');
  await approvals.approve(rec.id, FRESH_OWNER);
  const done = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root', digest: plan }, rec.id), deps()));
  assert.deepEqual([done.status, done.body.changed], [200, true]);
  const inst = records.get('i-rooted')!;
  assert.deepEqual([inst.runAs, inst.execution?.digest, inst.execution?.via], ['root', digest, 'admin.run-as']);
  assert.deepEqual(audits.map((a) => a.action), ['app.run-as-changed', 'app.execution-approved']);
  // The same approval again: nothing to do. Back to app: the approval is gone.
  caller = OPERATOR;
  assert.equal((await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }), deps()))).body.changed, false);
  await flip('org.a.rooted', 'app');
  assert.equal(records.get('i-rooted')!.execution, undefined);
});

test('run-as root on a requesting app is refused while app-root-execution is refuse; a legacy rollback records no approval', async () => {
  rootPolicy = 'refuse';
  const r = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }), deps()));
  assert.deepEqual([r.status, r.body.error], [403, 'root-execution-refused']);
  assert.equal(records.get('i-rooted')!.runAs, 'app');
  // An app without a request: the 5-apps rollback, no approval record (legacy root).
  await flip('org.a.notes', 'app');
  await flip('org.a.notes', 'root');
  assert.deepEqual([records.get('i-notes')!.runAs, records.get('i-notes')!.execution], ['root', undefined]);
});

test('a legacy root app approving its own root request changes no uid: no migration, the record only', async () => {
  records.set('i-rooted', { ...records.get('i-rooted')!, runAs: 'root' });
  const r = await read(await postRunAs(req({ appId: 'org.a.rooted', runAs: 'root' }), deps()));
  assert.deepEqual([r.status, r.body.changed, r.body.dryRun], [200, true, undefined]);
  assert.deepEqual(steps, ['flip root']);
  assert.match(records.get('i-rooted')!.execution!.digest, /^sha256:/);
});
