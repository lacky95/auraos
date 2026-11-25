// Track P, the shell side of app patching (lib/appSource.ts): where an agent
// finds an app's source, the patch workspace bound into the calling Terminal,
// opening an app (owner approval), and activating a prepared tree through the
// Nexus install pipeline (owner approval, swap, rollback tree, overlay).
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, AuraMount } from '@aura/core';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import {
  activatePrepared, appSourceStatus, bindWorkspace, cleanWorkspaces, detachWorkspace, setSourceMode, type AppSourceDeps, type ScopedApp,
} from '../src/lib/appSource.ts';

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

const TERMINAL: CallerPrincipal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal', userId: 'default', verification: 'verified' };
const OTHER: CallerPrincipal = { kind: 'instance', appId: 'io.lakner.terminalx', instanceId: 'io.lakner.terminalx', userId: 'default', verification: 'verified' };
const DECIDER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: false };
const O1 = '00000000-0000-4000-8000-000000000001';
const O2 = '00000000-0000-4000-8000-000000000002';

let store: MemoryStore;
let caller: CallerPrincipal;
let root: string;
let scopes: core.ScopeDefinition[];
let nexus: core.NexusManager;
let kernel: AuraMount[];
let audits: unknown[];
/** User-scope copies an approved activation linked to their system app (core lifecycle `trustedOverlay`). */
let overlays: Set<string>;

const put = (p: string, text: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const writeApp = (dir: string, m: Record<string, unknown>, body = 'v1\n') => {
  put(join(dir, 'app.manifest.json'), JSON.stringify(m));
  put(join(dir, 'src', 'index.astro'), body);
};
const scopeDir = (id: string) => scopes.find((s) => s.id === id)!;

function apps(): ScopedApp[] {
  // The active copy of each id: user over global over system.
  const out = new Map<string, ScopedApp>();
  for (const s of [...scopes].sort((a, b) => a.priority - b.priority)) {
    for (const id of ['io.shop.app', 'com.aura.terminal', 'io.lakner.terminalx', 'io.local.app']) {
      const dir = join(s.appsDir, id);
      if (!existsSync(join(dir, 'app.manifest.json'))) continue;
      out.set(id, { ...core.validateStagedDir(dir), scopeId: s.id, appDir: dir } as ScopedApp);
    }
  }
  return [...out.values()];
}

function deps(): AppSourceDeps {
  const approvals = {
    store: store as never,
    appName: (id: string) => (id === 'com.aura.terminal' ? 'Terminal' : null),
    audit: async (e: unknown) => { audits.push(e); },
    tickets: { peek: async () => null, claim: async () => null },
  };
  return {
    authenticate: async () => caller,
    approvals,
    owner: { approvals, authenticate: async () => caller, shellOwner: async () => ({ identity: {} }) },
    dataDir: join(root, 'root'),
    apps: {
      all: apps,
      get: (id) => apps().find((a) => a.id === id),
      scopes: () => scopes,
      sourceMode: (id) => {
        const a = apps().find((x) => x.id === id);
        return a ? core.effectiveSourceMode(scopeDir(a.scopeId), a) : null;
      },
      instance: (id) => (id.startsWith('com.aura.terminal') || id.startsWith('io.lakner.terminalx')
        ? { appId: id.replace(/-\d+$/, ''), sandbox: 'container' } : id === 'io.proot.app' ? { appId: id, sandbox: 'proot' } : undefined),
      instancesOf: (appId) => (appId === 'io.shop.app' ? ['io.shop.app'] : []),
      trustedSystemCopy: (appId) => {
        const a = apps().find((x) => x.id === appId);
        return !!a && (a.scopeId === 'system' || (a.scopeId === 'user' && overlays.has(appId)));
      },
    },
    mounts: {
      capable: () => ({ ok: true }),
      list: (inst) => kernel.filter((m) => m.instanceId === inst),
      add: async (inst, spec) => {
        const kind = spec.workspace ? 'work' : 'source';
        const id = kind === 'work' ? `${spec.targetAppId}:work` : spec.targetAppId;
        if (kernel.some((m) => m.instanceId === inst && m.id === id)) throw new Error(`${id} is already mounted into ${inst}`);
        if (kind === 'source' && spec.mode === 'rw' && deps().apps.sourceMode(spec.targetAppId)?.mode === 'closed') {
          throw new Error(`refusing a writable mount: ${spec.targetAppId} is a closed install`);
        }
        if (spec.workspace) mkdirSync(join(root, 'root', spec.workspace), { recursive: true });
        const m = {
          id, instanceId: inst, targetAppId: spec.targetAppId, kind, mode: kind === 'work' ? 'rw' : spec.mode ?? 'ro',
          containerPath: kind === 'work' ? `/mnt/aura/work/${spec.targetAppId}` : `/mnt/aura/${spec.targetAppId}`,
          hostSource: '', hostDest: '', createdAt: '', origin: 'added', declaredAt: '',
          ...(spec.workspace ? { workspace: spec.workspace } : {}),
        } as AuraMount;
        kernel.push(m);
        return m;
      },
      remove: async (inst, id) => { kernel = kernel.filter((m) => !(m.instanceId === inst && m.id === id)); },
      workspaceBinds: (sub) => kernel.filter((m) => m.kind === 'work' && m.workspace === sub).map((m) => ({ instanceId: m.instanceId, mountId: m.id })),
      rebindTarget: async (appId) => {
        for (const m of kernel) if (m.targetAppId === appId && m.kind === 'source' && deps().apps.sourceMode(appId)?.mode === 'closed') m.mode = 'ro';
      },
    },
    installationId: async (appId, scope) => `inst-${scope}-${appId.replace(/\./g, '-')}`,
    nexus,
  };
}

beforeEach(async () => {
  store = new MemoryStore();
  caller = TERMINAL;
  kernel = [];
  audits = [];
  overlays = new Set();
  root = mkdtempSync(join(tmpdir(), 'aura-src-'));
  const scope = (id: core.ScopeId, priority: number, immutable: boolean) =>
    ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority }) as core.ScopeDefinition;
  scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  nexus = new core.NexusManager({ scopes, rootDataDir: join(root, 'root') });
  writeApp(join(scopes[0]!.appsDir, 'com.aura.terminal'), { id: 'com.aura.terminal', originId: O2, name: 'Terminal', version: '1.0.0', tools: ['*'] });
  writeApp(join(scopes[0]!.appsDir, 'io.lakner.terminalx'), { id: 'io.lakner.terminalx', name: 'TerminalX', version: '1.0.0' });
  // An installed store app (closed by default), with instance data.
  const release = join(root, 'release');
  writeApp(release, { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.0' });
  const it = nexus.install({ ref: release, scope: 'global', approval: async () => true });
  for (let c = await it.next(); !c.done; c = await it.next()) { /* to the end */ }
  put(join(scopes[1]!.appsDir, 'io.shop.app', 'io.shop.app', 'orders.json'), '[42]');
});

const req = (method: string, body?: unknown, headers: Record<string, string> = {}, url = 'http://shell.test/api/x') =>
  new Request(url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const read = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });

