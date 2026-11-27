// D102: approvals and credential requests on hold. The /api/approvals hold,
// cancel and deny-with-feedback paths, revalidation before approve and
// before use, the one hold notice and its removal, and the shell's Review
// pointer, against an in-memory store that applies core's own transitions.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import type {
  ApprovalCanceller, ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult,
  AuditInput, Principal, SetupTicket,
} from '@aura/core';
import { createApproval, decideApproval, getApproval, listApprovals, type ApprovalRouteDeps, type RouteCtx } from '../src/lib/approvals/routes.ts';
import {
  approvedOrAsk, consumeApproval, liveRevalidate, reconcileHoldNotices, requesterView, type ApprovalServiceDeps,
} from '../src/lib/approvals/service.ts';
import { holdNoticeInput, NOTICE_PUBLIC_TITLE, type HoldNoticeDeps } from '../src/lib/approvals/holdNotice.ts';
import { approvalReply, decisionErrorText, outcomeOf, parseApprovalView } from '../src/lib/approvals/dialogClient.ts';
import { APPROVAL_CONTEXT_LABEL, contextTarget, goToContext } from '../src/lib/notifications/context.ts';
import { requestCredential, collectCredential, type CredentialDeps } from '../src/lib/credentials.ts';

// ── fakes ───────────────────────────────────────────────────────────────────

class MemoryStore {
  records = new Map<string, ApprovalRecord>();
  blocked = new Set<string>();
  now = 1_800_000_000_000;

