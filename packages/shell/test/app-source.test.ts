// Track P, the shell side of app patching (lib/appSource.ts): where an agent
// finds an app's source, the patch workspace bound into the calling Terminal,
// opening an app (owner approval), and activating a prepared tree through the
// Nexus install pipeline (owner approval, swap, rollback tree); built-in apps refused.
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, AuraMount } from '@aura/core';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import { mountedSourcePath } from '../src/lib/appSource.ts';
import {
  activatePrepared, appSourceStatus, startPreview, stopPreviews, cleanWorkspaces, mountAppVolume, setSourceMode, type AppSourceDeps, type ScopedApp,
} from '../src/lib/appSource.ts';
import { exchangeHelper } from '../../core/test/rename-exchange-helper.mjs';

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
/** Admin audit rows (patch lifecycle, Phase 7a). */
let auditRows: Array<{ action: string; target?: string; outcome?: string; detail: Record<string, any> }>;
/** Previews the fake AppManager started: instanceId → { appId, appDir, workspace, owner }. */
let previews: Map<string, { appId: string; appDir: string; workspace: string; owner: string }>;
/** Apps with no installation record yet, and the apps `syncAppHost` gave one. */
let unallocated: Set<string>;
let synced: string[];
/** Apps whose repair fails. */
let unrepairable: Set<string>;
/** Source trees handed to the owner (`handToOwner`), as `appId`. */
let handed: string[];

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
    for (const id of ['io.shop.app', 'io.shop.mine', 'com.aura.terminal', 'io.lakner.terminalx', 'io.local.app']) {
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
        ? { appId: id.replace(/-\d+$/, ''), runtime: 'container', capabilities: { mounts: true } as never }
        : id === 'io.proot.app' ? { appId: id, runtime: 'proot', capabilities: { mounts: false } as never } : undefined),
      instancesOf: (appId) => (appId === 'io.shop.app' ? ['io.shop.app'] : []),
      startPreview: async (appId, opts) => {
        for (const [id, p] of previews) if (p.appId === appId && p.owner === opts.owner) previews.delete(id);
        const id = `${appId}-p${previews.size + 1}`;
        previews.set(id, { appId, ...opts });
        return id;
      },
      previewsOf: (appId, owner) => [...previews].filter(([, p]) => p.appId === appId && (owner === undefined || p.owner === owner))
        .map(([instanceId, p]) => ({ instanceId, owner: p.owner })),
      stopPreview: async (id) => { previews.delete(id); },
      trustedSystemCopy: (appId) => {
        const a = apps().find((x) => x.id === appId);
        return a?.scopeId === 'system';
      },
    },
    mounts: {
      capable: () => ({ ok: true }),
      list: (inst) => kernel.filter((m) => m.instanceId === inst),
      add: async (inst, spec) => {
        const kind = spec.patches ? 'patches' : spec.workspace ? 'work' : 'source';
        const id = kind === 'source' ? spec.targetAppId : `${spec.targetAppId}:${kind}`;
        if (kernel.some((m) => m.instanceId === inst && m.id === id)) throw new Error(`${id} is already mounted into ${inst}`);
        if (kind === 'source' && spec.mode === 'rw' && deps().apps.sourceMode(spec.targetAppId)?.mode === 'closed') {
          throw new Error(`refusing a writable mount: ${spec.targetAppId} is a closed install`);
        }
        const volume = spec.patches ?? spec.workspace;
        if (volume) mkdirSync(join(root, 'root', volume), { recursive: true });
        const m = {
          id, instanceId: inst, targetAppId: spec.targetAppId, kind, mode: kind === 'source' ? spec.mode ?? 'ro' : 'rw',
          containerPath: kind === 'source' ? `/mnt/aura/${spec.targetAppId}` : `/mnt/aura/${kind}/${spec.targetAppId}`,
          hostSource: volume ? join(root, 'root', volume) : '', hostDest: '', createdAt: '', origin: 'added', declaredAt: '',
          ...(spec.workspace ? { workspace: spec.workspace } : {}),
          ...(spec.patches ? { patches: spec.patches } : {}),
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
    ensureInstallation: async (appId) => {
      const scope = apps().find((a) => a.id === appId)?.scopeId;
      if (!scope) return { installation: null, error: `${appId} is not installed` };
      if (unallocated.has(appId)) {
        synced.push(appId);
        if (unrepairable.has(appId)) return { installation: null, error: `${appId} has no installation record and it could not be created (kv down)` };
        unallocated.delete(appId);
      }
      return { installation: { installationId: `inst-${scope}-${appId.replace(/\./g, '-')}` } };
    },
    nexus,
    handToOwner: async (appDir, appId) => { assert.equal(appDir, apps().find((a) => a.id === appId)?.appDir); handed.push(appId); return null; },
    audit: { record: async (e: any) => { auditRows.push({ ...e, detail: e.detail ?? {} }); return e; } },
  };
}

beforeEach(async () => {
  store = new MemoryStore();
  caller = TERMINAL;
  kernel = [];
  audits = [];
  auditRows = [];
  previews = new Map();
  unallocated = new Set();
  synced = [];
  unrepairable = new Set();
  handed = [];
  root = mkdtempSync(join(tmpdir(), 'aura-src-'));
  const scope = (id: core.ScopeId, priority: number, immutable: boolean) =>
    ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority }) as core.ScopeDefinition;
  scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  nexus = new core.NexusManager({ exchangeHelper: exchangeHelper(), scopes, rootDataDir: join(root, 'root') });
  writeApp(join(scopes[0]!.appsDir, 'com.aura.terminal'), { id: 'com.aura.terminal', originId: O2, name: 'Terminal', version: '1.0.0', tools: ['*'] });
  writeApp(join(scopes[0]!.appsDir, 'io.lakner.terminalx'), { id: 'io.lakner.terminalx', name: 'TerminalX', version: '1.0.0' });
  // An installed store app (closed by default), with instance data.
  const release = join(root, 'release');
  writeApp(release, { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.0' });
  const it = nexus.install({ ref: release, scope: 'global', approval: async () => true });
  for (let c = await it.next(); !c.done; c = await it.next()) { /* to the end */ }
  put(join(scopes[1]!.appsDir, 'io.shop.app', 'io.shop.app', 'orders.json'), '[42]');
});

/**
 * A real series (Phase 7a: R4 binds the revision and checks the tree): the
 * shop release as an upstream git repo, `change` committed on it, saved as
 * the installation's series, and built into `user`'s workspace `n` the way
 * `aura dev patch activate` builds its scratch workspace. Returns the revision.
 */
function seriesWorkspace(user: string, n: number, change: (dir: string) => void, key = 'inst-global-io-shop-app'): { rev: string; ws: string } {
  const upstream = join(root, 'upstream');
  if (!existsSync(join(upstream, '.git'))) {
    writeApp(upstream, { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.0' });
    core.initRepo(upstream, 'release 1.0.0');
  }
  const base = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD']).toString().trim();
  const edit = mkdtempSync(join(root, 'edit-'));
  execFileSync('git', ['clone', '-q', upstream, edit]);
  change(edit);
  execFileSync('git', ['-C', edit, 'add', '-A']);
  execFileSync('git', ['-C', edit, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', `change for ${user}`]);
  const repo = join(root, 'root', core.patchRepoSubpath(key));
  const saved = core.saveSeries(repo, {
    target: { kind: 'app', appId: 'io.shop.app' }, base: { repository: upstream, commit: base }, patches: core.exportPatches(edit, base), message: 'save',
  });
  const ws = join(root, 'root', core.workspaceSubpath(user, key, n));
  rmSync(ws, { recursive: true, force: true });
  const built = core.buildTree(ws, saved.series.base, core.readPatches(repo, saved.series, saved.commit));
  assert.equal(built.ok, true);
  return { rev: saved.commit, ws };
}

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

test('an app without its installation (a clone before 0.0.50) gets it on the first status, once', async () => {
  unallocated.add('io.shop.app');
  const r = await read(await appSourceStatus(req('POST', { app: 'io.shop.app' }), 'com.aura.terminal', deps(), true));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.installationId, r.body.activeInstallationId], ['inst-global-io-shop-app', 'inst-global-io-shop-app']);
  assert.deepEqual(synced, ['io.shop.app']);
  await read(await appSourceStatus(req('POST', { app: 'io.shop.app' }), 'com.aura.terminal', deps(), true));
  assert.deepEqual(synced, ['io.shop.app'], 'an app that has one is never synced here');
});

test('B7: an installation that cannot be repaired is a clear error, never a silent no-op', async () => {
  unallocated.add('io.shop.app');
  unrepairable.add('io.shop.app');
  const r = await read(await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'io.shop.app', kind: 'work' }));
  assert.deepEqual([r.status, r.body.error], [409, 'no-installation']);
  assert.match(r.body.message, /could not be created \(kv down\)/);
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
  assert.deepEqual(handed, [], 'a global-scope app\'s source is never handed to the owner');
});

test('B6: opening a user-scope install hands its source to the owner, as `aura dev new` does; closing does not', async () => {
  const release = join(root, 'release-mine');
  writeApp(release, { id: 'io.shop.mine', originId: O2.replace(/2$/, '3'), name: 'Mine', version: '1.0.0' });
  const it = nexus.install({ ref: release, scope: 'user', approval: async () => true });
  for (let c = await it.next(); !c.done; c = await it.next()) { /* to the end */ }
  const ctx = (mode: string, headers: Record<string, string> = {}) => ({ request: req('POST', { mode }, headers), cookies: {} as never });
  const first = await read(await setSourceMode(ctx('open'), 'io.shop.mine', deps()));
  assert.equal(first.status, 202);
  assert.deepEqual(handed, [], 'nothing before the owner approved');
  assert.equal((await store.approve(first.body.approvalId as string, DECIDER)).ok, true);
  const done = await read(await setSourceMode(ctx('open', { 'x-aura-approval': first.body.approvalId as string }), 'io.shop.mine', deps()));
  assert.deepEqual([done.status, done.body.mode], [200, 'open']);
  assert.deepEqual(handed, ['io.shop.mine']);
  const closed = await read(await setSourceMode(ctx('closed'), 'io.shop.mine', deps()));
  assert.deepEqual([closed.status, closed.body.mode], [200, 'closed']);
  assert.deepEqual(handed, ['io.shop.mine'], 'closing changes no owner');
});

test('B6: a user-scope clone is handed to the owner after it landed and before it is registered, as a scaffold is', () => {
  const src = readFileSync(new URL('../src/pages/api/admin/clone-app.ts', import.meta.url), 'utf8');
  const hand = src.indexOf("if (targetScopeId === 'user') {\n      const ownership = await handOwnAppSourceToOwner(dest, targetAppId);");
  assert.ok(hand > 0, 'clone-app hands a user-scope clone to the owner');
  assert.ok(hand > src.indexOf('renameSync(staging, dest)'), 'after the tree landed');
  assert.ok(hand < src.indexOf('mgr.reloadScopedApp(targetAppId)'), 'before it is registered and can start');
  const scaffold = readFileSync(new URL('../src/pages/api/admin/scaffold.ts', import.meta.url), 'utf8');
  assert.match(scaffold, /scope === 'user' \? await handOwnAppSourceToOwner\(dest, appId\)/, 'the same function as scaffold');
});

test('a workspace is created and bound writable at /mnt/aura/work/<app> in the calling Terminal only', async () => {
  const r = await read(await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'io.shop.app', kind: 'work' }));
  const { mount, ...rest } = r.body;
  assert.deepEqual(rest, { ok: true, appId: 'io.shop.app', installationId: 'inst-global-io-shop-app', n: 1, path: '/mnt/aura/work/io.shop.app', created: true });
  assert.deepEqual([mount.kind, mount.id, mount.workspace], ['work', 'io.shop.app:work', 'aura/workspaces/default/inst-global-io-shop-app/1'], 'the same mount `aura mount ls` shows');
  assert.ok(existsSync(join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '1')));
  assert.deepEqual(kernel.map((m) => [m.instanceId, m.id, m.mode]), [['com.aura.terminal', 'io.shop.app:work', 'rw']], 'nowhere else');

  const again = await read(await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'io.shop.app', kind: 'work' }));
  assert.deepEqual([again.body.n, again.body.created], [1, false], 'the bound one again');
  const next = await read(await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'io.shop.app', kind: 'work', new: true }));
  assert.deepEqual([next.body.n, next.body.created], [2, true]);
  assert.equal(kernel.length, 1, 'one workspace of an app per Terminal');

  const status = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=io.shop.app'), 'com.aura.terminal', deps(), false));
  assert.deepEqual(status.body.workspace, { n: 2, path: '/mnt/aura/work/io.shop.app' });
  assert.deepEqual(status.body.workspaces, [1, 2]);

  await deps().mounts.remove('com.aura.terminal', 'io.shop.app:work');   // `aura mount rm io.shop.app:work`
  assert.ok(existsSync(join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '2')), 'the dir is kept');
});