test('status by id or name: a closed install\'s source view is bound read-only into the calling Terminal', async () => {
  const peek = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=io.shop.app'), 'com.aura.terminal', deps(), false));
  assert.equal(peek.status, 200);
  assert.deepEqual([peek.body.mode, peek.body.modeFrom, peek.body.source.mounted], ['closed', 'default', false]);
  assert.equal(kernel.length, 0, 'GET changes nothing');

  const r = await read(await appSourceStatus(req('POST', { app: 'shop' }), 'com.aura.terminal', deps(), true));
  assert.equal(r.status, 200);
  assert.equal(r.body.appId, 'io.shop.app');
  assert.deepEqual(r.body.source, { path: '/mnt/aura/io.shop.app', writable: false, mounted: true });
  assert.equal(r.body.installationId, 'inst-global-io-shop-app');
  assert.match(r.body.next, /aura dev patch start io\.shop\.app/);
  assert.deepEqual(kernel.map((m) => [m.instanceId, m.id, m.mode]), [['com.aura.terminal', 'io.shop.app', 'ro']]);

  assert.equal((await read(await appSourceStatus(req('POST', { app: 'nope' }), 'com.aura.terminal', deps(), true))).status, 404);
  assert.equal((await read(await appSourceStatus(req('POST', { app: 'io.shop.app' }), 'io.proot.app', deps(), true))).status, 409);
});

