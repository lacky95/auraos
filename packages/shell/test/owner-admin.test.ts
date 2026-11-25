// D50: the owner's management routes (lib/approvals/admin.ts `ownerAction`).
// The owner in the desktop and the host operator act directly; Settings reads
// directly; a change through Settings and every app request (the CLI in the
// System Terminal) is 202 needs-approval, then the same request with the
// owner's approval, used up once.
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, AuditInput } from '@aura/core';
import {
  grantLevel, manifestEditLevel, ownerAction, type AdminRequest, type OwnerActionDeps,
} from '../src/lib/approvals/admin.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';

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
const SETTINGS: CallerPrincipal = { ...OWNER, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as CallerPrincipal;
const OPERATOR: CallerPrincipal = { kind: 'operator', verification: 'verified' };
const ANON: CallerPrincipal = { kind: 'anonymous', verification: 'unverified' };
const DECIDER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: false };

let store: MemoryStore;
let audits: AuditInput[];
let caller: CallerPrincipal;
let desktopOrigin: boolean;

function deps(): OwnerActionDeps {
  return {
    approvals: {
      store: store as never,
      appName: (id) => (id === 'com.aura.terminal' ? 'Terminal' : id === 'com.aura.settings' ? 'Settings' : null),
      audit: async (e) => { audits.push(e); },
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => (desktopOrigin ? { identity: {} } : { error: 'forbidden-origin', status: 403 }),
  };
}

beforeEach(() => {
  store = new MemoryStore();
  audits = [];
  caller = TERMINAL;
  desktopOrigin = true;
});

const GRANT: AdminRequest = {
  action: 'admin.grant', level: 'fresh',
  payload: { subjectKind: 'app', subjectId: 'io.lakner.terminalx', permission: 'terminal.screen.read' },
  title: 'Grant io.lakner.terminalx terminal.screen.read',
};
const REVOKE: AdminRequest = {
  action: 'admin.revoke', level: 'session',
  payload: { subjectKind: 'app', subjectId: 'io.lakner.terminalx', permission: 'terminal.screen.read' },
  title: 'Revoke terminal.screen.read from io.lakner.terminalx',
};
const READ: AdminRequest = { action: 'admin.read', level: 'session', payload: { view: 'audit', limit: 30 }, title: 'Show the audit trail' };

const ctx = (headers: Record<string, string> = {}, method = 'POST') => ({
  request: new Request('http://shell.test/api/admin/grants', { method, headers }),
  cookies: {} as never,
});
const asked = async (r: unknown) => {
  assert.ok(r instanceof Response, `expected a response, got ${JSON.stringify(r)}`);
  return { status: r.status, body: await r.json() as Record<string, any> };
};

test('the owner in the desktop and the host operator act directly, named in the record', async () => {
  caller = OWNER;
  const owner = await ownerAction(ctx({ authorization: 'Bearer aura-sess1.x' }), GRANT, deps());
  assert.deepEqual(owner, { by: { kind: 'user', userId: 'default', session: 'sess-des' }, detail: {} });
  caller = OPERATOR;
  assert.deepEqual(await ownerAction(ctx(), GRANT, deps()), { by: { kind: 'operator' }, detail: {} });
  assert.equal(store.records.size, 0, 'nobody was asked');
});

test('a change on the login cookie alone needs the desktop\'s own Origin; a read does not', async () => {
  caller = OWNER;
  desktopOrigin = false;
  assert.deepEqual(await asked(await ownerAction(ctx(), GRANT, deps())), { status: 403, body: { error: 'forbidden-origin' } });
  assert.ok(!((await ownerAction(ctx({}, 'GET'), READ, deps())) instanceof Response));
});

test('Settings (D45) reads directly; a change through it asks the owner', async () => {
  caller = SETTINGS;
  const read = await ownerAction(ctx({}, 'GET'), READ, deps());
  assert.deepEqual(read, { by: { kind: 'user', userId: 'default', session: 'sess-des' }, detail: { through: 'com.aura.settings' } });
  const r = await asked(await ownerAction(ctx(), REVOKE, deps()));
  assert.equal(r.status, 202);
  assert.equal(r.body.display.requestedBy, 'Settings, for you');
});

test('the System Terminal: 202 with a server-built display, then approved, then it acts once as the approving owner', async () => {
  const first = await asked(await ownerAction(ctx(), GRANT, deps()));
  assert.equal(first.status, 202);
  assert.equal(first.body.error, 'needs-approval');
  assert.equal(first.body.action, 'admin.grant');
  assert.equal(first.body.level, 'fresh');
  assert.equal(first.body.display.title, 'Grant io.lakner.terminalx terminal.screen.read');
  assert.equal(first.body.display.requestedBy, 'Terminal (com.aura.terminal-1)');
  const id = first.body.approvalId as string;

  // A fresh request decided with one click only is refused (D9).
  assert.equal((await store.approve(id, DECIDER)).ok, false);
  assert.equal((await store.approve(id, { ...DECIDER, fresh: true })).ok, true);

  const done = await ownerAction(ctx({ 'x-aura-approval': id }), GRANT, deps());
  assert.ok(!(done instanceof Response));
  assert.deepEqual(done.by, { kind: 'user', userId: 'default', session: 'sess-des' });
  assert.equal(done.detail['approval'], id);
  assert.match(String(done.detail['requestedBy']), /com\.aura\.terminal-1/);

  // Used up: the same id again asks anew.
  const again = await asked(await ownerAction(ctx({ 'x-aura-approval': id }), GRANT, deps()));
  assert.equal(again.status, 202);
  assert.equal(again.body.refused, 'wrong-state');
});

test('an approval of another request is refused: another payload, another action, another requester', async () => {
  const first = await asked(await ownerAction(ctx(), REVOKE, deps()));
  const id = first.body.approvalId as string;
  await store.approve(id, DECIDER);
  const other = { ...REVOKE, payload: { ...(REVOKE.payload as object), subjectId: 'com.example.counter' } };
  assert.equal((await asked(await ownerAction(ctx({ 'x-aura-approval': id }), other, deps()))).body.refused, 'mismatch');
  assert.equal((await asked(await ownerAction(ctx({ 'x-aura-approval': id }), { ...GRANT, level: 'session' }, deps()))).body.refused, 'mismatch');
  caller = { ...TERMINAL, instanceId: 'com.aura.terminal-2' } as CallerPrincipal;
  assert.equal((await asked(await ownerAction(ctx({ 'x-aura-approval': id }), REVOKE, deps()))).body.refused, 'mismatch');
  caller = TERMINAL;
  assert.ok(!((await ownerAction(ctx({ 'x-aura-approval': id }), REVOKE, deps())) instanceof Response), 'still good for its own request');
});

test('an anonymous caller is refused, never asked', async () => {
  caller = ANON;
  assert.equal((await asked(await ownerAction(ctx(), READ, deps()))).status, 401);
  assert.equal(store.records.size, 0);
});

test('levels (D9): password for privileged grants, Docker or every tool, privileged sidecars; one click otherwise', () => {
  assert.equal(grantLevel('terminal.screen.read'), 'fresh');
  assert.equal(grantLevel('notifications.popup'), 'fresh');
  assert.equal(grantLevel('system.kv.os.theme.write'), 'fresh');
  assert.equal(manifestEditLevel({ action: 'add-tool', tool: 'git' }), 'session');
  assert.equal(manifestEditLevel({ action: 'add-tool', tool: 'docker' }), 'fresh');
  assert.equal(manifestEditLevel({ action: 'add-service-tool', tool: '*' }), 'fresh');
  assert.equal(manifestEditLevel({ action: 'set-tools', tools: ['git', '*'] }), 'fresh');
  assert.equal(manifestEditLevel({ action: 'set-tools', tools: ['git'] }), 'session');
  assert.equal(manifestEditLevel({ action: 'add-permission', permission: 'sidecars.privileged' }), 'fresh');
  assert.equal(manifestEditLevel({ action: 'add-permission', permission: 'terminal.embed' }), 'fresh');
  assert.equal(manifestEditLevel({ action: 'add-permission', permission: 'apps.mount' }), 'session');
  assert.equal(manifestEditLevel({ action: 'remove-tool', tool: 'docker' }), 'session');
  assert.equal(manifestEditLevel({ action: 'remove-permission', permission: 'sidecars.privileged' }), 'session');
});

test('every owner-management route goes through ownerAction, and none reads a shared admin session', () => {
  const dir = new URL('../src/pages/api/admin/', import.meta.url);
  for (const f of ['grants.ts', 'api-keys.ts', 'audit.ts', 'access-report.ts', 'manifest-edit.ts', 'notifications/release.ts',
    'onboarding.ts', 'app-origin.ts', 'clone-app.ts', 'scaffold.ts', 'dev/system-decision.ts']) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.match(src, /ownerAction\(/, f);
    assert.doesNotMatch(src, /adminOf|auditAdmin|aura-admin1/, f);
  }
  assert.equal(existsSync(new URL('session.ts', dir)), false, 'the unlock route is gone');
});

test('Settings has no admin token path left: no unlock message, no bearer, no session route', () => {
  const src = readFileSync(new URL('../../../apps/com.aura.settings/src/pages/access.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /aura\.admin\.unlock/);
  assert.doesNotMatch(src, /Bearer \$\{|Authorization: `|session\.token|aura-admin1/, 'the page holds no token of its own');
  assert.doesNotMatch(src, /\/api\/admin\/session/);
  assert.match(src, /aura\.approval\.request/, 'changes go through the shell\'s approval dialog');
  assert.match(src, /X-Aura-Approval/);
  for (const copy of ['../../core/src/app-hosts/auraChannel.ts', '../../app-sdk/src/auraChannel.ts']) {
    assert.doesNotMatch(readFileSync(new URL(copy, import.meta.url), 'utf8'), /aura\.admin\.unlock/, copy);
  }
});
