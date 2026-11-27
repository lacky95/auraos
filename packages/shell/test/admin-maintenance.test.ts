// 5-main P2: the admin maintenance routes that took no approval (SF-2 report) are the owner's
// (lib/approvals/maintenance.ts): the owner in the desktop and the host operator act directly,
// the System Terminal gets 202 needs-approval (one click) and acts once with it. Plus the
// philosophy audit fix: `keepRunningOnBuild` in the manifest instead of app ids in shell code.
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult } from '@aura/core';
import { ownerAction, type AdminRequest, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import {
  capDoctorFixRequest, capRefreshRequest, installAuraShimRequest, reapOrphansRequest,
} from '../src/lib/approvals/maintenance.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { effectiveRule } from '../src/lib/access/resolve.ts';
import { keepsRunning } from '../src/lib/appBuilds.ts';
import { POST as capDoctorPost } from '../src/pages/api/admin/cap-doctor.ts';
import { POST as capRefreshPost } from '../src/pages/api/admin/cap-refresh.ts';
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
const DECIDER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: false };

let store: MemoryStore;
let caller: CallerPrincipal;

function deps(): OwnerActionDeps {
  return {
    approvals: {
      store: store as never,
      appName: (id) => (id === 'com.aura.terminal' ? 'Terminal' : null),
      audit: async () => undefined,
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => ({ identity: {} }),
  };
}

beforeEach(() => {
  store = new MemoryStore();
  caller = TERMINAL;
});

const ctx = (headers: Record<string, string> = {}) => ({
  request: new Request('http://shell.test/api/admin/x', { method: 'POST', headers }),
  cookies: {} as never,
});

function built<T extends object>(r: T | { invalid: string }): T {
  assert.ok(!('invalid' in r), `expected a request, got ${JSON.stringify(r)}`);
  return r as T;
}

const ROUTES: Array<{ route: string; req: AdminRequest; other: AdminRequest; action: string }> = [
  {
    route: '/api/admin/cap-doctor',
    req: built(capDoctorFixRequest({ names: ['git', 'adb', 'git'] })).req,
    other: built(capDoctorFixRequest({ names: ['git'] })).req,
    action: 'admin.change',
  },
  {
    route: '/api/admin/cap-refresh',
    req: built(capRefreshRequest({ appId: 'io.lakner.terminalx' })).req,
    other: built(capRefreshRequest({ appId: 'com.acme.notes' })).req,
    action: 'admin.change',
  },
  { route: '/api/admin/reap-orphans', req: reapOrphansRequest(false), other: reapOrphansRequest(true), action: 'admin.change' },
  {
    route: '/api/admin/install-aura-shim',
    req: installAuraShimRequest(['/os/toolchain/bin/aura', '/usr/local/bin/aura']),
    other: { ...reapOrphansRequest(false) },
    action: 'admin.change',
  },
];

for (const r of ROUTES) {
  test(`${r.route}: the System Terminal asks (202, one click), then acts once as the approving owner`, async () => {
    const first = await ownerAction(ctx(), r.req, deps());
    assert.ok(first instanceof Response);
    assert.equal(first.status, 202);
    const body = await first.json() as Record<string, any>;
    assert.equal(body.error, 'needs-approval');
    assert.equal(body.action, r.action);
    assert.equal(body.level, 'session');
    assert.equal(body.display.title, r.req.title);
    const id = body.approvalId as string;

    // Approved for this exact request only.
    assert.equal((await store.approve(id, DECIDER)).ok, true);
    const mismatch = await ownerAction(ctx({ 'x-aura-approval': id }), r.other, deps());
    assert.ok(mismatch instanceof Response);
    assert.equal((await mismatch.json() as { refused?: string }).refused, 'mismatch');

    const done = await ownerAction(ctx({ 'x-aura-approval': id }), r.req, deps());
    assert.ok(!(done instanceof Response));
    assert.deepEqual(done.by, { kind: 'user', userId: 'default', session: 'sess-des' });
    assert.equal(done.detail['approval'], id);

    const again = await ownerAction(ctx({ 'x-aura-approval': id }), r.req, deps());
    assert.ok(again instanceof Response && again.status === 202, 'used up');
  });

  test(`${r.route}: the owner in the desktop and the host operator act directly; nobody is asked`, async () => {
    caller = OWNER;
    assert.ok(!((await ownerAction(ctx({ authorization: 'Bearer aura-sess1.x' }), r.req, deps())) instanceof Response));
    caller = OPERATOR;
    assert.deepEqual(await ownerAction(ctx(), r.req, deps()), { by: { kind: 'operator' }, detail: {} });
    assert.equal(store.records.size, 0);
  });

  test(`${r.route}: route manifest: the owner's management rule (only the System Terminal asks), never public`, () => {
    const rule = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: r.route, handlers: ['POST'] }, 'POST');
    assert.deepEqual(rule?.allow, ['own-instance', 'owner']);
    assert.equal(rule?.systemApp, TERMINAL_APP_ID);
  });
}

