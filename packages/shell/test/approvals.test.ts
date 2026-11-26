// Owner approvals (5.10): the /api/approvals handlers, the install gate and
// the shell dialog's sender check and answers, against an in-memory store
// that applies core's own transitions.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import type {
  AccessPrincipal, ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult,
  AuditInput, InstallBinding, NexusProgressEvent, PermissionDiff, Principal, SetupTicket,
} from '@aura/core';
import {
  createApproval, decideApproval, getApproval, listApprovals, unblockApp,
  type ApprovalRouteDeps, type RouteCtx,
} from '../src/lib/approvals/routes.ts';
import { installGate, runInstall } from '../src/lib/approvals/nexus.ts';
import { agentHooksDisplay, contextWrite, installDisplay, installLevel, installRisks, requesterReason } from '../src/lib/approvals/display.ts';
import { approvedOrAsk, presentsApproval } from '../src/lib/approvals/service.ts';
import {
  approvalReply, freshViaOf, outcomeOf, parseApprovalView, passwordTransportNote, PASSWORD_OVER_HTTP_NOTE,
} from '../src/lib/approvals/dialogClient.ts';
import { blockableApp } from '../src/lib/approvals/service.ts';
import { approvalBelongsToSender, authorizeShellMessage, type ChannelSender } from '../src/lib/auraChannelShell.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';

// ── fakes ───────────────────────────────────────────────────────────────────

class MemoryStore {
  records = new Map<string, ApprovalRecord>();
  blocked = new Map<string, { at: number; by: string }>();
  now = 1_800_000_000_000;
  limited = false;

  async create(request: ApprovalRequest): Promise<ApprovalResult> {
    const appId = core.requesterAppId(request.requester);
    if (appId && this.blocked.has(appId)) return { ok: false, reason: 'blocked' };
    if (this.limited) return { ok: false, reason: 'rate-limited' };
    const held = [...this.records.values()].find((r) =>
      core.effectiveApprovalState(r, this.now) === 'pending' && core.sameRequester(r.requester, request.requester));
    if (held) {
      return held.action === request.action && held.payloadHash === request.payloadHash
        ? { ok: true, record: held } : { ok: false, reason: 'too-many-pending' };
    }
    const record = core.newApprovalRecord(request, core.newApprovalId(), this.now);
    this.records.set(record.id, record);
    return { ok: true, record };
  }
  async get(id: string) {
    const r = this.records.get(id);
    return r ? { ...r, state: core.effectiveApprovalState(r, this.now) } : null;
  }
  async listPending() { return [...this.records.values()].filter((r) => core.effectiveApprovalState(r, this.now) === 'pending'); }
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
  async isBlocked(appId: string) { return this.blocked.has(appId); }
  async block(appId: string, by: string) { this.blocked.set(appId, { at: this.now, by }); }
  async unblock(appId: string) { return this.blocked.delete(appId); }
  async listBlocked() { return [...this.blocked].map(([appId, v]) => ({ appId, ...v })); }
}

