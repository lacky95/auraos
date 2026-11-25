// Credentials (D56): asked for through the shell's dialog, kept in the
// user's vault, handed out as handles; the raw value only on the owner's
// separate, audited, revocable grant. Against an in-memory approval store
// that applies core's own transitions, core's real CredentialVault over an
// in-memory KV, and an in-memory GrantStore.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as core from '@aura/core';
import type {
  ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, AuditInput, GrantScope, GrantSubject, Principal,
} from '@aura/core';
import { createApproval, decideApproval, getApproval, listApprovals, type ApprovalRouteDeps, type RouteCtx } from '../src/lib/approvals/routes.ts';
import {
  collectCredential, listCredentials, readCredential, requestCredential, revokeCredential, storeApprovedCredential,
  type CredentialDeps,
} from '../src/lib/credentials.ts';
import { readContext } from '../src/lib/appContract.ts';
import { approvalBelongsToSender, authorizeShellMessage, type ChannelSender } from '../src/lib/auraChannelShell.ts';
import { parseApprovalView } from '../src/lib/approvals/dialogClient.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import type { ResolvedPrincipal } from '../src/lib/access/identify.ts';

// ── fakes ───────────────────────────────────────────────────────────────────

class MemoryStore {
  records = new Map<string, ApprovalRecord>();
  now = 1_800_000_000_000;
  async create(request: ApprovalRequest): Promise<ApprovalResult> {
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
  async isBlocked() { return false; }
  async block() { /* unused */ }
  async unblock() { return false; }
  async listBlocked() { return []; }
}

/** KvClient stand-in. Keeps exactly what the vault writes, so a test can scan it. */
function memoryKv() {
  const m = new Map<string, { value: unknown; updatedAt: number }>();
  return {
    m,
    kv: () => ({
      async get(ns: string, key: string) { return m.get(`${ns}\u0000${key}`) ?? null; },
      async set(ns: string, key: string, value: unknown) { const e = { value: JSON.parse(JSON.stringify(value)), updatedAt: 1 }; m.set(`${ns}\u0000${key}`, e); return e; },
      async del(ns: string, key: string) { return m.delete(`${ns}\u0000${key}`); },
      async list(ns: string) { return [...m.keys()].filter((k) => k.startsWith(`${ns}\u0000`)).map((k) => k.slice(ns.length + 1)); },
    }),
  };
}

const scopeKey = (s: GrantScope) => (s.kind === 'os' ? 'os' : `${s.kind}:${s.id}`);
class MemoryGrants {
  m = new Map<string, Record<string, unknown>>();
  key = (s: GrantSubject, p: string, sc: GrantScope) => `${s.kind}:${s.id}|${scopeKey(sc)}|${p}`;
  async get(s: GrantSubject, p: string, sc: GrantScope) { return this.m.get(this.key(s, p, sc)) ?? null; }
  async grant(s: GrantSubject, p: string, o: { by: unknown; appScope?: string; scope: GrantScope }) {
    // The real GrantStore's own validation: an app's credential.read for one user only.
    assert.ok(core.CREDENTIAL_READ_PERMISSION_RE.test(p));
    assert.equal(o.scope.kind, 'user');
    const record = { subject: s, permission: p, scope: o.scope, appScope: o.appScope, grantedBy: o.by };
    this.m.set(this.key(s, p, o.scope), record);
    return { record, changed: true };
  }
  async revoke(s: GrantSubject, p: string, sc: GrantScope) { const r = this.m.get(this.key(s, p, sc)) ?? null; this.m.delete(this.key(s, p, sc)); return r; }
}

const NOTES: Principal = { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', userId: 'default', verification: 'verified' };
const NOTES_OTHER_USER: Principal = { ...NOTES, instanceId: 'com.example.notes-2', userId: 'bob' } as Principal;
const TERMINAL: Principal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', userId: 'default', verification: 'verified' };
const SPY: Principal = { kind: 'instance', appId: 'com.example.spy', instanceId: 'com.example.spy-1', userId: 'default', verification: 'verified' };
const SETTINGS_OWNER: Principal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's-set', verification: 'verified', through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as Principal;
const PASSWORD = 'correct horse battery';
const SECRET = `ghp_${randomBytes(18).toString('hex')}`;

let store: MemoryStore;
let audits: AuditInput[];
let grants: MemoryGrants;
let kv: ReturnType<typeof memoryKv>;
let vault: core.CredentialVault;
let caller: Principal;
let via: string;
let responses: string[];

function deps(): CredentialDeps & ApprovalRouteDeps {
  const d: CredentialDeps & ApprovalRouteDeps = {
    store,
    appName: (id) => ({ 'com.aura.terminal': 'Terminal', 'com.example.notes': 'Notes', 'com.example.spy': 'Spy', 'com.aura.settings': 'Settings' } as Record<string, string>)[id] ?? null,
    audit: async (e) => { audits.push(JSON.parse(JSON.stringify(e))); },
    tickets: {
      peek: async () => ({ subject: 'x' } as never),
      claim: async (code: string) => (code === 'op-code' ? { subject: 'approve:' + [...store.records.keys()][0] } as never : null),
    },
    authenticate: async () => caller as never,
    resolve: async () => ({ principal: caller, via } as unknown as ResolvedPrincipal),
    shellOwner: async () => ({ owner: { userId: 'default', sessionId: 'sess-desk', username: 'owner' }, scheme: 'https' }),
    ownerRead: async () => ({ userId: 'default', sessionId: 'sess-desk', username: 'owner' }),
    lockOf: async () => 'unlocked',
    verifyPassword: async (_u, p) => (p === PASSWORD ? 'ok' : 'invalid'),
    rateKey: () => 'ip:10.0.0.1',
    vault,
    grants,
    appScope: () => 'user',
    storeCredential: (userId, ask, value, record) => storeApprovedCredential(d, userId, ask, value, record),
  };
  return d;
}

beforeEach(() => {
  store = new MemoryStore();
  audits = [];
  grants = new MemoryGrants();
  kv = memoryKv();
  vault = new core.CredentialVault({ kv: kv.kv as never, key: randomBytes(32), now: () => store.now });
  caller = NOTES;
  via = 'instance-token';
  responses = [];
});

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`http://shell.test${path}`, {
  method,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const ctx = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): RouteCtx => ({ request: req(method, path, body, headers) });
const read = async (r: Response) => {
  const text = await r.text();
  responses.push(text);
  return { status: r.status, body: JSON.parse(text) as Record<string, any> };
};
const desk = { 'x-aura-client-session': 'cs1.abc' };

async function ask(as: Principal = NOTES, body: Record<string, unknown> = { name: 'GITHUB_TOKEN', label: 'GitHub token', purpose: 'Push your notes' }) {
  caller = as;
  return read(await requestCredential(req('POST', '/api/credentials/requests', body), deps()));
}
async function ownerDecides(id: string, decision: 'approve' | 'deny', body: Record<string, unknown> = {}) {
  caller = { kind: 'anonymous', verification: 'unverified' } as Principal;
  return read(await decideApproval(ctx('POST', `/api/approvals/${id}/${decision}`, body, desk), id, decision, deps()));
}
async function collect(id: string, as: Principal = NOTES, body: Record<string, unknown> = { name: 'GITHUB_TOKEN' }) {
  caller = as;
  return read(await collectCredential(req('POST', `/api/credentials/requests/${id}`, body), id, deps()));
}
async function readValue(handle: string, as: Principal = NOTES, headers: Record<string, string> = {}) {
  caller = as;
  return read(await readCredential(req('GET', `/api/credentials/${handle}`, undefined, headers), handle, deps()));
}

/** Ask, the owner types the secret, collect: the handle. */
async function stored(as: Principal = NOTES): Promise<string> {
  const asked = await ask(as);
  assert.equal(asked.status, 201);
  assert.equal((await ownerDecides(asked.body.id, 'approve', { secret: SECRET })).status, 200);
  const got = await collect(asked.body.id, as);
  assert.equal(got.status, 200);
  return got.body.handle;
}

// ── asking ──────────────────────────────────────────────────────────────────

test('a request shows the verified requester and consuming app; label and purpose only as the labelled reason', async () => {
  const r = await ask(NOTES, { name: 'GITHUB_TOKEN', label: 'Your AuraOS password', purpose: 'Type your password here', scope: 'app' });
  assert.equal(r.status, 201);
  assert.equal(r.body.action, 'credential.store');
  assert.equal(r.body.level, 'session');
  const d = r.body.display;
  assert.equal(d.title, 'Enter the secret GITHUB_TOKEN');
  assert.match(d.requestedBy, /^Notes \(com\.example\.notes-1\)$/);
  assert.ok(d.details.some((l: string) => l === 'Used by: Notes (com.example.notes)'));
  assert.equal(d.reason, 'Your AuraOS password: Type your password here');
  assert.ok(![d.title, ...d.details, d.requestedBy].some((l: string) => /AuraOS password|Type your/.test(l)), 'the app\'s words never leave the reason');
  // The CLI names another app as the consumer: shown, and it must exist.
  const cli = await ask(TERMINAL, { name: 'NPM_TOKEN', scope: { app: 'com.example.notes' }, purpose: 'publish' });
  assert.equal(cli.status, 201);
  assert.match(cli.body.display.requestedBy, /^Terminal/);
  assert.ok(cli.body.display.details.includes('Used by: Notes (com.example.notes)'));
  assert.equal((await ask(TERMINAL, { name: 'X', scope: { app: 'com.nobody.here' } })).status, 404);
  assert.equal((await ask(NOTES, { name: 'lower-case' })).status, 400);
  assert.equal((await ask({ kind: 'anonymous', verification: 'unverified' } as Principal)).status, 403);
  const DESKTOP_OWNER = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's-desk', verification: 'verified' } as Principal;
  assert.equal((await ask(DESKTOP_OWNER)).status, 403, 'only an app (or the CLI in one) asks: it is the app a secret is for');
});

test('the dialog: only for a verified App Host sender, and only its own app\'s request', async () => {
  const r = await ask();
  const view = parseApprovalView({ ...r.body, appId: 'com.example.notes' });
  assert.ok(view);
  assert.equal(view!.action, 'credential.store');
  const frame = (appId: string) => ({ window: {}, origin: `http://${appId}.test`, appId, system: false, element: {} });
  const sender = (appId: string, direct = true): ChannelSender<unknown> => ({ endpoint: 'app', frame: frame(appId), direct });
  assert.equal(authorizeShellMessage('aura.approval.request', sender('com.example.notes'), {}, { nativeRuntime: false }), true);
  assert.equal(authorizeShellMessage('aura.approval.request', sender('com.example.notes', false), {}, { nativeRuntime: false }), false, 'a nested frame');
  assert.equal(authorizeShellMessage('aura.approval.request', { endpoint: 'embedded-app', frame: frame('com.host'), direct: false }, {}, { nativeRuntime: false }), false);
  assert.equal(approvalBelongsToSender(sender('com.example.notes'), view!.appId), true);
  assert.equal(approvalBelongsToSender(sender('com.example.spy'), view!.appId), false, 'another app cannot raise it');
  // The desktop's own list shows it; the payload (name, consumer) stays server-side.
  caller = { kind: 'anonymous', verification: 'unverified' } as Principal;
  const list = await read(await listApprovals(ctx('GET', '/api/approvals'), deps()));
  assert.equal(list.body.pending[0].appId, 'com.example.notes');
  assert.equal(list.body.pending[0].payload, undefined);
});

test('the secret is typed only in the dialog: approve needs it, the operator cannot type it', async () => {
  const r = await ask();
  assert.equal((await ownerDecides(r.body.id, 'approve', {})).body.error, 'secret-required');
  assert.equal((await ownerDecides(r.body.id, 'approve', { secret: 'x'.repeat(core.MAX_CREDENTIAL_BYTES + 1) })).status, 413);
  caller = { kind: 'anonymous', verification: 'unverified' } as Principal;
  const op = await read(await decideApproval(ctx('POST', `/api/approvals/${r.body.id}/approve`, { operatorCode: 'op-code' }), r.body.id, 'approve', deps()));
  assert.equal(op.body.error, 'dialog-required');
  assert.equal((await store.get(r.body.id))!.state, 'pending');
  // Not as a bearer or through an app.
  const viaApp = await read(await decideApproval(ctx('POST', `/api/approvals/${r.body.id}/approve`, { secret: SECRET }, { ...desk, authorization: 'Bearer aura1.x' }), r.body.id, 'approve', deps()));
  assert.equal(viaApp.status, 403);
  assert.deepEqual(await vault.list('default'), []);
});

test('handle by default: the requester gets {handle, name}, never the value; nothing leaks to replies, logs, audit or storage', async () => {
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  let handle: string;
  try {
    const asked = await ask();
    // Polling it as the requester shows the state only.
    caller = NOTES;
    const polled = await read(await getApproval(ctx('GET', `/api/approvals/${asked.body.id}`, undefined, { authorization: 'Bearer aura1.x' }), asked.body.id, deps()));
    assert.equal(polled.body.state, 'pending');
    const decided = await ownerDecides(asked.body.id, 'approve', { secret: SECRET });
    assert.deepEqual(decided.body, { ok: true, state: 'approved' });
    const got = await collect(asked.body.id);
    assert.deepEqual(Object.keys(got.body).sort(), ['handle', 'name']);
    assert.match(got.body.handle, core.CREDENTIAL_HANDLE_RE);
    handle = got.body.handle;
    assert.equal((await collect(asked.body.id)).status, 409, 'single use');
    // Without the read grant: a fresh approval request, no value.
    const first = await readValue(handle);
    assert.equal(first.status, 202);
    assert.equal(first.body.level, 'fresh');
    assert.equal(first.body.action, 'credential.read');
    // The owner's list: names and use, no value, no handle.
    const rows = await listCredentials(deps(), 'default');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.consumers[0]!.appId, 'com.example.notes');
    assert.equal(rows[0]!.consumers[0]!.canRead, false);
    responses.push(JSON.stringify(rows));
  } finally {
    Object.assign(console, orig);
  }
  const haystacks = [
    ...responses.map((t, i) => [`response ${i}`, t] as const),
    ...audits.map((a, i) => [`audit ${i}`, JSON.stringify(a)] as const),
    ...[...store.records.values()].map((r) => [`approval ${r.id}`, JSON.stringify(r)] as const),
    ...[...kv.m.entries()].map(([k, v]) => [`kv ${k}`, JSON.stringify(v)] as const),
    ['logs', logged.join('\n')] as const,
  ];
  for (const [where, text] of haystacks) assert.ok(!text.includes(SECRET), `the value leaked into ${where}`);
  // The handle goes to its requester only: not into the audit trail or a log.
  for (const [where, text] of haystacks.filter(([w]) => w.startsWith('audit') || w === 'logs')) assert.ok(!text.includes(handle!), `handle in ${where}`);
  assert.ok(audits.some((a) => a.action === 'vault.stored'), 'the store is audited');
});

