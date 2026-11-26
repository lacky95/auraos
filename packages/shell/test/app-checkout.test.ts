// `aura dev checkout` (POST /api/admin/app-checkout, lib/appCheckout.ts), owner decision 5-main P2: the rules of
// `aura dev open` (Track P) checked on every request, then the owner's password (fresh) bound to the operation and
// the app's installation, used once, audited. An approval never overrides a refusal (system app, closed install).
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult } from '@aura/core';
import { ownerAction, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import { postAppCheckout, type CheckoutDeps } from '../src/lib/appCheckout.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { effectiveRule } from '../src/lib/access/resolve.ts';
import { TERMINAL_APP_ID } from '../server/terminal-embed.mjs';

class MemoryStore {
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

const TERMINAL: CallerPrincipal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', userId: 'default', verification: 'verified' };
const OWNER: CallerPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified' };
const OPERATOR: CallerPrincipal = { kind: 'operator', verification: 'verified' };
const CLICK: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: false };
const PASSWORD: ApprovalDecider = { ...CLICK, fresh: true };

const SCOPES = [
  { id: 'system', immutable: true, appsDir: '/workspace/apps', dataDir: '/data' },
  { id: 'global', appsDir: '/data/scopes/global/apps', dataDir: '/data/scopes/global' },
  { id: 'user', appsDir: '/data/scopes/users/default/apps', dataDir: '/data/scopes/users/default' },
] as unknown as core.ScopeDefinition[];

let store: MemoryStore;
let caller: CallerPrincipal;
let active: Record<string, string>;
let modes: Record<string, core.SourceMode>;
let checkouts: Set<string>;
let installs: Record<string, string>;
let ran: Array<{ appId: string; opts: unknown }>;
let audits: Array<{ action: string; opts: any }>;

beforeEach(() => {
  store = new MemoryStore();
  caller = TERMINAL;
  active = { 'io.ex.open': 'global', 'io.ex.closed': 'global', 'io.ex.other': 'user', 'com.aura.settings': 'system', 'io.ex.fresh': 'user' };
  modes = { 'io.ex.open': 'open', 'io.ex.closed': 'closed', 'io.ex.other': 'open', 'io.ex.fresh': 'open' };
  checkouts = new Set();
  installs = { 'io.ex.open/global': 'inst-open', 'io.ex.closed/global': 'inst-closed', 'io.ex.other/user': 'inst-other', 'com.aura.settings/system': 'inst-settings' };
  ran = [];
  audits = [];
});

function deps(): CheckoutDeps {
  const owner: OwnerActionDeps = {
    approvals: {
      store: store as never,
      appName: (id) => (id === 'com.aura.terminal' ? 'Terminal' : null),
      audit: async () => undefined,
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => ({ identity: {} }),
  };
  const idOf = (appDir: string) => appDir.split('/').pop()!;
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req, owner),
    audit: async (_a, action, opts) => { audits.push({ action, opts }); },
    scopes: () => SCOPES,
    activeScope: (appId) => active[appId],
    manifest: (appDir) => ({ id: idOf(appDir), version: '1.0.0' }) as core.AppManifest,
    isCheckout: (appDir) => checkouts.has(idOf(appDir)),
    sourceMode: (_def, m) => modes[m.id] ?? 'closed',
    installationId: async (appId, scope) => installs[`${appId}/${scope}`] ?? null,
    checkout: async (t, _m, opts) => { ran.push({ appId: t.appId, opts }); return { created: true }; },
  };
}

const call = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await postAppCheckout({
    request: new Request('http://shell.test/api/admin/app-checkout', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    cookies: {} as never,
  }, deps());
  return { status: res.status, body: await res.json() as Record<string, any> };
};

test('the System Terminal is asked with the password (fresh), bound to the operation and the installation; nothing runs yet', async () => {
  const r = await call({ appId: 'io.ex.open', ref: 'v1.0.0' });
  assert.equal(r.status, 202);
  assert.equal(r.body.error, 'needs-approval');
  assert.equal(r.body.action, 'app.source.open');
  assert.equal(r.body.level, 'fresh');
  assert.match(r.body.display.details.join('\n'), /installation inst-open/);
  const rec = store.records.get(r.body.approvalId)!;
  assert.equal(rec.payloadHash, core.payloadHash({ op: 'app.checkout', appId: 'io.ex.open', scope: 'global', installationId: 'inst-open', ref: 'v1.0.0' }));
  assert.deepEqual(ran, []);
});

test('approved with the password, the same request runs once, audited; the approval is then used up', async () => {
  const first = await call({ appId: 'io.ex.open' });
  const id = first.body.approvalId as string;
  assert.equal((await store.approve(id, CLICK)).ok, false, 'one click is not enough (fresh)');
  assert.equal((await store.approve(id, PASSWORD)).ok, true);
  const done = await call({ appId: 'io.ex.open' }, { 'x-aura-approval': id });
  assert.deepEqual([done.status, done.body.installationId], [200, 'inst-open']);
  assert.deepEqual(ran.map((x) => x.appId), ['io.ex.open']);
  assert.deepEqual(audits.map((a) => [a.action, a.opts.target, a.opts.outcome]), [['app.checkout', 'installation:inst-open', 'ok']]);
  const again = await call({ appId: 'io.ex.open' }, { 'x-aura-approval': id });
  assert.equal(again.status, 202, 'used up: asked anew');
  assert.equal(ran.length, 1);
});