  async create(request: ApprovalRequest): Promise<ApprovalResult> {
    const appId = core.requesterAppId(request.requester);
    if (appId && this.blocked.has(appId)) return { ok: false, reason: 'blocked' };
    const open = [...this.records.values()].find((r) => {
      const s = core.effectiveApprovalState(r, this.now);
      return (s === 'pending' || s === 'approved') && core.sameRequester(r.requester, request.requester);
    });
    if (open) {
      if (open.action === request.action && open.payloadHash === request.payloadHash) return { ok: true, record: open, resumed: true };
      if (core.effectiveApprovalState(open, this.now) === 'pending') return { ok: false, reason: 'too-many-pending' };
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
  async deny(id: string, by: ApprovalDecider, feedback?: string) { return this.apply(id, { type: 'deny', by, ...(feedback ? { feedback } : {}) }); }
  async hold(id: string, by: ApprovalDecider) { return this.apply(id, { type: 'hold', by }); }
  async cancel(id: string, by: ApprovalCanceller) { return this.apply(id, { type: 'cancel', by }); }
  async setNotice(id: string, notice: string | null) { return this.apply(id, { type: 'notice', notice }); }
  async consume(id: string, claim: ApprovalClaim) { return this.apply(id, { type: 'consume', claim }); }
  async isBlocked(appId: string) { return this.blocked.has(appId); }
  async block(appId: string) { this.blocked.add(appId); }
  async unblock(appId: string) { return this.blocked.delete(appId); }
  async listBlocked() { return [...this.blocked].map((appId) => ({ appId, at: 0, by: '' })); }
}

class Notices implements HoldNoticeDeps {
  items = new Map<string, Record<string, unknown>>();
  removed: string[] = [];
  n = 0;
  async create(input: Record<string, unknown>) { const id = `ntf_test${++this.n}aaaaa`; this.items.set(id, input); return id; }
  async remove(id: string) { if (this.items.delete(id)) this.removed.push(id); }
  async listActive() {
    return [...this.items].map(([id, n]) => ({ id, approvalId: (n['context'] as { id: string }).id }));
  }
}

const TERMINAL: Principal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', userId: 'default', verification: 'verified' };
const OTHER: Principal = { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', userId: 'default', verification: 'verified' };

let store: MemoryStore;
let notices: Notices;
let audits: AuditInput[];
let lock: 'locked' | 'unlocked';
let callerPrincipal: Principal;
let running: Set<string>;
let installed: Set<string>;
let stored: Array<{ name: string; value: string }>;

function deps(): ApprovalRouteDeps & CredentialDeps {
  return {
    store,
    notices,
    appName: (id) => ({ 'com.aura.terminal': 'Terminal', 'com.example.notes': 'Notes' } as Record<string, string>)[id] ?? null,
    audit: async (e) => { audits.push(e); },
    revalidate: (record, when) => liveRevalidate(record, when, {
      isBlocked: async (appId) => store.blocked.has(appId),
      appInstalled: (appId) => installed.has(appId),
      instanceRunning: (id) => running.has(id),
    }),
    tickets: { peek: async () => null as SetupTicket | null, claim: async () => null as SetupTicket | null },
    authenticate: async () => callerPrincipal,
    shellOwner: async () => ({ owner: { userId: 'default', sessionId: 'sess-desk', username: 'owner' }, scheme: 'https' }),
    ownerRead: async () => ({ userId: 'default', sessionId: 'sess-desk', username: 'owner' }),
    scheme: () => 'https',
    freshAuthRequiresHttps: async () => false,
    lockOf: async () => lock,
    verifyPassword: async (_u, p) => (p === 'pw' ? 'ok' : 'invalid'),
    rateKey: () => 'ip:1',
    storeCredential: async (_u, ask, value) => { stored.push({ name: ask.name, value }); },
    // credentials
    resolve: async () => ({ principal: callerPrincipal, rejected: false }) as never,
    vault: {
      handleOf: async (_u: string, name: string) => `cred_${name.toLowerCase().padEnd(22, 'x').slice(0, 22)}`,
    } as never,
    grants: {} as never,
    appBinding: async () => ({ scope: undefined, installationId: null }),
    setupSecrets: async () => null,
  };
}

beforeEach(() => {
  store = new MemoryStore();
  notices = new Notices();
  audits = [];
  lock = 'unlocked';
  callerPrincipal = TERMINAL;
  running = new Set(['com.aura.terminal-3', 'com.example.notes-1']);
  installed = new Set(['com.aura.terminal', 'com.example.notes']);
  stored = [];
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

/** A deferrable request (app.source.open) as the Terminal CLI asks it, through a route gate. */
async function askOpen(as: Principal = TERMINAL, appId = 'notes') {
  callerPrincipal = as;
  const r = await approvedOrAsk(deps(), as as never, ctx('POST', '/api/apps/x/source-mode').request, {
    action: 'app.source.open', payload: { appId, scope: 'user', mode: 'open' }, level: 'session',
    display: (by) => ({ title: `Open the source of ${appId}`, details: [], requestedBy: by }),
  });
  return read(r!);
}
const decide = async (id: string, decision: string, body: unknown = {}, headers: Record<string, string> = desk) =>
  read(await decideApproval(ctx('POST', `/api/approvals/${id}/${decision}`, body, headers), id, decision, deps()));

// ── classes ─────────────────────────────────────────────────────────────────

test('the class comes from the catalog: an install is forced, app.source.open deferrable', async () => {
  const asked = await askOpen();
  assert.equal(asked.status, 202);
  assert.equal(asked.body['class'], 'deferrable');
  const rec = store.records.get(asked.body['approvalId'])!;
  assert.equal(rec.class, 'deferrable');
  callerPrincipal = OTHER;
  const install = await read((await approvedOrAsk(deps(), OTHER as never, ctx('POST', '/api/nexus/install').request, {
    action: 'nexus.install', payload: { digest: 'sha256:x' }, level: 'session',
    display: (by) => ({ title: 'Install X', details: [], requestedBy: by }),
  }))!);
  assert.equal(install.body['class'], 'forced');
});

// ── hold ────────────────────────────────────────────────────────────────────

test('Later: held, still pending, one locked/high/private notice; the requester sees heldAt', async () => {
  const id = (await askOpen()).body['approvalId'];
  const h = await decide(id, 'hold');
  assert.equal(h.status, 200);
  assert.equal(h.body['state'], 'pending');
  assert.equal(typeof h.body['heldAt'], 'number');
  assert.equal(notices.items.size, 1);
  const [nid, n] = [...notices.items][0]!;
  assert.equal(store.records.get(id)!.notice, nid);
  assert.equal(n['type'], 'locked');
  assert.equal(n['priority'], 'high');
  assert.equal(n['visibility'], 'private');
  assert.equal(n['publicTitle'], NOTICE_PUBLIC_TITLE);
  assert.deepEqual(n['context'], { kind: 'approval', id, label: 'Review' });
  assert.equal(n['components'], undefined, 'nothing in the notice can answer');
  assert.ok(audits.some((a) => a.action === 'approval.held'));
  callerPrincipal = TERMINAL;
  const mine = await read(await getApproval(ctx('GET', `/api/approvals/${id}`, undefined, { authorization: 'Bearer x' }), id, deps()));
  assert.equal(mine.body['state'], 'pending');
  assert.equal(typeof mine.body['heldAt'], 'number');
  // A second Later (another tab) does not push the deadline or make a second notice.
  assert.equal((await decide(id, 'hold')).status, 409);
  assert.equal(notices.items.size, 1);
});

test('Later on a forced request: 409 not-deferrable, no notice', async () => {
  callerPrincipal = OTHER;
  const created = await read(await createApproval(ctx('POST', '/api/approvals', { action: 'user.confirm', payload: { action: 'wipe' } }), deps()));
  const h = await decide(created.body['id'], 'hold');
  assert.equal(h.status, 409);
  assert.equal(h.body['error'], 'not-deferrable');
  assert.equal(notices.items.size, 0);
});

test('Later is the owner\'s, on the shell document and an unlocked tab only', async () => {
  const id = (await askOpen()).body['approvalId'];
  assert.equal((await decide(id, 'hold', {}, { ...desk, authorization: 'Bearer aura1.x' })).status, 403, 'a bearer');
  assert.equal((await decide(id, 'hold', {}, { ...desk, [GATEWAY_IDENTITY_HEADER]: 'x' })).status, 403, 'through an app');
  assert.equal((await decide(id, 'hold', {}, {})).status, 403, 'no unlocked tab');
  lock = 'locked';
  assert.equal((await decide(id, 'hold')).status, 403, 'a locked tab');
  lock = 'unlocked';
  assert.equal((await decide(id, 'hold', { operatorCode: 'x' })).status, 403, 'not the operator');
  assert.equal(store.records.get(id)!.heldAt, undefined);
});

test('re-running the same request resumes it: same id, no second notice, no second audit', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  const before = audits.length;
  const again = await askOpen();
  assert.equal(again.body['approvalId'], id);
  assert.equal(again.body['resumed'], true);
  assert.equal(typeof again.body['heldAt'], 'number');
  assert.equal(store.records.size, 1);
  assert.equal(notices.items.size, 1);
  assert.equal(audits.length, before);
});

// ── deciding a held request ─────────────────────────────────────────────────

test('approve from hold: the notice goes away (no outcome notice), single use, 10 minutes', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  store.now += 6 * 3600_000;
  const a = await decide(id, 'approve');
  assert.equal(a.status, 200);
  assert.equal(notices.items.size, 0, 'removed');
  assert.equal(notices.n, 1, 'no outcome notification');
  assert.ok(audits.some((x) => x.action === 'approval.approved' && (x.detail as Record<string, unknown>)['fromHold'] === true));
  // The re-run consumes it once.
  callerPrincipal = TERMINAL;
  const run = (h: Record<string, string>) => approvedOrAsk(deps(), TERMINAL as never, ctx('POST', '/x', undefined, h).request, {
    action: 'app.source.open', payload: { appId: 'notes', scope: 'user', mode: 'open' }, level: 'session',
    display: (by) => ({ title: 'Open', details: [], requestedBy: by }),
  });
  assert.equal(await run({ 'x-aura-approval': id }), null, 'used once');
  const second = await run({ 'x-aura-approval': id });
  assert.equal(second!.status, 202, 'a second use asks again');
  assert.notEqual((await second!.json() as { approvalId: string }).approvalId, id);
});

test('deny with feedback: the requester gets the owner\'s words; the notice goes', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  const d = await decide(id, 'deny', { feedback: '  Use the staging app instead.\u0000 ' });
  assert.equal(d.status, 200);
  assert.equal(notices.items.size, 0);
  callerPrincipal = TERMINAL;
  const mine = await read(await getApproval(ctx('GET', `/api/approvals/${id}`, undefined, { authorization: 'Bearer x' }), id, deps()));
  assert.equal(mine.body['state'], 'denied');
  assert.equal(mine.body['feedback'], 'Use the staging app instead.');
});

test('a notification answer is not an approval: only the approve endpoint decides', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  // Whatever happens to the notice (removed, cleared), the approval stays held and unusable.
  const [nid] = [...notices.items.keys()];
  await notices.remove(nid!);
  assert.equal((await store.get(id))!.state, 'pending');
  const used = await consumeApproval(deps(), TERMINAL as never, id, 'app.source.open', { appId: 'notes', scope: 'user', mode: 'open' });
  assert.deepEqual(used, { ok: false, reason: 'wrong-state' });
});

test('an expired held request cannot be approved; reconcile removes its notice', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  store.now += core.HOLD_TTL_MS;
  const a = await decide(id, 'approve');
  assert.equal(a.status, 410);
  assert.equal(await reconcileHoldNotices(deps()), 1);
  assert.equal(notices.items.size, 0);
});