test('a raw read is refused without the grant, allowed with it, and audited; another app or a page gets nothing', async () => {
  const handle = await stored();
  const asked = await readValue(handle);
  assert.equal(asked.status, 202);
  const id = asked.body.approvalId as string;
  // Presenting it before the owner decides changes nothing.
  assert.equal((await readValue(handle, NOTES, { 'x-aura-approval': id })).status, 202);
  const id2 = [...store.records.values()].filter((r) => r.action === 'credential.read' && r.state === 'pending').at(-1)!.id;
  // A fresh approval: the password is required.
  assert.equal((await ownerDecides(id2, 'approve', {})).body.error, 'password-required');
  assert.equal((await ownerDecides(id2, 'approve', { password: PASSWORD })).status, 200);
  const ok = await readValue(handle, NOTES, { 'x-aura-approval': id2 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { name: 'GITHUB_TOKEN', value: SECRET });
  assert.ok(audits.some((a) => a.action === 'vault.read-granted' && (a.detail as any)?.app === 'com.example.notes'));
  // The grant holds: later reads need no approval, and each is audited.
  const again = await readValue(handle);
  assert.equal(again.body.value, SECRET);
  const reads = audits.filter((a) => a.action === 'vault.read');
  assert.equal(reads.length, 2);
  assert.ok(!JSON.stringify(reads).includes(SECRET));
  const rows = await listCredentials(deps(), 'default');
  assert.equal(rows[0]!.consumers[0]!.canRead, true);
  assert.equal(rows[0]!.lastUsedBy, 'com.example.notes');
  // context.get reads the granted credential too.
  const ctxRead = await readContext(req('GET', '/api/os/context/GITHUB_TOKEN'), 'GITHUB_TOKEN', {
    resolve: async () => ({ principal: NOTES, via: 'instance-token' } as unknown as ResolvedPrincipal),
    declared: () => [], read: async () => null, signal: () => undefined,
    vault: async (p, key) => (await import('../src/lib/credentials.ts')).contextVaultRead(deps(), p, key),
  });
  assert.equal((await ctxRead.json() as { value: string }).value, SECRET);

  // Another app with the handle: unknown. A page through the gateway: server-only.
  assert.equal((await readValue(handle, SPY)).status, 404);
  via = 'gateway';
  assert.equal((await readValue(handle, NOTES)).body.error, 'server-only');
  via = 'instance-token';
  // An app without the grant gets nothing from context.get either.
  const spyCtx = await readContext(req('GET', '/api/os/context/GITHUB_TOKEN'), 'GITHUB_TOKEN', {
    resolve: async () => ({ principal: SPY, via: 'instance-token' } as unknown as ResolvedPrincipal),
    declared: () => [], read: async () => null, signal: () => undefined,
    vault: async (p, key) => (await import('../src/lib/credentials.ts')).contextVaultRead(deps(), p, key),
  });
  assert.equal(spyCtx.status, 403);
});

test('revoke: one app\'s access, then the whole secret; handles and grants stop working', async () => {
  const handle = await stored();
  // Grant the read.
  const asked = await readValue(handle);
  await ownerDecides(asked.body.approvalId, 'approve', { password: PASSWORD });
  assert.equal((await readValue(handle, NOTES, { 'x-aura-approval': asked.body.approvalId })).status, 200);
  const by = core.userAttribution({ userId: 'default' });
  assert.equal(await revokeCredential(deps(), 'default', 'GITHUB_TOKEN', 'com.example.notes', by, {}), true);
  assert.equal((await readValue(handle)).status, 404, 'the handle is gone');
  assert.equal(grants.m.size, 0, 'the read grant is gone');
  assert.equal((await vault.list('default')).length, 1, 'the secret stays');
  assert.equal(await revokeCredential(deps(), 'default', 'GITHUB_TOKEN', null, by, {}), true);
  assert.deepEqual(await vault.list('default'), []);
  const revoked = audits.filter((a) => a.action === 'vault.revoked');
  assert.equal(revoked.length, 2);
  assert.ok(!JSON.stringify(audits).includes(SECRET));
});

test('per-user isolation: another user\'s handle is unknown, and a request for another user cannot be stored', async () => {
  const handle = await stored();
  assert.equal((await readValue(handle, NOTES_OTHER_USER)).status, 404);
  assert.deepEqual(await vault.list('bob'), []);
  assert.equal(await vault.resolve('bob', handle), null);
  // Bob's app asks; the signed-in owner (default) cannot type it into Bob's vault.
  const asked = await ask(NOTES_OTHER_USER);
  assert.equal((await ownerDecides(asked.body.id, 'approve', { secret: SECRET })).body.error, 'other-user');
  // An instance acting for no user has no vault.
  const nobody: Principal = { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-3', verification: 'verified' };
  assert.equal((await readValue(handle, nobody)).body.error, 'no-user');
});

test('route manifest: asking needs credentials.request; reading is the instance token only; the owner\'s list and revoke are owner-managed', () => {
  const r = ROUTE_ACCESS_MANIFEST.routes;
  assert.deepEqual(r['/api/credentials/requests']?.methods?.POST?.permissions, ['credentials.request']);
  assert.deepEqual(r['/api/credentials/[handle]']?.methods?.GET?.credentials, ['instance-token']);
  assert.deepEqual(r['/api/credentials/[handle]']?.methods?.GET?.allow, ['own-instance']);
  assert.equal(r['/api/admin/credentials']?.methods?.GET?.systemApp, 'com.aura.terminal');
  assert.equal(r['/api/admin/credentials/[name]']?.methods?.DELETE?.systemApp, 'com.aura.terminal');
});

test('the user.confirm route still refuses credential approvals (they come from their own route)', async () => {
  caller = NOTES;
  const r = await read(await createApproval(ctx('POST', '/api/approvals', { action: 'credential.store', payload: { name: 'X', for: 'com.example.notes' } }), deps()));
  assert.equal(r.body.error, 'use-the-action-route');
});