const TERMINAL: Principal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', userId: 'default', verification: 'verified' };
const OTHER: Principal = { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified' };
const NEXUS_OWNER: Principal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-nexus', verification: 'verified', through: { appId: 'com.aura.nexus', instanceId: 'com.aura.nexus-1' } };
const ANON: Principal = { kind: 'anonymous', verification: 'unverified' };
const PASSWORD = 'correct horse battery';

let store: MemoryStore;
let audits: AuditInput[];
let tickets: Map<string, SetupTicket>;
let scheme: string;
/** D63: the owner's switch `fresh-auth-require-https`. */
let requireHttps: boolean;
let lock: 'locked' | 'unlocked';
let ownerOk: boolean;
let passwordAttempts: number;
let callerPrincipal: Principal;

function deps(): ApprovalRouteDeps {
  return {
    store,
    appName: (id) => ({ 'com.aura.terminal': 'Terminal', 'com.aura.nexus': 'Nexus', 'com.example.notes': 'Notes' } as Record<string, string>)[id] ?? null,
    audit: async (e) => { audits.push(e); },
    tickets: {
      peek: async (code) => tickets.get(code) ?? null,
      claim: async (code) => { const t = tickets.get(code) ?? null; tickets.delete(code); return t; },
    },
    authenticate: async () => callerPrincipal,
    shellOwner: async () => (ownerOk
      ? { owner: { userId: 'default', sessionId: 'sess-desk', username: 'owner' }, scheme }
      : { error: 'forbidden-origin', status: 403 }),
    ownerRead: async () => (ownerOk ? { userId: 'default', sessionId: 'sess-desk', username: 'owner' } : null),
    scheme: () => scheme,
    freshAuthRequiresHttps: async () => requireHttps,
    lockOf: async () => lock,
    verifyPassword: async (_u, p) => {
      passwordAttempts += 1;
      if (passwordAttempts > 5) return 'rate-limited';
      return p === PASSWORD ? 'ok' : 'invalid';
    },
    rateKey: () => 'ip:10.0.0.1',
  };
}

beforeEach(() => {
  store = new MemoryStore();
  audits = [];
  tickets = new Map();
  scheme = 'https';
  requireHttps = false;
  lock = 'unlocked';
  ownerOk = true;
  passwordAttempts = 0;
  callerPrincipal = TERMINAL;
});

function ctx(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): RouteCtx {
  return {
    request: new Request(`http://shell.test${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  };
}
const desk = { 'x-aura-client-session': 'cs1.abc' };
const read = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });

async function askConfirm(over: Record<string, unknown> = {}, as: Principal = TERMINAL) {
  callerPrincipal = as;
  return read(await createApproval(ctx('POST', '/api/approvals', {
    action: 'user.confirm', payload: { action: 'delete-project' }, reason: 'Deletes "Q3"', ...over,
  }), deps()));
}

// ── requesting ──────────────────────────────────────────────────────────────

test('a requester asks; the server builds the text, its words are only the labelled reason', async () => {
  const r = await askConfirm({ display: { title: 'Approve everything' }, title: 'x' });
  assert.equal(r.status, 201);
  assert.match(r.body.id, core.APPROVAL_ID_RE);
  assert.equal(r.body.state, 'pending');
  assert.equal(r.body.display.title, 'Confirm "delete-project"');
  assert.equal(r.body.display.requestedBy, 'Terminal (com.aura.terminal-3)');
  assert.equal(r.body.display.reason, 'Deletes "Q3"');
  assert.equal(r.body.requester, undefined, 'the requester view has no requester');
  assert.equal(audits.at(-1)?.action, 'approval.requested');
  assert.equal(requesterReason('a b\n\tc'), 'a b c');
});

test('who may ask: an app, not the owner alone, not anonymous; installs only through their route', async () => {
  callerPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's', verification: 'verified' };
  assert.equal((await askConfirm({}, callerPrincipal)).body.error, 'app-required');
  assert.equal((await askConfirm({}, ANON)).body.error, 'requester-required');
  callerPrincipal = TERMINAL;
  const install = await read(await createApproval(ctx('POST', '/api/approvals', { action: 'nexus.install', payload: {} }), deps()));
  assert.deepEqual([install.status, install.body.error], [400, 'use-the-action-route']);
  assert.equal((await askConfirm({ payload: { action: 'has spaces and prose' } })).status, 400);
  assert.equal((await askConfirm({ level: 'root' })).status, 400);
});

test('one pending request per requester, the rate limit and a block answer with their codes', async () => {
  const first = await askConfirm();
  assert.equal((await askConfirm()).body.id, first.body.id, 'the same request again is the same record');
  assert.deepEqual([(await askConfirm({ payload: { action: 'other' } })).status], [429]);
  store.limited = true;
  assert.equal((await askConfirm({}, OTHER)).body.error, 'rate-limited');
  store.limited = false;
  await store.block('com.example.notes', 'user:default');
  assert.deepEqual([(await askConfirm({}, OTHER)).status, (await askConfirm({}, OTHER)).body.error], [403, 'blocked']);
});

test('polling: the requester reads its own request, another caller gets 404', async () => {
  const { body } = await askConfirm();
  callerPrincipal = TERMINAL;
  ownerOk = false;
  const own = await read(await getApproval(ctx('GET', `/api/approvals/${body.id}`, undefined, { authorization: 'Bearer aura1.x' }), body.id, deps()));
  assert.deepEqual([own.status, own.body.state], [200, 'pending']);
  callerPrincipal = OTHER;
  assert.equal((await getApproval(ctx('GET', `/api/approvals/${body.id}`, undefined, { authorization: 'Bearer aura1.y' }), body.id, deps())).status, 404);
  ownerOk = true;
  const owner = await read(await getApproval(ctx('GET', `/api/approvals/${body.id}`), body.id, deps()));
  assert.equal(owner.body.appId, 'com.aura.terminal', 'the owner view names the app for the frame check');
});

// ── deciding ────────────────────────────────────────────────────────────────

const decide = async (id: string, decision: string, body: unknown = {}, headers: Record<string, string> = desk) =>
  read(await decideApproval(ctx('POST', `/api/approvals/${id}/${decision}`, body, headers), id, decision, deps()));

test('only the owner in the shell document decides: tokens, keys, apps, a locked tab are refused', async () => {
  const { body } = await askConfirm();
  assert.equal((await decide(body.id, 'approve', {}, { ...desk, authorization: 'Bearer aura1.token' })).body.error, 'decider-required');
  assert.equal((await decide(body.id, 'approve', {}, { ...desk, authorization: 'Bearer aura_k1_key' })).body.error, 'decider-required');
  assert.equal((await decide(body.id, 'approve', {}, { ...desk, [GATEWAY_IDENTITY_HEADER]: 'claim' })).status, 403);
  ownerOk = false;
  assert.equal((await decide(body.id, 'approve')).body.error, 'forbidden-origin');
  ownerOk = true;
  lock = 'locked';
  assert.equal((await decide(body.id, 'approve')).body.error, 'locked');
  assert.equal((await decide(body.id, 'approve', {}, {})).body.error, 'locked', 'no client session reads as locked');
  lock = 'unlocked';
  assert.equal((await store.get(body.id))?.state, 'pending', 'nothing above decided it');

  const ok = await decide(body.id, 'approve');
  assert.deepEqual([ok.status, ok.body.state], [200, 'approved']);
  const a = audits.at(-1)!;
  assert.equal(a.action, 'approval.approved');
  assert.deepEqual(a.by, { kind: 'user', userId: 'default', session: 'sess-des' });
  assert.match(String(a.detail?.['requestedBy']), /instance com\.aura\.terminal-3/);
  assert.equal(a.detail?.['decidedBy'], 'owner default');
  assert.equal((await decide(body.id, 'approve')).status, 409, 'decided once');
});

test('fresh: HTTPS and the password, rate limited; over HTTP with HTTPS required it is the operator\'s', async () => {
  const { body } = await askConfirm({ level: 'fresh' });
  scheme = 'http';
  requireHttps = true;
  const http = await decide(body.id, 'approve', { password: PASSWORD });
  assert.equal(http.body.error, 'operator-required');
  assert.match(http.body.message, new RegExp(`aura approve ${body.id}`));
  scheme = 'https';
  assert.equal((await decide(body.id, 'approve')).body.error, 'password-required');
  assert.equal((await decide(body.id, 'approve', { password: 'wrong' })).body.error, 'invalid-credentials');
  const ok = await decide(body.id, 'approve', { password: PASSWORD });
  assert.equal(ok.body.state, 'approved');
  assert.equal(audits.at(-1)?.detail?.['fresh'], true);
  assert.doesNotMatch(JSON.stringify(audits), /correct horse/, 'the password is never audited');
  assert.doesNotMatch(JSON.stringify([...store.records.values()]), /correct horse/, 'nor stored');

  const next = await askConfirm({ level: 'fresh', payload: { action: 'again' } });
  passwordAttempts = 5;
  assert.deepEqual([(await decide(next.body.id, 'approve', { password: PASSWORD })).status], [429]);
  assert.equal((await decide(next.body.id, 'deny')).body.state, 'denied', 'denying needs no password');
});

test('D63: fresh over HTTP takes the password by default, with every other rule kept', async () => {
  scheme = 'http';
  const { body } = await askConfirm({ level: 'fresh' });
  // The owner's views say how a fresh approval is given on this connection.
  const list = await read(await listApprovals(ctx('GET', '/api/approvals'), deps()));
  assert.equal(list.body.freshVia, 'password');
  assert.equal(list.body.pending[0].freshVia, 'password');
  assert.equal((await read(await getApproval(ctx('GET', `/api/approvals/${body.id}`), body.id, deps()))).body.freshVia, 'password');

  assert.equal((await decide(body.id, 'approve')).body.error, 'password-required');
  assert.equal((await decide(body.id, 'approve', { password: 'wrong' })).body.error, 'invalid-credentials');
  lock = 'locked';
  assert.equal((await decide(body.id, 'approve', { password: PASSWORD })).body.error, 'locked');
  lock = 'unlocked';
  callerPrincipal = TERMINAL;
  const bearer = await decide(body.id, 'approve', { password: PASSWORD }, { ...desk, authorization: 'Bearer aura1.x' });
  assert.equal(bearer.status, 403, 'the requester never approves');
  const ok = await decide(body.id, 'approve', { password: PASSWORD });
  assert.equal(ok.body.state, 'approved');
  assert.equal(audits.at(-1)?.detail?.['fresh'], true);
  assert.equal((await decide(body.id, 'approve', { password: PASSWORD })).status, 409, 'single use');

  const next = await askConfirm({ level: 'fresh', payload: { action: 'again' } });
  passwordAttempts = 5;
  assert.equal((await decide(next.body.id, 'approve', { password: PASSWORD })).status, 429, 'the login rate limit');
});

test('D63: with HTTPS required, HTTP views say operator, HTTPS still takes the password, the operator always works', async () => {
  requireHttps = true;
  scheme = 'http';
  const { body } = await askConfirm({ level: 'fresh' });
  assert.equal((await read(await listApprovals(ctx('GET', '/api/approvals'), deps()))).body.pending[0].freshVia, 'operator');
  assert.equal((await decide(body.id, 'approve', { password: PASSWORD })).body.error, 'operator-required');
  assert.equal(passwordAttempts, 0, 'the password was not even checked');
  scheme = 'https';
  assert.equal((await read(await listApprovals(ctx('GET', '/api/approvals'), deps()))).body.freshVia, 'password');
  tickets.set('op', { purpose: 'operator', subject: `approve:${body.id}` } as SetupTicket);
  scheme = 'http';
  const op = await read(await decideApproval(ctx('POST', `/api/approvals/${body.id}/approve`, { operatorCode: 'op' }), body.id, 'approve', deps()));
  assert.equal(op.body.state, 'approved', 'the host operator approves in every mode');
});

test('D63: the dialog asks for what the server takes, with a note over HTTP', () => {
  assert.equal(freshViaOf('password', 'http:'), 'password');
  assert.equal(freshViaOf('operator', 'https:'), 'operator');
  assert.equal(freshViaOf(undefined, 'http:'), 'operator', 'an older server: HTTP stays the operator\'s');
  assert.equal(freshViaOf('nonsense', 'https:'), 'password');
  assert.equal(passwordTransportNote({ level: 'fresh', freshVia: 'password' }, 'http:'), PASSWORD_OVER_HTTP_NOTE);
  assert.equal(PASSWORD_OVER_HTTP_NOTE, '(HTTP: password sent unencrypted)');
  assert.equal(passwordTransportNote({ level: 'fresh', freshVia: 'password' }, 'https:'), null);
  assert.equal(passwordTransportNote({ level: 'fresh', freshVia: 'operator' }, 'http:'), null, 'the refusal text instead');
  assert.equal(passwordTransportNote({ level: 'session', freshVia: 'password' }, 'http:'), null);
});

test('D63: the central point: freshAuthPath and the live switch read', async () => {
  const { freshAuthPath, freshAuthRequiresHttps } = await import('../src/lib/access/decide.ts');
  assert.equal(freshAuthPath('https', true), 'password');
  assert.equal(freshAuthPath('https', false), 'password');
  assert.equal(freshAuthPath('http', false), 'password');
  assert.equal(freshAuthPath('http', true), 'operator');
  assert.equal(await freshAuthRequiresHttps({ get: async () => ({}) }), false, 'the default is off');
  assert.equal(await freshAuthRequiresHttps({ get: async () => ({ 'fresh-auth-require-https': true }) }), true);
  assert.equal(await freshAuthRequiresHttps({ get: async () => { throw new Error('valkey down'); } }), true, 'an unreadable switch keeps HTTP to the operator');
  assert.equal(await freshAuthRequiresHttps(null), true);
});

test('deny and block stops the app asking until the block is lifted', async () => {
  const { body } = await askConfirm({}, OTHER);
  const r = await decide(body.id, 'deny', { block: true });
  assert.deepEqual([r.body.state, r.body.blocked], ['denied', 'com.example.notes']);
  assert.equal((await askConfirm({}, OTHER)).body.error, 'blocked');
  ownerOk = true;
  const listed = await read(await listApprovals(ctx('GET', '/api/approvals'), deps()));
  assert.deepEqual(listed.body.blocked.map((b: { appId: string }) => b.appId), ['com.example.notes']);
  const lifted = await read(await unblockApp(ctx('DELETE', '/api/approvals/blocked/com.example.notes', {}, {}), 'com.example.notes', deps()));
  assert.equal(lifted.body.removed, true);
  assert.equal((await askConfirm({}, OTHER)).status, 201);
});

test('L4: deny and block never blocks the owner acting through an app, nor Settings; only an app that asked as itself', async () => {
  const SETTINGS_OWNER: Principal = { ...NEXUS_OWNER, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as Principal;
  const SETTINGS_APP: Principal = { kind: 'instance', appId: 'com.aura.settings', instanceId: 'com.aura.settings-1', verification: 'verified' };
  for (const who of [SETTINGS_OWNER, SETTINGS_APP, NEXUS_OWNER]) {
    const { body } = await askConfirm({}, who);
    ownerOk = true;
    const view = (await read(await getApproval(ctx('GET', `/api/approvals/${body.id}`), body.id, deps()))).body;
    assert.equal(view.blockable, null, 'the dialog offers no block');
    const r = await decide(body.id, 'deny', { block: true });
    assert.deepEqual([r.body.state, r.body.blocked], ['denied', undefined]);
    assert.notEqual((await askConfirm({}, who)).body.error, 'blocked', 'it can still ask');
  }
  assert.equal(blockableApp({ kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1' }), 'com.example.notes');
});

test('the host operator: a code for exactly this decision; preview does not use it up', async () => {
  const { body } = await askConfirm({ level: 'fresh' });
  tickets.set('CODE-1', { sha256: 'x', purpose: 'operator', expiresAt: Infinity, subject: `approve:${body.id}` });
  tickets.set('CODE-2', { sha256: 'y', purpose: 'operator', expiresAt: Infinity, subject: 'approve:apr_AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal((await decide(body.id, 'approve', { operatorCode: 'CODE-2' }, {})).body.error, 'operator-code-invalid');
  const preview = await decide(body.id, 'approve', { operatorCode: 'CODE-1', preview: true }, {});
  assert.equal(preview.body.display.title, 'Confirm "delete-project"');
  assert.equal((await store.get(body.id))?.state, 'pending');
  const ok = await decide(body.id, 'approve', { operatorCode: 'CODE-1' }, {});
  assert.equal(ok.body.state, 'approved', 'the operator satisfies fresh');
  assert.equal(audits.at(-1)?.detail?.['decidedBy'], 'host operator');
  assert.equal((await decide(body.id, 'approve', { operatorCode: 'CODE-1' }, {})).body.error, 'operator-code-invalid', 'single use');
});

test('the requester consumes a confirmation once, for exactly its action', async () => {
  const { body } = await askConfirm();
  await decide(body.id, 'approve');
  callerPrincipal = OTHER;
  const consume = async (action: string) => read(await decideApproval(ctx('POST', `/api/approvals/${body.id}/consume`, { payload: { action } }), body.id, 'consume', deps()));
  assert.equal((await consume('delete-project')).body.error, 'mismatch', 'another instance');
  callerPrincipal = TERMINAL;
  assert.equal((await consume('something-else')).body.error, 'mismatch');
  assert.equal((await consume('delete-project')).body.ok, true);
  assert.equal((await consume('delete-project')).body.error, 'wrong-state', 'single use');
  assert.equal(audits.at(-1)?.action, 'approval.consumed');
});

test('the owner list: pending requests only for the owner on the shell', async () => {
  await askConfirm();
  const list = await read(await listApprovals(ctx('GET', '/api/approvals'), deps()));
  assert.equal(list.body.pending.length, 1);
  assert.equal((await listApprovals(ctx('GET', '/api/approvals', undefined, { authorization: 'Bearer aura1.x' }), deps())).status, 403);
  assert.equal((await listApprovals(ctx('GET', '/api/approvals', undefined, { 'sec-fetch-site': 'same-site' }), deps())).status, 403);
  ownerOk = false;
  assert.equal((await listApprovals(ctx('GET', '/api/approvals'), deps())).status, 401);
});

// ── the install gate ────────────────────────────────────────────────────────

const BINDING: InstallBinding = {
  action: 'nexus.install', appId: 'com.example.notes', name: 'Notes', version: '1.2.0', source: 'oci',
  address: 'ghcr.io/x/notes:1.2.0', digest: 'sha256:aaa', scope: 'user', identity: null, tools: ['git'], permissions: [], context: [],
  replaceCheckout: false, execution: null, exposure: { sidecars: [], hostPublish: [], portExposes: [], hosts: [] },
};
const DIFF: PermissionDiff = {
  appId: 'com.example.notes', versionFrom: null, versionTo: '1.2.0', toolsAdded: ['git'], toolsRemoved: [],
  permissionsAdded: [], permissionsRemoved: [], dataProviderAdded: false, dataProviderRemoved: false, intentFiltersAdded: [],
  contextAdded: [], contextRemoved: [],
};

/** Core's pipeline as far as the gate: ask `approval`, else stop at permission.needed. */
async function* pipeline(binding: InstallBinding, approval: (b: InstallBinding, d: PermissionDiff) => Promise<boolean>): AsyncGenerator<NexusProgressEvent, null, unknown> {
  if (!(await approval(binding, DIFF))) {
    yield { type: 'permission.needed', diff: DIFF, binding };
    throw new Error('Install cancelled by user');
  }
  yield { type: 'install.done', record: { id: binding.appId, version: binding.version } as never };
  return null;
}

async function install(principal: AccessPrincipal, headers: Record<string, string> = {}, binding = BINDING, operatorCode?: string) {
  const req = new Request('http://shell.test/api/nexus/install', { method: 'POST', headers });
  const gate = installGate(deps(), principal, req, operatorCode);
  return read(await runInstall(pipeline(binding, gate.approval), gate));
}

test('install without an approval answers needs-approval with the exact diff; with it, installs once', async () => {
  const first = await install(TERMINAL);
  assert.equal(first.status, 202);
  assert.equal(first.body.error, 'needs-approval');
  assert.equal(first.body.level, 'session');
  assert.deepEqual(first.body.diff, DIFF);
  assert.equal(first.body.display.title, 'Install Notes 1.2.0');
  assert.ok(first.body.display.details.includes('Artifact: sha256:aaa'));
  assert.ok(first.body.display.details.includes('Scope: user'));
  const id = first.body.approvalId;

  // Not approved yet: the id alone is nothing.
  assert.equal((await install(TERMINAL, { 'x-aura-approval': id })).status, 202);
  await decide(id, 'approve');
  const done = await install(TERMINAL, { 'x-aura-approval': id });
  assert.deepEqual([done.status, done.body.ok], [200, true]);
  assert.equal((await install(TERMINAL, { 'x-aura-approval': id })).status, 202, 'single use');
});

test('stream C: an approved install grants the Context keys it names, attributed to the approver', async () => {
  const granted: Array<{ id: string; permission: string; appScope?: string; by: unknown }> = [];
  const fakeGrants = () => ({
    grants: { grant: async (s: { id: string }, permission: string, o: { by: unknown; appScope?: string }) => { granted.push({ id: s.id, permission, appScope: o.appScope, by: o.by }); return { record: {}, changed: true }; } },
    audit: { record: async () => '' },
  }) as never;
  const binding = { ...BINDING, context: ['OPENAI_API_KEY'] };
  const run = async (headers: Record<string, string> = {}) => {
    const gate = installGate(deps(), NEXUS_OWNER, new Request('http://shell.test/api/nexus/install', { method: 'POST', headers }), undefined, undefined, fakeGrants);
    return read(await runInstall(pipeline(binding, gate.approval), gate));
  };
  const first = await run();
  assert.equal(first.status, 202);
  assert.equal(first.body.level, 'fresh');
  assert.equal(granted.length, 0, 'nothing granted before the owner decides');
  await decide(first.body.approvalId, 'approve', { password: PASSWORD });
  const done = await run({ 'x-aura-approval': first.body.approvalId });
  assert.equal(done.body.ok, true);
  assert.deepEqual(granted.map((g) => [g.id, g.permission, g.appScope]), [['com.example.notes', 'context.read:OPENAI_API_KEY', 'user']]);
  assert.equal((granted[0]!.by as { kind: string }).kind, 'user');
});

test('a moved tag, another scope or another requester needs a new approval', async () => {
  const { body } = await install(NEXUS_OWNER);
  await decide(body.approvalId, 'approve');
  const moved = await install(NEXUS_OWNER, { 'x-aura-approval': body.approvalId }, { ...BINDING, digest: 'sha256:bbb' });
  assert.deepEqual([moved.status, moved.body.refused], [202, 'mismatch']);
  const other = await install(NEXUS_OWNER, { 'x-aura-approval': body.approvalId }, { ...BINDING, scope: 'global' });
  assert.notEqual(other.body.ok, true, 'another scope is not installed');
  const stolen = await install(OTHER, { 'x-aura-approval': body.approvalId });
  assert.equal(stolen.status, 202);
  assert.equal((await install(NEXUS_OWNER, { 'x-aura-approval': body.approvalId })).body.ok, true, 'the exact request still works');
});

test('M1: replacing a dev checkout is bound and shown; an approval without it does not cover it', async () => {
  const { body } = await install(NEXUS_OWNER);
  await decide(body.approvalId, 'approve');
  const forced = await install(NEXUS_OWNER, { 'x-aura-approval': body.approvalId }, { ...BINDING, replaceCheckout: true });
  assert.deepEqual([forced.status, forced.body.refused], [202, 'mismatch']);
  assert.ok(forced.body.display.details.includes('Replaces your dev checkout of com.example.notes (uncommitted work is lost)'));
  assert.ok(!installDisplay(BINDING, DIFF, 'x').details.some((d) => /dev checkout/.test(d)));
  assert.equal((await install(NEXUS_OWNER, { 'x-aura-approval': body.approvalId })).body.ok, true, 'the exact request still works');
});

test('docker or privileged sidecars make an install fresh; the host operator confirms with a code', async () => {
  assert.equal(installLevel({ ...BINDING, tools: ['docker'] }, DIFF), 'fresh');
  assert.equal(installLevel({ ...BINDING, permissions: ['sidecars.privileged'] }, DIFF), 'fresh');
  assert.equal(installLevel(BINDING, DIFF), 'session');
  // Stream C: an approval that grants Context keys needs the password and lists them.
  assert.equal(installLevel({ ...BINDING, context: ['OPENAI_API_KEY'] }, DIFF), 'fresh');
  assert.ok(installDisplay({ ...BINDING, context: ['OPENAI_API_KEY'] }, { ...DIFF, contextAdded: ['OPENAI_API_KEY'] }, 'x').details
    .some((d) => /Context keys it may read \(granted with this approval\): OPENAI_API_KEY/.test(d)));
  assert.ok(installDisplay({ ...BINDING, tools: ['docker'] }, DIFF, 'x').highRisk!.some((r) => /root on the host/.test(r.why)));

  const host = await install(ANON);
  assert.equal(host.body.operatorOnly, true);
  assert.equal(host.body.operatorSubject, `nexus.install:${core.payloadHash(BINDING)}`);
  tickets.set('OP', { sha256: 'z', purpose: 'operator', expiresAt: Infinity, subject: host.body.operatorSubject });
  assert.equal((await install(ANON, {}, { ...BINDING, digest: 'sha256:ccc' }, 'OP')).status, 202, 'a code for another artifact');
  tickets.set('OP', { sha256: 'z', purpose: 'operator', expiresAt: Infinity, subject: host.body.operatorSubject });
  assert.equal((await install(ANON, {}, BINDING, 'OP')).body.ok, true);
});

test('agent hooks: an app installs them once per owner approval', async () => {
  const TX: Principal = { kind: 'instance', appId: 'io.lakner.terminalx', instanceId: 'io.lakner.terminalx-1', userId: 'default', verification: 'verified' };
  const ask = async (op: 'install' | 'remove', headers: Record<string, string> = {}) => {
    const r = await approvedOrAsk(deps(), TX, ctx('POST', '/api/terminal/agent-hooks', undefined, headers).request, {
      action: 'terminal.agent-hooks', payload: { op }, level: 'session', display: (by) => agentHooksDisplay({ op }, by),
    });
    return r ? read(r) : null;
  };
  const first = await ask('install');
  assert.equal(first?.status, 202);
  assert.equal(first?.body.action, 'terminal.agent-hooks');
  assert.equal(first?.body.display.title, 'Install the Terminal\'s agent hooks');
  assert.match(first?.body.display.details[0], /~\/\.claude\/settings\.json/);
  const id = first!.body.approvalId as string;
  assert.equal((await ask('install', { 'x-aura-approval': id }))?.status, 202, 'not approved yet');
  await decide(id, 'approve');
  assert.equal(await ask('install', { 'x-aura-approval': id }), null, 'goes ahead');
  assert.equal((await ask('install', { 'x-aura-approval': id }))?.status, 202, 'single use');
});

test('Aura Context writes: the payload is the normalised write, never the value', () => {
  assert.deepEqual(contextWrite({ op: 'set', key: 'GITHUB_TOKEN', value: 'secret' }), { op: 'set', key: 'GITHUB_TOKEN', kind: 'secret', inject: ['env', 'file'] });
  assert.deepEqual(contextWrite({ op: 'set', key: 'X', kind: 'variable', inject: [] }), { op: 'set', key: 'X', kind: 'variable', inject: [] });
  assert.equal(contextWrite({ op: 'set', key: 'lower' }), null);
  assert.deepEqual(contextWrite({ op: 'delete', key: 'X' }), { op: 'delete', key: 'X' });
  assert.equal(presentsApproval(new Request('http://x', { headers: { 'x-aura-approval': 'apr_AAAAAAAAAAAAAAAAAAAAAA' } })), true);
  assert.equal(presentsApproval(new Request('http://x', { headers: { 'x-aura-approval': 'nope' } })), false);
});

test('the manifest: approvals routes are classified, Aura Context writes need fresh auth', () => {
  const r = ROUTE_ACCESS_MANIFEST.routes;
  assert.ok(r['/api/approvals']?.methods?.POST?.permissions?.includes('user.confirm'));
  assert.equal(r['/api/approvals']?.methods?.GET?.target, 'session');
  assert.equal(r['/api/os/context']?.methods?.POST?.freshAuth, true);
  assert.equal(r['/api/os/context']?.methods?.GET?.freshAuth, undefined);
  assert.equal(r['/api/os/context/[key]']?.methods?.DELETE?.freshAuth, true);
});

// ── the dialog ──────────────────────────────────────────────────────────────

const frame = (appId: string, system = false) => ({ window: {}, origin: `http://${appId}.test`, appId, system, element: {} });
const sender = (appId: string, direct = true): ChannelSender<unknown> => ({ endpoint: 'app', frame: frame(appId), direct });

test('dialog sender check: an App Host window, for its own app\'s approval only', () => {
  for (const type of ['aura.approval.request', 'aura.user.confirm.request']) {
    assert.equal(authorizeShellMessage(type, sender('com.example.notes'), {}, { nativeRuntime: false }), true, type);
    assert.equal(authorizeShellMessage(type, sender('com.example.notes', false), {}, { nativeRuntime: false }), false, `${type} nested`);
    assert.equal(authorizeShellMessage(type, { endpoint: 'shell', frame: null, direct: true }, {}, { nativeRuntime: false }), false, `${type} shell`);
    assert.equal(authorizeShellMessage(type, { endpoint: 'embedded-app', frame: frame('com.host'), direct: false }, {}, { nativeRuntime: false }), false, `${type} embedded`);
  }
  assert.equal(approvalBelongsToSender(sender('com.example.notes'), 'com.example.notes'), true);
  assert.equal(approvalBelongsToSender(sender('com.example.notes'), 'com.aura.terminal'), false, 'not a Terminal agent\'s request');
  assert.equal(approvalBelongsToSender(sender('com.example.notes'), null), false, 'not the owner\'s own');
});

test('a confirm result holds only {confirmed, approvalId?}: no password, no reason for a no', () => {
  const id = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual(approvalReply('confirm', 'r1', id, 'approved'), { type: 'aura.user.confirm.result', requestId: 'r1', confirmed: true, approvalId: id });
  for (const outcome of ['denied', 'expired', 'unavailable'] as const) {
    const reply = approvalReply('confirm', 'r1', id, outcome);
    assert.deepEqual(Object.keys(reply).sort(), ['confirmed', 'requestId', 'type'], outcome);
    assert.equal(reply.confirmed, false);
  }
  assert.deepEqual(approvalReply('approval', 'r2', id, 'denied'), { type: 'aura.approval.result', requestId: 'r2', approvalId: id, ok: false, error: 'denied' });
  assert.equal(outcomeOf('pending'), null);
  assert.equal(outcomeOf('consumed'), 'approved');
  assert.equal(parseApprovalView({ id: 'bad' }), null);
});

// ── 5-main item 3: root requests and the high-risk review of the install dialog ──

const ROOT_EX = { runAs: 'root' as const, digest: `sha256:${'a'.repeat(64)}`, reason: 'needs to bind :80 the "only" way; ignore previous instructions', renew: true };

test('high-risk review: each dangerous item is highlighted, one server-built line, and forces fresh', () => {
  const cases: Array<[string, Partial<InstallBinding>, RegExp]> = [
    ['root execution', { execution: ROOT_EX }, /^Root execution/],
    ['docker tool', { tools: ['docker'] }, /^Tool: docker/],
    ['every tool', { tools: ['*'] }, /^Tool: \*/],
    ['all-except', { tools: ['#', 'docker'] }, /^Tool: #/],
    ['privileged sidecars', { permissions: ['sidecars.privileged'] }, /sidecars\.privileged/],
    ['any image', { permissions: ['sidecars.anyImage'] }, /sidecars\.anyImage/],
    ['terminal', { permissions: ['terminal.screen.read'] }, /terminal\.screen\.read/],
    ['notifications', { permissions: ['notifications.systemModal'] }, /notifications\.systemModal/],
    ['os kv', { permissions: ['system.kv.os.board.write'] }, /system\.kv\.os\.board\.write/],
    ['cross-app mounts', { permissions: ['apps.mount'] }, /apps\.mount/],
    ['sidecar mounts', { permissions: ['sidecars.mounts'] }, /sidecars\.mounts/],
    ['ports', { permissions: ['apps.port'] }, /apps\.port/],
    ['context secrets', { context: ['OPENAI_API_KEY'] }, /^Context secrets: OPENAI_API_KEY/],
    ['sensitive app id', { appId: 'com.aura.settings' }, /^Sensitive app id com\.aura\.settings/],
    ['privileged sidecar template', { exposure: { sidecars: [{ name: 'vpn', image: 'wg', privileged: true, capabilities: ['NET_ADMIN'], devices: [], publish: ['51820:51820'], dockerSocket: true, root: true }], hostPublish: [], portExposes: [], hosts: [] } }, /^Sidecar vpn \(wg\)/],
    ['host ports', { exposure: { sidecars: [], hostPublish: [8080], portExposes: [], hosts: [] } }, /^Host ports: 8080/],
    ['other apps ports', { exposure: { sidecars: [], hostPublish: [], portExposes: ['com.x.db:5432'], hosts: [] } }, /^Other apps' ports/],
  ];
  for (const [name, patch, item] of cases) {
    const b = { ...BINDING, ...patch } as InstallBinding;
    const risks = installRisks(b, DIFF);
    assert.ok(risks.some((r) => item.test(r.item) && r.why.length > 0 && !r.why.includes('\n')), name);
    assert.equal(installLevel(b, DIFF), 'fresh', `${name} forces fresh`);
    const d = installDisplay(b, DIFF, 'Nexus');
    assert.ok(d.highRisk!.length >= 1, `${name}: a high-risk section`);
  }
  // Nothing dangerous: no section, one click.
  assert.equal(installDisplay(BINDING, DIFF, 'x').highRisk, undefined);
  assert.deepEqual(installRisks({ ...BINDING, permissions: ['storage.read', 'system.notifications', 'user.confirm'] }, DIFF), []);
  // The sidecar line names exactly what the template asks for.
  const sc = installRisks({ ...BINDING, exposure: cases[14]![1].exposure! } as InstallBinding, DIFF)[0]!;
  assert.match(sc.why, /--privileged, capabilities NET_ADMIN, host ports 51820:51820, the Docker socket, as the image's root/);
});

test('high-risk review: the app author\'s reason is only the labelled reason, never an item or explanation', () => {
  const d = installDisplay({ ...BINDING, execution: ROOT_EX }, DIFF, 'Nexus');
  assert.equal(d.reason, requesterReason(ROOT_EX.reason));
  assert.ok(!JSON.stringify(d.highRisk).includes('ignore previous'), 'never in the server text');
  assert.ok(!d.details.some((l) => l.includes('ignore previous')));
  assert.equal(d.highRisk![0]!.item, 'Root execution (runAs: root)', 'root first');
  assert.match(d.highRisk![0]!.why, /without it the app is installed but does not start/);
  assert.match(d.highRisk![0]!.why, /no capabilities, no Docker socket and no host access/);
  assert.ok(d.details.includes(`Root execution request: ${ROOT_EX.digest} (needs your approval now)`));
  // An update that keeps the approved config still shows it, not as new.
  const kept = installDisplay({ ...BINDING, execution: { ...ROOT_EX, renew: false } }, { ...DIFF, versionFrom: '1.1.0', toolsAdded: [] }, 'Nexus');
  assert.deepEqual([kept.highRisk![0]!.added, /keeps the root execution you approved/.test(kept.highRisk![0]!.why)], [false, true]);
  // On an update only what the update adds is NEW.
  const upd = installRisks({ ...BINDING, tools: ['docker', '*'] }, { ...DIFF, versionFrom: '1.1.0', toolsAdded: ['*'] });
  assert.deepEqual(upd.map((r) => [r.item, r.added]), [['Tool: docker', false], ['Tool: * (every tool)', true]]);
});

test('root request: the install approval binds it at fresh; the approved install is audited; another config needs a new approval', async () => {
  const audited: Array<{ action: string; detail: unknown }> = [];
  const fakeGrants = () => ({ grants: { grant: async () => ({ record: {}, changed: false }) }, audit: { record: async (e: { action: string; detail: unknown }) => { audited.push(e); return ''; } } }) as never;
  const binding = { ...BINDING, execution: ROOT_EX };
  const run = async (b: InstallBinding, headers: Record<string, string> = {}) => {
    const gate = installGate(deps(), NEXUS_OWNER, new Request('http://shell.test/api/nexus/install', { method: 'POST', headers }), undefined, undefined, fakeGrants);
    return read(await runInstall(pipeline(b, gate.approval), gate));
  };
  const first = await run(binding);
  assert.deepEqual([first.status, first.body.level], [202, 'fresh']);
  assert.equal(first.body.display.highRisk[0].item, 'Root execution (runAs: root)');
  const view = parseApprovalView({ ...first.body, id: first.body.approvalId, action: 'nexus.install', state: 'pending', level: 'fresh' });
  assert.equal(view?.display.highRisk?.[0]?.item, 'Root execution (runAs: root)', 'the dialog client keeps the section');
  // A session click is not enough for a fresh approval.
  const click = await decide(first.body.approvalId, 'approve');
  assert.notEqual(click.status, 200);
  await decide(first.body.approvalId, 'approve', { password: PASSWORD });
  // Another config (digest) is another binding: the approval does not cover it.
  const other = await run({ ...binding, execution: { ...ROOT_EX, digest: `sha256:${'b'.repeat(64)}` } }, { 'x-aura-approval': first.body.approvalId });
  assert.deepEqual([other.status, other.body.refused], [202, 'mismatch']);
  const done = await run(binding, { 'x-aura-approval': first.body.approvalId });
  assert.equal(done.body.ok, true);
  assert.deepEqual(audited.map((a) => a.action), ['app.execution-approved']);
  assert.equal((audited[0]!.detail as { digest: string }).digest, ROOT_EX.digest);
});