test('the requester withdraws (cancel): only its own; the notice goes; outcome cancelled', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  callerPrincipal = OTHER;
  assert.equal((await decide(id, 'cancel', {}, { authorization: 'Bearer y' })).status, 404, 'someone else\'s id reads as unknown');
  callerPrincipal = TERMINAL;
  const c = await decide(id, 'cancel', {}, { authorization: 'Bearer x' });
  assert.equal(c.status, 200);
  assert.equal(c.body['state'], 'cancelled');
  assert.equal(notices.items.size, 0);
  assert.equal((await decide(id, 'approve')).status, 409);
  assert.equal(requesterView((await store.get(id))!).cancelledBy, 'requester');
});

// ── revalidation ────────────────────────────────────────────────────────────

test('revalidation before approve: a stopped requester instance cancels the request', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  running.delete('com.aura.terminal-3');
  const a = await decide(id, 'approve');
  assert.equal(a.status, 409);
  assert.equal(a.body['error'], 'stale');
  assert.equal((await store.get(id))!.state, 'cancelled');
  assert.equal(notices.items.size, 0);
  assert.ok(audits.some((x) => x.action === 'approval.cancelled'));
});

test('revalidation before use: an app blocked after the approval cannot use it', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'approve');
  store.blocked.add('com.aura.terminal');
  const used = await consumeApproval(deps(), TERMINAL as never, id, 'app.source.open', { appId: 'notes', scope: 'user', mode: 'open' });
  assert.deepEqual(used, { ok: false, reason: 'stale' });
  assert.equal((await store.get(id))!.state, 'cancelled');
});