test('the approval is bound to the app, its installation and the request', async () => {
  const id = (await call({ appId: 'io.ex.open' })).body.approvalId as string;
  await store.approve(id, PASSWORD);
  assert.equal((await call({ appId: 'io.ex.other' }, { 'x-aura-approval': id })).body.refused, 'mismatch', 'another app');
  assert.equal((await call({ appId: 'io.ex.open', repository: 'https://example.invalid/x.git' }, { 'x-aura-approval': id })).body.refused, 'mismatch', 'another repository');
  installs['io.ex.open/global'] = 'inst-reinstalled';
  assert.equal((await call({ appId: 'io.ex.open' }, { 'x-aura-approval': id })).body.refused, 'mismatch', 'another installation of the same id');
  assert.deepEqual(ran, []);
});

test('a system app is refused before anyone is asked, and an approval does not override it', async () => {
  const r = await call({ appId: 'com.aura.settings' });
  assert.deepEqual([r.status, r.body.error], [409, 'system-app']);
  assert.equal((await call({ appId: 'io.ex.open', scope: 'system' })).body.error, 'system-app', 'naming the system scope');
  assert.equal(store.records.size, 0, 'nobody was asked');
  // A password approval of exactly this request, from the Terminal (as if it had been asked), changes nothing:
  // the refusal comes before the approval is looked at. The owner and the operator are refused too.
  const asked = await call({ appId: 'io.ex.open' });
  const requester = store.records.get(asked.body.approvalId)!.requester;
  const forged = await store.create({
    requester, action: 'app.source.open', level: 'fresh', display: { title: 'x', details: [], requestedBy: 'Terminal' },
    payloadHash: core.payloadHash({ op: 'app.checkout', appId: 'com.aura.settings', scope: 'system', installationId: 'inst-settings' }),
  });
  assert.ok(forged.ok);
  assert.equal((await store.approve(forged.record.id, PASSWORD)).ok, true);
  for (const who of [TERMINAL, OWNER, OPERATOR]) {
    caller = who;
    const r2 = await call({ appId: 'com.aura.settings' }, { 'x-aura-approval': forged.record.id });
    assert.deepEqual([r2.status, r2.body.error], [409, 'system-app'], who.kind);
  }
  assert.equal(store.records.get(forged.record.id)!.state, 'approved', 'never consumed');
  assert.deepEqual(ran, []);
});

test('a closed install follows the dev open rule: refused until opened, for everyone; an existing checkout is reported on', async () => {
  for (const who of [TERMINAL, OWNER, OPERATOR]) {
    caller = who;
    const r = await call({ appId: 'io.ex.closed' });
    assert.deepEqual([r.status, r.body.error], [409, 'source-closed'], who.kind);
    assert.match(r.body.message, /aura dev open io\.ex\.closed/);
  }
  assert.equal(store.records.size, 0);
  // The owner opened it: now it is asked like any open install.
  modes['io.ex.closed'] = 'open';
  caller = TERMINAL;
  assert.equal((await call({ appId: 'io.ex.closed' })).status, 202);
  // A checkout made before Track P stays the owner's working tree (still asked).
  modes['io.ex.closed'] = 'closed';
  checkouts.add('io.ex.closed');
  assert.equal((await call({ appId: 'io.ex.closed' })).status, 202);
  assert.deepEqual(ran, []);
});

test('the owner in the desktop and the host operator act directly, audited; no installation, a bad ref or app id are refused first', async () => {
  caller = OWNER;
  assert.equal((await call({ appId: 'io.ex.open' }, { authorization: 'Bearer aura-sess1.x' })).status, 200);
  caller = OPERATOR;
  assert.equal((await call({ appId: 'io.ex.other' })).status, 200);
  assert.deepEqual(audits.map((a) => a.opts.target), ['installation:inst-open', 'installation:inst-other']);
  assert.equal(store.records.size, 0);
  caller = TERMINAL;
  assert.deepEqual([(await call({ appId: 'io.ex.fresh' })).body.error], ['not-ready']);
  assert.equal((await call({ appId: 'io.ex.open', ref: '--upload-pack=x' })).status, 400);
  assert.equal((await call({ appId: '../x' })).status, 400);
  assert.equal(store.records.size, 0);
});

test('route manifest: POST is the owner\'s management rule (only the System Terminal asks); GET a direct owner read', () => {
  const post = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/admin/app-checkout', handlers: ['GET', 'POST'] }, 'POST');
  assert.deepEqual(post?.allow, ['own-instance', 'owner']);
  assert.equal(post?.systemApp, TERMINAL_APP_ID);
  const get = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/admin/app-checkout', handlers: ['GET', 'POST'] }, 'GET');
  assert.deepEqual(get?.allow, ['owner']);
});