test('a system app is closed: its source view is read-only too, and it cannot be opened', async () => {
  const r = await read(await appSourceStatus(req('POST', { app: 'Terminal' }), 'com.aura.terminal', deps(), true));
  assert.deepEqual([r.body.appId, r.body.mode, r.body.modeFrom, r.body.source.writable], ['com.aura.terminal', 'closed', 'system', false]);
  const open = await read(await setSourceMode({ request: req('POST', { mode: 'open' }), cookies: {} as never }, 'com.aura.terminal', deps()));
  assert.deepEqual([open.status, open.body.error], [409, 'system-app']);
});

test('opening needs the owner (202, then approved, then once); the open view is writable in the owner\'s Terminal only', async () => {
  const ctx = (headers: Record<string, string> = {}) => ({ request: req('POST', { mode: 'open' }, headers), cookies: {} as never });
  const first = await read(await setSourceMode(ctx(), 'io.shop.app', deps()));
  assert.equal(first.status, 202);
  assert.deepEqual([first.body.action, first.body.level], ['app.source.open', 'session']);
  assert.equal(core.effectiveSourceMode(scopes[1]!, { id: 'io.shop.app' }).mode, 'closed', 'nothing changed yet');
  const id = first.body.approvalId as string;
  assert.equal((await store.approve(id, DECIDER)).ok, true);
  const done = await read(await setSourceMode(ctx({ 'x-aura-approval': id }), 'io.shop.app', deps()));
  assert.deepEqual([done.status, done.body.mode], [200, 'open']);
  assert.equal(nexus.records.get('io.shop.app')?.sourceMode, 'open');
  assert.equal((await read(await setSourceMode(ctx({ 'x-aura-approval': id }), 'io.shop.app', deps()))).status, 202, 'used up');

  caller = OTHER;
  const other = await read(await appSourceStatus(req('POST', { app: 'io.shop.app' }), 'io.lakner.terminalx', deps(), true));
  assert.equal(other.body.source.writable, false, 'another app gets a read-only view');
  caller = TERMINAL;
  const mine = await read(await appSourceStatus(req('POST', { app: 'io.shop.app' }), 'com.aura.terminal', deps(), true));
  assert.equal(mine.body.source.writable, true);
  assert.match(mine.body.next, /directly/);

  // Closing needs nobody, and the view comes back read-only.
  const closed = await read(await setSourceMode({ request: req('POST', { mode: 'closed' }), cookies: {} as never }, 'io.shop.app', deps()));
  assert.deepEqual([closed.status, closed.body.mode], [200, 'closed']);
  assert.equal(kernel.find((m) => m.instanceId === 'com.aura.terminal')?.mode, 'ro');
});

test('a workspace is created and bound writable at /mnt/aura/work/<app> in the calling Terminal only', async () => {
  const r = await read(await bindWorkspace(req('POST', { app: 'io.shop.app' }), 'com.aura.terminal', deps()));
  assert.deepEqual(r.body, { ok: true, appId: 'io.shop.app', installationId: 'inst-global-io-shop-app', n: 1, path: '/mnt/aura/work/io.shop.app', created: true });
  assert.ok(existsSync(join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '1')));
  assert.deepEqual(kernel.map((m) => [m.instanceId, m.id, m.mode]), [['com.aura.terminal', 'io.shop.app:work', 'rw']], 'nowhere else');

  const again = await read(await bindWorkspace(req('POST', { app: 'io.shop.app' }), 'com.aura.terminal', deps()));
  assert.deepEqual([again.body.n, again.body.created], [1, false], 'the bound one again');
  const next = await read(await bindWorkspace(req('POST', { app: 'io.shop.app', new: true }), 'com.aura.terminal', deps()));
  assert.deepEqual([next.body.n, next.body.created], [2, true]);
  assert.equal(kernel.length, 1, 'one workspace of an app per Terminal');

  const status = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=io.shop.app'), 'com.aura.terminal', deps(), false));
  assert.deepEqual(status.body.workspace, { n: 2, path: '/mnt/aura/work/io.shop.app' });
  assert.deepEqual(status.body.workspaces, [1, 2]);

  const off = await read(await detachWorkspace(req('DELETE', undefined, {}, 'http://shell.test/x?app=io.shop.app'), 'com.aura.terminal', deps()));
  assert.deepEqual(off.body, { ok: true, removed: true });
  assert.ok(existsSync(join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '2')), 'the dir is kept');
});