test('revalidation is a no-op for a valid request; another requester\'s id is not cancelled by it', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'approve');
  store.blocked.add('com.aura.terminal');
  const used = await consumeApproval(deps(), OTHER as never, id, 'app.source.open', { appId: 'notes', scope: 'user', mode: 'open' });
  assert.deepEqual(used, { ok: false, reason: 'mismatch' });
  assert.equal((await store.get(id))!.state, 'approved', 'not cancelled by a stranger');
});

// ── credentials: the same mechanic, no secret in the notice ─────────────────

test('credential.store: deferrable; Later posts a notice without any secret; the secret only on approve', async () => {
  callerPrincipal = TERMINAL;
  const asked = await read(await requestCredential(ctx('POST', '/api/credentials/requests', {
    name: 'GITHUB_TOKEN', scope: { app: 'com.example.notes' }, label: 'GitHub token', purpose: 'push notes',
  }).request, deps()));
  assert.equal(asked.status, 201);
  assert.equal(asked.body['class'], 'deferrable');
  const id = asked.body['id'];
  // A secret sent with Later is ignored and never stored anywhere.
  const h = await decide(id, 'hold', { secret: 'CANARY-ghp-1234567890' });
  assert.equal(h.status, 200);
  const everything = JSON.stringify([...notices.items.values(), [...store.records.values()], audits, h.body]);
  assert.ok(!everything.includes('CANARY'), 'no secret in the notice, the record, the audit or the answer');
  assert.equal(stored.length, 0);
  const n = [...notices.items.values()][0]!;
  assert.match(String(n['title']), /GITHUB_TOKEN/);
  // Re-asking resumes the same request.
  const again = await read(await requestCredential(ctx('POST', '/api/credentials/requests', {
    name: 'GITHUB_TOKEN', scope: { app: 'com.example.notes' },
  }).request, deps()));
  assert.equal(again.body['id'], id);
  // Approve with the secret: it goes to the vault only; the notice goes.
  const a = await decide(id, 'approve', { secret: 'CANARY-ghp-1234567890' });
  assert.equal(a.status, 200);
  assert.deepEqual(stored, [{ name: 'GITHUB_TOKEN', value: 'CANARY-ghp-1234567890' }]);
  assert.equal(notices.items.size, 0);
  assert.ok(!JSON.stringify([[...store.records.values()], audits, a.body]).includes('CANARY'));
  const got = await read(await collectCredential(ctx('POST', `/api/credentials/requests/${id}`, { name: 'GITHUB_TOKEN', scope: { app: 'com.example.notes' } }).request, id, deps()));
  assert.equal(got.status, 200);
  assert.match(got.body['handle'], /^cred_/);
  assert.ok(!JSON.stringify(got.body).includes('CANARY'), 'a handle, never the value');
});