test('activate without approval answers 202; with it the tree is swapped, the rollback tree kept, the data survives', async () => {
  await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'io.shop.app', kind: 'work' });
  const { rev } = seriesWorkspace('default', 1, (d) => put(join(d, 'src', 'index.astro'), 'patched\n'));
  const appDir = join(scopes[1]!.appsDir, 'io.shop.app');

  const first = await read(await activatePrepared(req('POST', { workspace: 1, rev }), 'io.shop.app', deps()));
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual([first.body.action, first.body.level], ['app.patch.activate', 'session']);
  assert.match(first.body.display.title, /^Activate patched Shop/);
  // Q23: the dialog names the base, the revision, the ordered patches and the diffstat, and carries the exact diff.
  const details = (first.body.display.details as string[]).join('\n');
  assert.match(details, /Base: [0-9a-f]{12}/);
  assert.match(details, new RegExp(`Series revision: ${rev.slice(0, 12)} \\(digest [0-9a-f]{12}\\)`));
  assert.match(details, /1\. change for default \[[0-9a-f]{8}\] 1 file, \+1 −1/);
  assert.match(details, /Diffstat: 1 file change, \+1 −1/);
  assert.match(first.body.display.diff, /^\+patched$/m);
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), 'v1\n', 'nothing swapped');

  const id = first.body.approvalId as string;
  await store.approve(id, DECIDER);
  const done = await read(await activatePrepared(req('POST', { workspace: 1, rev }, { 'x-aura-approval': id }), 'io.shop.app', deps()));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.scope, done.body.running], ['global', ['io.shop.app']]);
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), 'patched\n');
  assert.equal(readFileSync(join(appDir, 'io.shop.app', 'orders.json'), 'utf-8'), '[42]');
  assert.ok(done.body.rollbackTree && existsSync(done.body.rollbackTree));
  assert.equal(readFileSync(join(done.body.rollbackTree, 'src', 'index.astro'), 'utf-8'), 'v1\n');
  // Reproducibility: the record keeps what the tree was built from.
  assert.equal(done.body.record.patched?.seriesRev, rev);
  assert.equal(done.body.record.patched?.patches, 1);
  // Audit: patch.activated with the revision, digest, base, approval and tree digest; no contents.
  const row = auditRows.find((r) => r.action === 'patch.activated');
  assert.ok(row, JSON.stringify(auditRows));
  assert.deepEqual([row.target, row.outcome, row.detail.rev, row.detail.approval, row.detail.patches], ['app:io.shop.app', 'ok', rev, id, 1]);
  assert.match(row.detail.seriesDigest, /^[0-9a-f]{64}$/);
  assert.ok(row.detail.treeDigest);
  assert.doesNotMatch(JSON.stringify(auditRows), /patched\\n|\+patched/, 'no patch contents in the audit');

  // A permission change makes it `fresh`.
  const second = seriesWorkspace('default', 1, (d) => writeApp(d, { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.0', permissions: ['apps.mount'] }, 'patched 2\n'));
  const perm = await read(await activatePrepared(req('POST', { workspace: 1, rev: second.rev }), 'io.shop.app', deps()));
  assert.deepEqual([perm.status, perm.body.level], [202, 'fresh']);

  assert.equal((await read(await activatePrepared(req('POST', { workspace: 9, rev }), 'io.shop.app', deps()))).status, 404);
});

test('Q23 binding: the revision is read from the patch repo and the tree must be exactly base + the series', async () => {
  const { rev, ws } = seriesWorkspace('default', 1, (d) => put(join(d, 'src', 'index.astro'), 'patched\n'));
  // No revision, an unknown one: refused before anyone is asked.
  assert.deepEqual((await read(await activatePrepared(req('POST', { workspace: 1 }), 'io.shop.app', deps()))).body.error, 'invalid-revision');
  assert.equal((await read(await activatePrepared(req('POST', { workspace: 1, rev: 'deadbeefdeadbeef' }), 'io.shop.app', deps()))).status, 404);
  // A tree that is not what the series builds: an extra file, or an extra commit.
  put(join(ws, 'src', 'extra.astro'), 'sneaky\n');
  const extra = await read(await activatePrepared(req('POST', { workspace: 1, rev }), 'io.shop.app', deps()));
  assert.deepEqual([extra.status, extra.body.error], [422, 'tree-mismatch']);
  execFileSync('git', ['-C', ws, 'add', '-A']);
  execFileSync('git', ['-C', ws, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'not in the series']);
  assert.equal((await read(await activatePrepared(req('POST', { workspace: 1, rev }), 'io.shop.app', deps()))).body.error, 'tree-mismatch');
  assert.equal(store.records.size, 0, 'the owner was never asked');

  // An approval of one revision never covers another: the binding differs (digest, order).
  const a = seriesWorkspace('default', 1, (d) => put(join(d, 'src', 'index.astro'), 'A\n'));
  const asked = await read(await activatePrepared(req('POST', { workspace: 1, rev: a.rev }), 'io.shop.app', deps()));
  const id = asked.body.approvalId as string;
  await store.approve(id, DECIDER);
  const b = seriesWorkspace('default', 1, (d) => put(join(d, 'src', 'index.astro'), 'B\n'));
  const swapped = await read(await activatePrepared(req('POST', { workspace: 1, rev: b.rev }, { 'x-aura-approval': id }), 'io.shop.app', deps()));
  assert.equal(swapped.status, 202, 'a new approval is requested');
  assert.notEqual(swapped.body.approvalId, id);
  assert.equal(readFileSync(join(scopes[1]!.appsDir, 'io.shop.app', 'src', 'index.astro'), 'utf-8'), 'v1\n', 'nothing installed');
});

test('save is recorded by the system: R1 `saved` audits patch.saved from the patch repo', async () => {
  const { rev } = seriesWorkspace('default', 1, (d) => put(join(d, 'src', 'index.astro'), 'patched\n'));
  const r = await read(await appSourceStatus(req('POST', { app: 'io.shop.app', saved: rev }), 'com.aura.terminal', deps(), true));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = auditRows.find((x) => x.action === 'patch.saved');
  assert.deepEqual([row?.target, row?.detail.rev, row?.detail.patches, row?.detail.installationId], ['app:io.shop.app', rev, 1, 'inst-global-io-shop-app']);
  assert.equal((await read(await appSourceStatus(req('POST', { app: 'io.shop.app', saved: 'f'.repeat(40) }), 'com.aura.terminal', deps(), true))).status, 422);
});

test('built-in: a built-in app is not patched — R4 answers 409 system-app-later; status says so; nothing is installed', async () => {
  const ws = join(root, 'root', 'aura', 'workspaces', 'default', 'inst-system-com-aura-terminal', '1');
  writeApp(ws, { id: 'com.aura.terminal', originId: O2, name: 'Terminal', version: '1.0.0', tools: ['*'] }, 'status line\n');
  const r = await read(await activatePrepared(req('POST', { workspace: 1 }), 'com.aura.terminal', deps()));
  assert.deepEqual([r.status, r.body.error], [409, 'system-app-later']);
  assert.equal(r.body.message, 'com.aura.terminal is a built-in app. Built-in apps are changed with system patches (`aura system patch start`, Normal mode) or in Developer Mode.');
  assert.equal([...store.records.values()].length, 0, 'the owner is never asked');
  assert.equal(existsSync(join(scopes[2]!.appsDir, 'com.aura.terminal')), false);
  assert.equal(readFileSync(join(scopes[0]!.appsDir, 'com.aura.terminal', 'src', 'index.astro'), 'utf-8'), 'v1\n');
  // Rollback too.
  assert.equal((await read(await activatePrepared(req('POST', { rollback: true }), 'com.aura.terminal', deps()))).status, 409);

  // Status: the read-only source, and the reason.
  const s = await read(await appSourceStatus(req('POST', { app: 'com.aura.terminal' }), 'com.aura.terminal', deps(), true));
  assert.deepEqual([s.body.scope, s.body.mode, s.body.source.writable, s.body.source.mounted], ['system', 'closed', false, true]);
  assert.equal(s.body.next, 'Read the source at /mnt/aura/com.aura.terminal (read-only). Built-in apps are changed with system patches (`aura system patch start`, Normal mode) or in Developer Mode.');
  // A normal app's status is unchanged.
  assert.match((await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=io.shop.app'), 'com.aura.terminal', deps(), false))).body.next, /aura dev patch start io\.shop\.app/);
});

test('a same-id user copy is its own app: own patch key, and never the owner\'s Terminal (Q6)', async () => {
  // An open app (built here, no install record) to ask for a writable view of.
  writeApp(join(scopes[2]!.appsDir, 'io.local.app'), { id: 'io.local.app', name: 'Local', version: '1.0.0' });
  const writable = async () => (await read(await appSourceStatus(req('POST', { app: 'io.local.app' }), 'com.aura.terminal', deps(), true))).body.source.writable;
  assert.equal(await writable(), true, 'the system Terminal gets the writable view of an open app');

  // A user-scope com.aura.terminal (a store or `aura dev` copy).
  writeApp(join(scopes[2]!.appsDir, 'com.aura.terminal'), { id: 'com.aura.terminal', name: 'Terminal', version: '9.0.0', tools: ['*'] });
  const s = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=com.aura.terminal'), 'com.aura.terminal', deps(), false));
  assert.deepEqual([s.body.scope, s.body.installationId, 'overlay' in s.body], ['user', 'inst-user-com-aura-terminal', false]);
  kernel = [];
  assert.equal(await writable(), false, 'a same-id copy is no trusted Terminal');
});

test('activate installs the calling user\'s workspace; only the owner names another user\'s', async () => {
  seriesWorkspace('default', 1, (d) => put(join(d, 'src', 'index.astro'), 'mine\n'));
  const { rev } = seriesWorkspace('bob', 1, (d) => put(join(d, 'src', 'index.astro'), 'bob\n'));

  // A Terminal of user `default` can't reach bob's workspace.
  const denied = await read(await activatePrepared(req('POST', { workspace: 1, user: 'bob', rev }), 'io.shop.app', deps()));
  assert.deepEqual([denied.status, denied.body.error], [403, 'forbidden']);
  // Bob's own Terminal activates his own workspace (the approval names that tree).
  caller = { ...TERMINAL, instanceId: 'com.aura.terminal-2', userId: 'bob' };
  const bob = await read(await activatePrepared(req('POST', { workspace: 1, rev }), 'io.shop.app', deps()));
  assert.equal(bob.status, 202, JSON.stringify(bob.body));
  assert.match(JSON.stringify(bob.body.display), /workspaces\/bob\//);
  // The owner may name any user's workspace.
  caller = { kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified' } as CallerPrincipal;
  const owner = await read(await activatePrepared(req('POST', { workspace: 1, user: 'bob', rev }), 'io.shop.app', deps()));
  assert.notEqual(owner.status, 403);
  assert.notEqual(owner.status, 404);
});

test('patch clean: deletes this user\'s old workspaces; never the bound one, the newest N, or one in use (unless force)', async () => {
  const wsDir = (user: string, n: number) => join(root, 'root', 'aura', 'workspaces', user, 'inst-global-io-shop-app', String(n));
  for (let n = 1; n <= 6; n++) mkdirSync(wsDir('default', n), { recursive: true });
  mkdirSync(wsDir('bob', 1), { recursive: true });
  // Bound here: 2. Bound in another Terminal of this user: 3.
  await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'io.shop.app', kind: 'work', n: 2 });
  await mountAppVolume(req('POST'), 'com.aura.terminal-2', deps(), { app: 'io.shop.app', kind: 'work', n: 3 });
  const clean = async (body: Record<string, unknown>) => read(await cleanWorkspaces(req('POST', { app: 'shop', ...body }), 'com.aura.terminal', deps()));
  const present = () => [1, 2, 3, 4, 5, 6].filter((n) => existsSync(wsDir('default', n)));

  const dry = await clean({ keep: 2, dryRun: true });
  assert.deepEqual([dry.body.kept, dry.body.candidates, dry.body.inUse, dry.body.deleted], [[2, 5, 6], [1, 3, 4], [3], []]);
  assert.deepEqual(present(), [1, 2, 3, 4, 5, 6], 'a dry run deletes nothing');

  // `aura dev` found unsaved work in 4: it names only 1 (and 3, which is in use).
  const r = await clean({ keep: 2, delete: [1, 3] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.deleted, r.body.inUse, r.body.detached], [[1], [3], 0]);
  assert.deepEqual(present(), [2, 3, 4, 5, 6]);
  // Without a list: every candidate not in use.
  assert.deepEqual((await clean({ keep: 2 })).body.deleted, [4]);
  assert.ok(existsSync(wsDir('default', 3)), 'still in use in the other Terminal');
  assert.ok(existsSync(wsDir('bob', 1)), 'another user\'s workspaces are not touched');

  // force: detached there first, then deleted.
  const forced = await clean({ keep: 2, force: true });
  assert.deepEqual([forced.body.deleted, forced.body.detached], [[3], 1]);
  assert.deepEqual(kernel.filter((m) => m.kind === 'work').map((m) => [m.instanceId, m.workspace]),
    [['com.aura.terminal', 'aura/workspaces/default/inst-global-io-shop-app/2']], 'still bound here');
  assert.deepEqual((await clean({ keep: 0 })).body.deleted, [5, 6]);
  assert.equal((await clean({ keep: -1 })).status, 400);
  assert.equal((await clean({ delete: 'all' })).status, 400);
});

test('mount kind patches: one repository per installation on the volume, the same dir in every Terminal of the user, outliving them', async () => {
  const first = await read(await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'Shop', kind: 'patches' }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.path, first.body.installationId, first.body.created, first.body.mount.kind, first.body.mount.mode],
    ['/mnt/aura/patches/io.shop.app', 'inst-global-io-shop-app', true, 'patches', 'rw']);
  const second = await read(await mountAppVolume(req('POST'), 'com.aura.terminal-2', deps(), { app: 'io.shop.app', kind: 'patches' }));
  assert.equal(second.body.created, false, 'the second Terminal binds the existing repository');
  const dirs = kernel.filter((m) => m.kind === 'patches').map((m) => [m.instanceId, m.patches, m.hostSource]);
  const repoDir = join(root, 'root', 'aura', 'patches', 'inst-global-io-shop-app');
  assert.deepEqual(dirs, [['com.aura.terminal', 'aura/patches/inst-global-io-shop-app', repoDir], ['com.aura.terminal-2', 'aura/patches/inst-global-io-shop-app', repoDir]]);

  // A series saved through one Terminal is there for the other, and after the first one is gone.
  writeFileSync(join(repoDir, 'aura-patches.yaml'), 'app: io.shop.app\n');
  kernel = kernel.filter((m) => m.instanceId !== 'com.aura.terminal');   // the instance is removed
  assert.equal(readFileSync(join(repoDir, 'aura-patches.yaml'), 'utf-8'), 'app: io.shop.app\n');
  const s = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=io.shop.app'), 'com.aura.terminal-2', deps(), false));
  assert.deepEqual(s.body.patches, { path: '/mnt/aura/patches/io.shop.app', mounted: true });
  const fresh = await read(await appSourceStatus(req('GET', undefined, {}, 'http://shell.test/x?app=io.shop.app'), 'com.aura.terminal', deps(), false));
  assert.deepEqual(fresh.body.patches, { path: '/mnt/aura/patches/io.shop.app', mounted: false }, 'a new Terminal binds it on demand');

  // Binding again is a no-op; the work kind goes through the same code.
  assert.equal((await read(await mountAppVolume(req('POST'), 'com.aura.terminal-2', deps(), { app: 'io.shop.app', kind: 'patches' }))).status, 200);
  assert.equal(kernel.filter((m) => m.kind === 'patches' && m.instanceId === 'com.aura.terminal-2').length, 1);
  const w = await read(await mountAppVolume(req('POST'), 'com.aura.terminal-2', deps(), { app: 'io.shop.app', kind: 'work', new: true }));
  assert.deepEqual([w.body.n, w.body.path, w.body.mount.kind], [1, '/mnt/aura/work/io.shop.app', 'work']);
  const w2 = await read(await mountAppVolume(req('POST'), 'com.aura.terminal-2', deps(), { app: 'io.shop.app', kind: 'work', new: true }));
  assert.deepEqual([w2.body.n, w2.body.mount.workspace], [2, 'aura/workspaces/default/inst-global-io-shop-app/2']);
  assert.equal((await read(await mountAppVolume(req('POST'), 'io.proot.app', deps(), { app: 'io.shop.app', kind: 'patches' }))).status, 409, 'containers only');
});

test('preview: the caller\'s own workspace runs as a separate instance, no approval; another user can\'t preview it; stop is per user', async () => {
  const ws = join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '1');
  writeApp(ws, { id: 'io.shop.app', originId: O1, name: 'Shop', version: '1.0.1' }, 'patched\n');
  const appDir = join(scopes[1]!.appsDir, 'io.shop.app');
  const before = readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8');

  const r = await read(await startPreview(req('POST', { workspace: 1 }), 'io.shop.app', deps()));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.appId, r.body.workspace], ['io.shop.app', 1]);
  assert.deepEqual(previews.get(r.body.instanceId), {
    appId: 'io.shop.app', appDir: ws, workspace: 'aura/workspaces/default/inst-global-io-shop-app/1', owner: 'default',
  });
  assert.equal(store.records.size, 0, 'no approval: nothing is installed');
  assert.equal(readFileSync(join(appDir, 'src', 'index.astro'), 'utf-8'), before, 'the installed tree is untouched');

  // Bob (his own Terminal) looks up HIS workspace 1 — he has none: default's is not reachable.
  caller = { ...TERMINAL, instanceId: 'com.aura.terminal-2', userId: 'bob' };
  const bob = await read(await startPreview(req('POST', { workspace: 1 }), 'io.shop.app', deps()));
  assert.deepEqual([bob.status, bob.body.error], [404, 'no-workspace']);
  const bobStop = await read(await stopPreviews(req('DELETE', undefined, {}, 'http://shell.test/x'), 'io.shop.app', deps()));
  assert.deepEqual(bobStop.body.stopped, [], 'bob stops only his own previews');
  assert.equal((await read(await stopPreviews(req('DELETE', undefined, {}, 'http://shell.test/x?user=default'), 'io.shop.app', deps()))).status, 403);
  assert.equal(previews.size, 1);

  caller = TERMINAL;
  const stop = await read(await stopPreviews(req('DELETE', undefined, {}, 'http://shell.test/x'), 'io.shop.app', deps()));
  assert.deepEqual(stop.body.stopped, [r.body.instanceId]);
  assert.equal(previews.size, 0);

  // A tree of another app, no workspace number, a built-in app: refused.
  writeApp(join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '2'), { id: 'io.other.app', name: 'Other', version: '1.0.0' });
  assert.equal((await read(await startPreview(req('POST', { workspace: 2 }), 'io.shop.app', deps()))).status, 422);
  assert.equal((await read(await startPreview(req('POST', {}), 'io.shop.app', deps()))).status, 400);
  // D48: a workspace built for a newer Aura contract never runs.
  writeApp(join(root, 'root', 'aura', 'workspaces', 'default', 'inst-global-io-shop-app', '3'), { id: 'io.shop.app', originId: O1, name: 'Shop', version: '2.0.0', auraContract: 2 });
  const future = await read(await startPreview(req('POST', { workspace: 3 }), 'io.shop.app', deps()));
  assert.deepEqual([future.status, future.body.error], [422, 'contract-unsupported']);
  assert.match(future.body.message, /^io\.shop\.app is built for Aura contract 2; this AuraOS implements 1\./);
  assert.equal(previews.size, 0);
  assert.equal((await read(await startPreview(req('POST', { workspace: 1 }), 'com.aura.terminal', deps()))).body.error, 'system-app-later');
});