test('activate without approval answers 202; with it the tree is swapped, the rollback tree kept, the data survives', async () => {
  await bindWorkspace(req('POST', { app: 'io.shop.app' }), 'com.aura.terminal', deps());
  const ws = join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '1');
  writeApp(ws, { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.0' }, 'patched\n');
  const appDir = join(scopes[1]!.appsDir, 'io.shop.app');

  const first = await read(await activatePrepared(req('POST', { workspace: 1 }), 'io.shop.app', deps()));
  assert.equal(first.status, 202);
  assert.deepEqual([first.body.action, first.body.level], ['app.patch.activate', 'session']);
  assert.match(first.body.display.title, /^Activate patched Shop/);
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), 'v1\n', 'nothing swapped');

  const id = first.body.approvalId as string;
  await store.approve(id, DECIDER);
  const done = await read(await activatePrepared(req('POST', { workspace: 1 }, { 'x-aura-approval': id }), 'io.shop.app', deps()));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.scope, done.body.overlay, done.body.running], ['global', false, ['io.shop.app']]);
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), 'patched\n');
  assert.equal(readFileSync(join(appDir, 'io.shop.app', 'orders.json'), 'utf-8'), '[42]');
  assert.ok(done.body.rollbackTree && existsSync(done.body.rollbackTree));
  assert.equal(readFileSync(join(done.body.rollbackTree, 'src', 'index.astro'), 'utf-8'), 'v1\n');

  // A permission change makes it `fresh`.
  writeApp(ws, { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.0', permissions: ['apps.mount'] }, 'patched 2\n');
  const perm = await read(await activatePrepared(req('POST', { workspace: 1 }), 'io.shop.app', deps()));
  assert.deepEqual([perm.status, perm.body.level], [202, 'fresh']);

  assert.equal((await read(await activatePrepared(req('POST', { workspace: 9 }), 'io.shop.app', deps()))).status, 404);
});

test('a system app activates as a user-scope overlay, `fresh` for the Terminal; /workspace (the system copy) untouched', async () => {
  const b = await read(await bindWorkspace(req('POST', { app: 'com.aura.terminal' }), 'com.aura.terminal', deps()));
  assert.equal(b.body.installationId, 'inst-system-com-aura-terminal');
  const ws = join(root, 'root', 'aura', 'workspaces', 'default', 'inst-system-com-aura-terminal', '1');
  writeApp(ws, { id: 'com.aura.terminal', originId: O2, name: 'Terminal', version: '1.0.0', tools: ['*'] }, 'status line\n');

  const first = await read(await activatePrepared(req('POST', { workspace: 1 }), 'com.aura.terminal', deps()));
  assert.deepEqual([first.status, first.body.level], [202, 'fresh']);
  await store.approve(first.body.approvalId, { ...DECIDER, fresh: true });
  const done = await read(await activatePrepared(req('POST', { workspace: 1 }, { 'x-aura-approval': first.body.approvalId }), 'com.aura.terminal', deps()));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.scope, done.body.overlay, done.body.rollbackTree], ['user', true, null]);
  assert.equal(readFileSync(join(scopes[2]!.appsDir, 'com.aura.terminal', 'src', 'index.astro'), 'utf-8'), 'status line\n');
  assert.equal(readFileSync(join(scopes[0]!.appsDir, 'com.aura.terminal', 'src', 'index.astro'), 'utf-8'), 'v1\n');

  // The lifecycle links the approved activation to the system installation
  // (core app-host-registry test "overlay"); this fake registry has no lifecycle.
  overlays.add('com.aura.terminal');
  // The overlay keeps the system app's workspaces and patches (same key).
  const s = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=com.aura.terminal'), 'com.aura.terminal', deps(), false));
  assert.deepEqual([s.body.scope, s.body.overlay, s.body.installationId, s.body.mode], ['user', true, 'inst-system-com-aura-terminal', 'closed']);
});