test('credential.store revalidation: the consuming app was removed', async () => {
  callerPrincipal = TERMINAL;
  const asked = await read(await requestCredential(ctx('POST', '/api/credentials/requests', {
    name: 'API_KEY', scope: { app: 'com.example.notes' },
  }).request, deps()));
  installed.delete('com.example.notes');
  const a = await decide(asked.body['id'], 'approve', { secret: 'x' });
  assert.equal(a.status, 409);
  assert.equal(stored.length, 0);
});

// ── the notice and the dialog's client side ────────────────────────────────

test('holdNoticeInput: server text only, the requester\'s words labelled, lifetime = the hold', () => {
  const r = { ...core.newApprovalRecord({
    requester: { kind: 'instance', appId: 'a', instanceId: 'a-1' }, action: 'credential.store', payloadHash: 'h'.repeat(64),
    display: { title: 'Store GITHUB_TOKEN for Notes', details: [], requestedBy: 'Terminal', reason: 'push' }, level: 'session', class: 'deferrable',
    payload: { name: 'GITHUB_TOKEN', for: 'notes' },
  }, 'apr_AAAAAAAAAAAAAAAAAAAAAA', 1000), heldAt: 2000, expiresAt: 1000 + core.HOLD_TTL_MS };
  const n = holdNoticeInput(r, 2000);
  assert.equal(n['timeoutMs'], core.HOLD_TTL_MS - 1000);
  assert.match(String(n['text']), /own words \(not verified\): push/);
  assert.ok(!JSON.stringify(n).includes('"payload"'));
});

test('Review: only on AuraOS\'s own approval notices, never on a locked screen; opens the dialog', async () => {
  const ctxA = { kind: 'approval' as const, id: 'apr_AAAAAAAAAAAAAAAAAAAAAA' };
  assert.deepEqual(contextTarget(ctxA, { senderKey: 'auraos' }), { actionable: true, label: APPROVAL_CONTEXT_LABEL, action: 'Review' });
  assert.equal(contextTarget(ctxA, { senderKey: 'app:com.evil' })!.actionable, false);
  assert.equal(contextTarget(ctxA, { senderKey: 'auraos', lockscreen: true })!.actionable, false);
  assert.equal(contextTarget(ctxA)!.actionable, false);
  const opened: string[] = [];
  const host = { auraOpenApproval: async (id: string) => { opened.push(id); return 'opened'; } };
  assert.equal(await goToContext(ctxA, host, { senderKey: 'auraos' }), 'opened');
  assert.equal(await goToContext(ctxA, host, { senderKey: 'app:com.evil' }), 'none');
  assert.deepEqual(opened, [ctxA.id]);
});

test('dialog client: class and hold parsed; cancelled outcome; feedback only on a denial', () => {
  const v = parseApprovalView({
    id: 'apr_AAAAAAAAAAAAAAAAAAAAAA', action: 'app.source.open', level: 'session', state: 'pending', expiresAt: 5,
    display: { title: 't', details: [], requestedBy: 'r' }, class: 'deferrable', heldAt: 3,
  });
  assert.equal(v!.class, 'deferrable');
  assert.equal(v!.heldAt, 3);
  assert.equal(parseApprovalView({ ...v, class: 'whatever' })!.class, 'forced');
  assert.equal(outcomeOf('cancelled'), 'cancelled');
  assert.deepEqual(approvalReply('approval', 'r1', 'apr_x', 'denied', 'nope'), { type: 'aura.approval.result', requestId: 'r1', approvalId: 'apr_x', ok: false, error: 'denied', feedback: 'nope' });
  assert.deepEqual(approvalReply('confirm', 'r1', 'apr_x', 'expired', 'ignored'), { type: 'aura.user.confirm.result', requestId: 'r1', confirmed: false });
  assert.equal(decisionErrorText('not-deferrable', 'x'), 'This request must be decided now.');
});

test('the owner\'s list shows held requests with their class', async () => {
  const id = (await askOpen()).body['approvalId'];
  await decide(id, 'hold');
  const l = await read(await listApprovals(ctx('GET', '/api/approvals'), deps()));
  assert.equal(l.body['pending'][0].id, id);
  assert.equal(typeof l.body['pending'][0].heldAt, 'number');
  assert.equal(l.body['pending'][0].class, 'deferrable');
});