test('a sandbox path in its own source mount is the app dir in the shell (dev publish in the app dir)', () => {
  const mounts = [
    { kind: 'source', containerPath: '/mnt/aura/com.example.a', targetAppId: 'com.example.a' },
    { kind: 'work', containerPath: '/mnt/aura/work/com.example.a', targetAppId: 'com.example.a' },
  ];
  const dirs: Record<string, string> = { 'com.example.a': '/data/scopes/users/default/apps/com.example.a' };
  const map = (p: string) => mountedSourcePath(p, mounts, (id) => dirs[id]);
  assert.equal(map('/mnt/aura/com.example.a'), '/data/scopes/users/default/apps/com.example.a');
  assert.equal(map('/mnt/aura/com.example.a/'), '/data/scopes/users/default/apps/com.example.a');
  assert.equal(map('/mnt/aura/com.example.a/src'), '/data/scopes/users/default/apps/com.example.a/src');
  assert.equal(map('/mnt/aura/com.example.a/../com.example.b'), '/mnt/aura/com.example.a/../com.example.b', '.. leaves the mount: not mapped');
  assert.equal(map('/mnt/aura/com.example.ab'), '/mnt/aura/com.example.ab', 'a prefix is not the mount');
  assert.equal(map('/mnt/aura/work/com.example.a'), '/mnt/aura/work/com.example.a', 'only source mounts');
  assert.equal(map('relative/dir'), 'relative/dir');
});

test('Track P v1: no writable patch path of a built-in app — neither a patch repo nor a workspace is created or bound', async () => {
  for (const kind of ['work', 'patches'] as const) {
    const r = await read(await mountAppVolume(req('POST'), 'com.aura.terminal', deps(), { app: 'com.aura.terminal', kind, new: true }));
    assert.deepEqual([r.status, r.body.error], [409, 'system-app-later'], kind);
  }
  assert.equal(kernel.filter((m) => m.kind === 'work' || m.kind === 'patches').length, 0, 'nothing bound');
  assert.equal(existsSync(join(root, 'root', 'aura', 'workspaces', 'default', 'inst-system-com-aura-terminal')), false, 'no workspace dir');
  assert.equal(existsSync(join(root, 'root', 'aura', 'patches', 'inst-system-com-aura-terminal')), false, 'no patch repo');
});