test('a same-id user copy without the overlay link is its own app: own patch key, and not the owner\'s Terminal', async () => {
  // An open app (built here, no install record) to ask for a writable view of.
  writeApp(join(scopes[2]!.appsDir, 'io.local.app'), { id: 'io.local.app', name: 'Local', version: '1.0.0' });
  const writable = async () => (await read(await appSourceStatus(req('POST', { app: 'io.local.app' }), 'com.aura.terminal', deps(), true))).body.source.writable;
  assert.equal(await writable(), true, 'the system Terminal gets the writable view of an open app');

  // A user-scope com.aura.terminal that no approved activation linked (a store or `aura dev` copy).
  writeApp(join(scopes[2]!.appsDir, 'com.aura.terminal'), { id: 'com.aura.terminal', name: 'Terminal', version: '9.0.0', tools: ['*'] });
  const s = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=com.aura.terminal'), 'com.aura.terminal', deps(), false));
  assert.deepEqual([s.body.scope, s.body.overlay, s.body.installationId], ['user', false, 'inst-user-com-aura-terminal']);
  kernel = [];
  assert.equal(await writable(), false, 'an unlinked same-id copy is no trusted Terminal');

  // Linked by an approved activation: the owner's Terminal again, patched under the system key.
  overlays.add('com.aura.terminal');
  const o = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=com.aura.terminal'), 'com.aura.terminal', deps(), false));
  assert.deepEqual([o.body.overlay, o.body.installationId], [true, 'inst-system-com-aura-terminal']);
  kernel = [];
  assert.equal(await writable(), true);
});

test('activate installs the calling user\'s workspace; only the owner names another user\'s', async () => {
  const ws = (user: string) => join(root, 'root', 'aura', 'workspaces', user, 'inst-global-io-shop-app', '1');
  writeApp(ws('default'), { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.1' }, 'mine\n');
  writeApp(ws('bob'), { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.2' }, 'bob\n');

  // A Terminal of user `default` can't reach bob's workspace.
  const denied = await read(await activatePrepared(req('POST', { workspace: 1, user: 'bob' }), 'io.shop.app', deps()));
  assert.deepEqual([denied.status, denied.body.error], [403, 'forbidden']);
  // Bob's own Terminal activates his own workspace (the approval names that tree).
  caller = { ...TERMINAL, instanceId: 'com.aura.terminal-2', userId: 'bob' };
  const bob = await read(await activatePrepared(req('POST', { workspace: 1 }), 'io.shop.app', deps()));
  assert.equal(bob.status, 202);
  assert.match(JSON.stringify(bob.body.display), /workspaces\/bob\//);
  // The owner may name any user's workspace.
  caller = { kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified' } as CallerPrincipal;
  const owner = await read(await activatePrepared(req('POST', { workspace: 1, user: 'bob' }), 'io.shop.app', deps()));
  assert.notEqual(owner.status, 403);
  assert.notEqual(owner.status, 404);
});

test('patch clean: deletes this user\'s old workspaces, keeps the bound one and the newest N, detaches before deleting', async () => {
  const wsDir = (user: string, n: number) => join(root, 'root', 'aura', 'workspaces', user, 'inst-global-io-shop-app', String(n));
  for (let n = 1; n <= 6; n++) mkdirSync(wsDir('default', n), { recursive: true });
  mkdirSync(wsDir('bob', 1), { recursive: true });
  // Bound here: 2. Bound in another Terminal of this user: 3.
  await bindWorkspace(req('POST', { app: 'io.shop.app', n: 2 }), 'com.aura.terminal', deps());
  await bindWorkspace(req('POST', { app: 'io.shop.app', n: 3 }), 'com.aura.terminal-2', deps());

  const r = await read(await cleanWorkspaces(req('POST', { app: 'shop', keep: 2 }), 'com.aura.terminal', deps()));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.kept, r.body.deleted, r.body.detached], [[2, 5, 6], [1, 3, 4], 1]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => existsSync(wsDir('default', n))), [false, true, false, false, true, true]);
  assert.ok(existsSync(wsDir('bob', 1)), 'another user\'s workspaces are not touched');
  assert.deepEqual(kernel.filter((m) => m.kind === 'work').map((m) => [m.instanceId, m.workspace]),
    [['com.aura.terminal', 'aura/workspaces/default/inst-global-io-shop-app/2']], 'detached in the other Terminal, still bound here');

  // Default keep 3; nothing more to delete. keep 0 keeps only the bound one.
  assert.deepEqual((await read(await cleanWorkspaces(req('POST', { app: 'io.shop.app' }), 'com.aura.terminal', deps()))).body.deleted, []);
  assert.deepEqual((await read(await cleanWorkspaces(req('POST', { app: 'io.shop.app', keep: 0 }), 'com.aura.terminal', deps()))).body.deleted, [5, 6]);
  assert.equal((await read(await cleanWorkspaces(req('POST', { app: 'io.shop.app', keep: -1 }), 'com.aura.terminal', deps()))).status, 400);
});