test('requests bind the validated input: cap-doctor names sorted and deduplicated; reap-orphans dry run is a read', () => {
  const fix = built(capDoctorFixRequest({ names: ['git', 'adb', 'git'] }));
  assert.deepEqual(fix.req.payload, { op: 'cap.doctor-fix', names: ['adb', 'git'], refreshOnly: false });
  assert.deepEqual(built(capDoctorFixRequest(undefined)).req.payload, { op: 'cap.doctor-fix', names: [], refreshOnly: false });
  assert.deepEqual(built(capDoctorFixRequest({ refreshOnly: true })).req.payload, { op: 'cap.doctor-fix', names: [], refreshOnly: true });
  assert.ok('invalid' in capDoctorFixRequest({ names: ['git; id'] }));
  assert.ok('invalid' in capDoctorFixRequest({ names: 'git' }));
  assert.ok('invalid' in capDoctorFixRequest({ refreshOnly: 'yes' }));
  assert.ok('invalid' in capRefreshRequest({}));
  assert.ok('invalid' in capRefreshRequest({ appId: '../x' }));
  assert.deepEqual(capRefreshRequest({ appId: 'dev.box' }), {
    appId: 'dev.box',
    req: {
      action: 'admin.change', level: 'session', payload: { op: 'cap.refresh', appId: 'dev.box' },
      title: 'Refresh the tools of the running instances of dev.box',
      details: ['Re-applies the tools the app already has; grants nothing new.'],
    },
  });
  assert.equal(reapOrphansRequest(true).action, 'admin.read');
  assert.equal(reapOrphansRequest(false).action, 'admin.change');
  assert.ok([reapOrphansRequest(true), reapOrphansRequest(false), installAuraShimRequest([])].every((q) => q.level === 'session'));
});

test('cap-doctor GET (the read-only report) stays a direct owner read', () => {
  const rule = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/admin/cap-doctor', handlers: ['GET', 'POST'] }, 'GET');
  assert.deepEqual(rule?.allow, ['owner']);
});

// ── the handlers: the gate runs before any change ──────────────────────────

const G = globalThis as unknown as Record<string, unknown>;
const MANAGER = '__aura_app_manager__';
const AUTH_SERVICES = '__auraAuthServices';

async function withGlobals(values: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, G[k]]));
  Object.assign(G, values);
  try { await run(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete G[k]; else G[k] = v; }
  }
}

test('cap-refresh refuses a caller without credentials (401) and changes nothing; cap-doctor refuses a bad body first', async () => {
  const touched: string[] = [];
  const mgr = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { touched.push(String(name)); void args; return []; } });
  const auth = { version: Number.MAX_SAFE_INTEGER, apiKeys: { verify: async () => null }, audit: { record: async () => undefined } };
  await withGlobals({ [MANAGER]: mgr, [AUTH_SERVICES]: auth }, async () => {
    const post = (path: string, body?: unknown) => {
      const url = new URL(`http://shell.test${path}`);
      return { url, request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }), cookies: {} } as never;
    };
    // Only the handler whose change goes through the (stub) manager runs here: the others act on
    // this host (toolchain, rootfs, processes), and the order test below covers them.
    assert.equal((await capRefreshPost(post('/api/admin/cap-refresh', { appId: 'dev.box' })) as Response).status, 401);
    // An invalid body is refused before anyone is asked.
    assert.equal((await capDoctorPost(post('/api/admin/cap-doctor', { names: ['$(id)'] })) as Response).status, 400);
  });
  assert.deepEqual(touched.filter((n) => /refresh|applyInstanceTools|stage|getAllInstances|syncToolchainMirror/.test(n)), [], 'no manager change ran');
});

test('each route calls ownerAction before its first change', () => {
  const dir = new URL('../src/pages/api/admin/', import.meta.url);
  const firstChange: Record<string, RegExp> = {
    'cap-doctor.ts': /stageLibs\(list|syncToolchainMirror\(/,
    'cap-refresh.ts': /applyInstanceTools\(/,
    'reap-orphans.ts': /process\.kill\(s\.pid|getAllInstances\(/,
    'install-aura-shim.ts': /unlinkSync\(|writeFileSync\(path/,
  };
  for (const [f, re] of Object.entries(firstChange)) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const post = src.indexOf('export const POST');
    const gate = src.indexOf('ownerAction(', post);
    const change = src.slice(post).search(re) + post;
    assert.ok(post >= 0 && gate > post, `${f}: POST calls ownerAction`);
    assert.ok(change > gate, `${f}: ownerAction comes before the first change`);
    assert.match(src, /auditOwner\(actor, '/, `${f}: audited`);
  }
});

// ── philosophy audit: no app id of a customer app in the shell ─────────────

test('keepRunningOnBuild: a manifest flag (default false), the System Terminal declares it; appBuilds reads it', async () => {
  const base = { id: 'com.acme.notes', name: 'Notes', version: '0.1.0', auraContract: 1 };
  const parsed = core.AppManifestSchema.safeParse(base);
  assert.ok(parsed.success);
  assert.equal(parsed.data.keepRunningOnBuild, false);
  assert.equal(core.AppManifestSchema.parse({ ...base, keepRunningOnBuild: true }).keepRunningOnBuild, true);
  const terminal = JSON.parse(readFileSync(new URL('../../../apps/com.aura.terminal/app.manifest.json', import.meta.url), 'utf8'));
  assert.equal(terminal.keepRunningOnBuild, true);
  const manifests: Record<string, { keepRunningOnBuild?: boolean }> = {
    'com.aura.terminal': { keepRunningOnBuild: true }, 'com.acme.notes': { keepRunningOnBuild: false }, 'com.acme.old': {},
  };
  await withGlobals({ [MANAGER]: { getManifest: (id: string) => manifests[id] } }, async () => {
    assert.equal(keepsRunning('com.aura.terminal'), true);
    assert.equal(keepsRunning('com.acme.notes'), false);
    assert.equal(keepsRunning('com.acme.old'), false);
    assert.equal(keepsRunning('com.acme.missing'), false);
  });
});

test('no customer app id in shell code (at.oebb.*)', () => {
  const root = new URL('..', import.meta.url).pathname;
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'dist' || n === '.astro' || n === 'test') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs|js|astro)$/.test(n) && /at\.oebb\./.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'server'));
  assert.deepEqual(hits, []);
});
