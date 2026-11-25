// Track P authoring and patch tooling (commands/dev.ts, dev-source.ts,
// dev-patch.ts) against a fake shell on loopback that plays P-SYS's routes:
// R1 app-source, R2 app-workspace, R4 activate (aura-work/trackp-streams.md).
//
//   pnpm --filter @aura/cli test
import { TEST_ROOT } from './helpers/dev-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerDev } from '../src/commands/dev.js';
import { appFromArgOrCwd, bindWorkspace, WORKSPACE_MARKER } from '../src/commands/dev-source.js';
import { activateRevision, cleanApp, notifyNeedsRepair, saveWorkspace, startWorkspace, updateSeries } from '../src/commands/dev-patch.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID', 'AURA_ADMIN_SESSION', 'AURA_ADMIN_CREDENTIAL'];
const INST = 'com.aura.terminal-1';
const APP = 'io.test.status';
const APPROVAL = 'apr_BBBBBBBBBBBBBBBBBBBBBB';

interface Seen { method: string; url: string; body: Record<string, unknown>; approval?: string }
type Handler = (r: Seen) => [number, unknown] | undefined;
const servers: http.Server[] = [];
const saved: Record<string, string | undefined> = {};
const originalExit = process.exit;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function fakeShell(handler: Handler): Promise<Seen[]> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rec: Seen = {
      method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {},
      ...(typeof req.headers['x-aura-approval'] === 'string' ? { approval: req.headers['x-aura-approval'] } : {}),
    };
    seen.push(rec);
    const [status, body] = handler(rec) ?? [404, { error: 'not-found' }];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  process.env['AURA_SHELL_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return seen;
}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  process.env['APP_INSTANCE_ID'] = INST;
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  process.exit = originalExit;
  for (const s of servers.splice(0)) s.close();
});

const quiet = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  const [log, err] = [console.log, console.error];
  console.log = () => undefined; console.error = () => undefined;
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

// ─── a closed install with an upstream repo, played by the fake shell ───────

const STATUS = 'export const status = "idle";\nexport const a = 1;\n\n\n\nexport const footer = "v1";\n';

function world() {
  const root = mkdtempSync(join(TEST_ROOT, 'w-'));
  const upstream = join(root, 'upstream');
  mkdirSync(upstream);
  writeFileSync(join(upstream, 'app.manifest.json'), JSON.stringify({ id: APP, name: 'Status', version: '1.0.0' }) + '\n');
  writeFileSync(join(upstream, 'status.js'), STATUS);
  git(upstream, 'init', '-q', '-b', 'main');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'one');
  // Unique per world: worlds share one patch-repo root.
  const installationId = randomUUID();
  const wsRoot = join(root, 'workspaces');
  let highest = 0;
  let bound: number | null = null;
  const view = () => ({
    appId: APP, name: 'Status', version: '1.0.0', scope: 'user', installationId, activeInstallationId: installationId,
    overlay: false, mode: 'closed', defaultMode: 'closed', modeFrom: 'manifest',
    upstream: { repository: upstream, branch: 'main', commit: git(upstream, 'rev-parse', 'HEAD^0') },
    source: { path: `/mnt/aura/${APP}`, writable: false, mounted: true },
    workspace: bound ? { n: bound, path: join(wsRoot, String(bound)) } : null,
    workspaces: Array.from({ length: highest }, (_, i) => i + 1),
    next: `aura dev patch start ${APP}`,
  });
  // The install's upstream stays where it was installed until an update.
  let installed = git(upstream, 'rev-parse', 'HEAD');
  const routes = (r: Seen): [number, unknown] | undefined => {
    if (r.url.startsWith(`/api/instances/${INST}/app-source`)) return [200, { ...view(), upstream: { ...view().upstream, commit: installed } }];
    if (r.method === 'POST' && r.url === `/api/instances/${INST}/app-workspace`) {
      const n = r.body['new'] ? ++highest : (r.body['n'] as number | undefined) ?? bound ?? (highest || ++highest);
      mkdirSync(join(wsRoot, String(n)), { recursive: true });
      bound = n;
      return [200, { ok: true, appId: APP, installationId, n, path: join(wsRoot, String(n)), created: true }];
    }
    return undefined;
  };
  const commitUpstream = (text: string, msg: string) => {
    writeFileSync(join(upstream, 'status.js'), text);
    git(upstream, 'commit', '-qam', msg);
    return git(upstream, 'rev-parse', 'HEAD');
  };
  return { root, upstream, installationId, wsRoot, routes, commitUpstream, setInstalled: (c: string) => { installed = c; }, bound: () => bound };
}

/** Start a workspace, change status.js, save. */
async function savedChange(w: ReturnType<typeof world>) {
  const ws = await quiet(() => startWorkspace(APP));
  const f = join(ws.path, 'status.js');
  writeFileSync(f, readFileSync(f, 'utf-8').replace('"idle"', '"busy"'));
  const saved = await quiet(() => saveWorkspace(ws.path, 'Status shows busy'));
  return { ws, saved };
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('dev new: a git repo with an initial commit of the files, AGENTS.md + one-line CLAUDE.md, closed by default', async () => {
  // No shell: the local-write fallback runs the same git step as scaffold.ts.
  process.env['AURA_SHELL_URL'] = 'http://127.0.0.1:1';
  const program = new Command();
  program.exitOverride();
  registerDev(program);
  await quiet(() => program.parseAsync(['node', 'aura', 'dev', 'new', 'com.example.hello', '--non-interactive', '--name', 'Hello']));
  const dest = join(process.env['AURA_DATA_DIR']!, 'scopes', 'users', 'default', 'apps', 'com.example.hello');
  assert.equal(git(dest, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(dest, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(dest, 'status', '--porcelain'), '', 'everything is committed');
  const files = git(dest, 'ls-files').split('\n');
  for (const f of ['AGENTS.md', 'CLAUDE.md', '.gitignore', 'app.manifest.json', 'package.json', 'src/pages/index.astro']) {
    assert.ok(files.includes(f), `${f} is committed`);
  }
  assert.equal(readFileSync(join(dest, 'CLAUDE.md'), 'utf-8'), '@AGENTS.md\n');
  const agents = readFileSync(join(dest, 'AGENTS.md'), 'utf-8');
  assert.match(agents, /^# Hello — AuraOS app/);
  assert.match(agents, /## Source changes/);
  assert.match(agents, /aura dev patch start com\.example\.hello/);
  assert.match(readFileSync(join(dest, '.gitignore'), 'utf-8'), /^node_modules\/$/m);
  const manifest = JSON.parse(readFileSync(join(dest, 'app.manifest.json'), 'utf-8'));
  assert.deepEqual(manifest.source, { defaultMode: 'closed' });
});

test('dev new via the shell: the payload carries AGENTS.md, CLAUDE.md, .gitignore and source.defaultMode', async () => {
  let files: Array<{ relPath: string; content: string }> = [];
  await fakeShell((r) => {
    if (r.url !== '/api/admin/scaffold') return undefined;
    files = r.body['files'] as typeof files;
    return [200, { ok: true, dest: '/data/scopes/users/default/apps/com.example.open', installed: true, git: { commit: 'a'.repeat(40) } }];
  });
  const program = new Command();
  program.exitOverride();
  registerDev(program);
  await quiet(() => program.parseAsync(['node', 'aura', 'dev', 'new', 'com.example.open', '--non-interactive', '--source-mode', 'open']));
  const by = new Map(files.map((f) => [f.relPath, f.content]));
  assert.equal(by.get('CLAUDE.md'), '@AGENTS.md\n');
  assert.ok(by.get('AGENTS.md')?.includes('## Source changes'));
  assert.ok(by.has('.gitignore'));
  assert.deepEqual(JSON.parse(by.get('app.manifest.json')!).source, { defaultMode: 'open' });
});

test('dev status resolves the installation from a subdirectory of the app and from a workspace', async () => {
  const root = mkdtempSync(join(TEST_ROOT, 'cwd-'));
  const app = join(root, 'app');
  mkdirSync(join(app, 'src', 'pages'), { recursive: true });
  writeFileSync(join(app, 'app.manifest.json'), JSON.stringify({ id: 'io.test.fromdir' }));
  assert.equal(appFromArgOrCwd(undefined, join(app, 'src', 'pages')), 'io.test.fromdir');
  const ws = join(root, 'ws');
  mkdirSync(join(ws, '.git'), { recursive: true });
  mkdirSync(join(ws, 'src', 'deep'), { recursive: true });
  // A workspace of a system app holds the app at its root, but its marker wins over any manifest.
  writeFileSync(join(ws, 'app.manifest.json'), JSON.stringify({ id: 'io.test.other' }));
  writeFileSync(join(ws, '.git', WORKSPACE_MARKER), JSON.stringify({ appId: 'io.test.fromws', installationId: 'x', n: 1, base: { commit: 'abcdef1' }, baseCommit: 'abcdef1', patchesRev: null }));
  assert.equal(appFromArgOrCwd(undefined, join(ws, 'src', 'deep')), 'io.test.fromws');
  assert.equal(appFromArgOrCwd('Status', join(ws, 'src')), 'Status', 'an argument wins');

  // The command asks R1 (POST: also binds the source view) for the app it found.
  const w = world();
  const seen = await fakeShell(w.routes);
  const cwd = process.cwd();
  process.chdir(join(app, 'src', 'pages'));
  try {
    const program = new Command();
    program.exitOverride();
    registerDev(program);
    await quiet(() => program.parseAsync(['node', 'aura', 'dev', 'status']));
  } finally { process.chdir(cwd); }
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), [`POST /api/instances/${INST}/app-source`]);
  assert.deepEqual(seen[0]!.body, { app: 'io.test.fromdir' });
});

test('patch start + save: patches/NNNN-*.patch and aura-patches.yaml in one patch-repo commit', async () => {
  const w = world();
  await fakeShell(w.routes);
  const { ws, saved } = await savedChange(w);
  assert.equal(ws.created, true);
  assert.equal(ws.path, join(w.wsRoot, '1'));
  const repo = join(process.env['AURA_PATCHES_DIR']!, w.installationId);
  assert.equal(saved.repo, repo);
  assert.deepEqual(saved.files, ['patches/0001-Status-shows-busy.patch']);
  assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    ['aura-patches.yaml', 'patches/0001-Status-shows-busy.patch']);
  const yaml = readFileSync(join(repo, 'aura-patches.yaml'), 'utf-8');
  assert.match(yaml, new RegExp(`app: ${APP.replace(/\./g, '\\.')}`));
  assert.match(yaml, new RegExp(`commit: ${git(w.upstream, 'rev-parse', 'HEAD')}`));
  // A second start binds the same workspace; a fresh one replays the saved series.
  const again = await quiet(() => startWorkspace(APP));
  assert.equal(again.created, false);
  const fresh = await quiet(() => startWorkspace(APP, { new: true }));
  assert.equal(fresh.apply?.ok, true);
  assert.match(readFileSync(join(fresh.path, 'status.js'), 'utf-8'), /"busy"/);
});

test('activate: builds a fresh tree, calls the install route, 202 → owner approves → done', async () => {
  const w = world();
  let polls = 0;
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === `/api/apps/${APP}/activate`) {
      return r.approval === APPROVAL
        ? [200, { ok: true, record: { id: APP, version: '1.0.0' }, scope: 'user', overlay: false, rollbackTree: '/data/nexus/trash/x', running: [] }]
        : [202, { ok: false, error: 'needs-approval', needsApproval: true, approvalId: APPROVAL, level: 'session', display: { title: `Activate patches for ${APP}`, details: [], requestedBy: 'Terminal' } }];
    }
    if (r.method === 'GET' && r.url === `/api/approvals/${APPROVAL}`) return [200, { id: APPROVAL, state: ++polls < 1 ? 'pending' : 'approved' }];
    return w.routes(r);
  });
  const { saved } = await savedChange(w);
  const out = await quiet(() => activateRevision(APP));
  assert.equal(out.status, 'installed');
  const posts = seen.filter((r) => r.url === `/api/apps/${APP}/activate`);
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.approval, undefined);
  assert.equal(posts[1]!.approval, APPROVAL, 'the retry names the approval');
  // The installed workspace is a fresh one holding base + series, not the working one.
  const n = posts[1]!.body['workspace'] as number;
  assert.equal(n, 2);
  assert.match(readFileSync(join(w.wsRoot, String(n), 'status.js'), 'utf-8'), /"busy"/);
  assert.equal(w.bound(), 1, 'the working workspace is bound again afterwards');
  const repo = join(process.env['AURA_PATCHES_DIR']!, w.installationId);
  assert.equal(git(repo, 'rev-parse', 'refs/aura/active'), saved.commit);
});

test('update: a compatible upstream keeps the patch and installs; a conflict names the patch and installs nothing', async () => {
  const w = world();
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === `/api/apps/${APP}/activate`) return [200, { ok: true, running: [] }];
    return w.routes(r);
  });
  await savedChange(w);
  const repo = join(process.env['AURA_PATCHES_DIR']!, w.installationId);

  const compatible = w.commitUpstream(STATUS.replace('"v1"', '"v2"'), 'footer v2');
  const ok = await quiet(() => updateSeries(APP));
  assert.equal(ok.status, 'installed');
  const installedN = seen.filter((r) => r.url === `/api/apps/${APP}/activate`).pop()!.body['workspace'] as number;
  const text = readFileSync(join(w.wsRoot, String(installedN), 'status.js'), 'utf-8');
  assert.match(text, /"busy"/);
  assert.match(text, /"v2"/);
  assert.match(readFileSync(join(repo, 'aura-patches.yaml'), 'utf-8'), new RegExp(`commit: ${compatible}`), 'the series moved to the new base');
  const activations = seen.filter((r) => r.url === `/api/apps/${APP}/activate`).length;
  const head = git(repo, 'rev-parse', 'HEAD');

  w.commitUpstream(STATUS.replace('"v1"', '"v2"').replace('"idle"', '"waiting"'), 'status waiting');
  const bad = await quiet(() => updateSeries(APP));
  assert.equal(bad.status, 'needs-repair');
  if (bad.status !== 'needs-repair') return;
  assert.equal(bad.failure.failed.file, 'patches/0001-Status-shows-busy.patch');
  assert.equal(bad.failure.failed.subject, 'Status shows busy');
  assert.deepEqual(bad.failure.conflicts, ['status.js']);
  assert.equal(seen.filter((r) => r.url === `/api/apps/${APP}/activate`).length, activations, 'nothing was installed');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'the saved series is unchanged');
  assert.deepEqual(readdirSync(w.wsRoot).sort(), ['1', '2'], 'both updates built in the one scratch workspace');
  assert.ok(existsSync(join(repo, 'patches', '0001-Status-shows-busy.patch')));
});

test('update conflict: the owner gets a notification naming the app, the patch, the conflict files and the repair command', async () => {
  const w = world();
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === `/api/apps/${APP}/activate`) return [200, { ok: true, running: [] }];
    if (r.method === 'POST' && r.url === '/api/notifications') return [201, { ok: true, notification: { id: 'n1' }, warnings: [] }];
    return w.routes(r);
  });
  await savedChange(w);
  const target = w.commitUpstream(STATUS.replace('"idle"', '"waiting"'), 'status waiting');
  const bad = await quiet(() => updateSeries(APP));
  assert.equal(bad.status, 'needs-repair');
  if (bad.status !== 'needs-repair') return;
  assert.equal(await quiet(() => notifyNeedsRepair(APP, bad)), true);
  const sent = seen.filter((r) => r.url === '/api/notifications');
  assert.equal(sent.length, 1);
  const { title, text, priority } = sent[0]!.body as { title: string; text: string; priority: string };
  assert.equal(title, 'Patch needs repair: Status');
  assert.equal(priority, 'high');
  assert.match(text, new RegExp(`Status \\(${APP.replace(/\./g, '\\.')}\\)`));
  assert.match(text, /patch 0001 "Status shows busy" \(patches\/0001-Status-shows-busy\.patch\)/);
  assert.match(text, /Conflicts in status\.js\./);
  assert.match(text, new RegExp(`aura dev patch start ${APP.replace(/\./g, '\\.')} --new --base ${target.slice(0, 12)}`));
});

test('activate and update reuse one scratch build workspace; patch start never hands it out for editing', async () => {
  const w = world();
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === `/api/apps/${APP}/activate`) return [200, { ok: true, running: [] }];
    if (r.method === 'DELETE' && r.url.startsWith(`/api/instances/${INST}/app-workspace`)) return [200, { ok: true, removed: true }];
    return w.routes(r);
  });
  await savedChange(w);
  for (let i = 0; i < 3; i++) assert.equal((await quiet(() => activateRevision(APP))).status, 'installed');
  const used = seen.filter((r) => r.url === `/api/apps/${APP}/activate`).map((r) => r.body['workspace']);
  assert.deepEqual(used, [2, 2, 2]);
  assert.deepEqual(readdirSync(w.wsRoot).sort(), ['1', '2']);
  assert.match(readFileSync(join(w.wsRoot, '2', 'status.js'), 'utf-8'), /"busy"/, 'rebuilt from scratch each time');
  const marker = JSON.parse(readFileSync(join(w.wsRoot, '2', '.git', WORKSPACE_MARKER), 'utf-8'));
  assert.equal(marker.scratch, true);
  assert.equal(w.bound(), 1, 'the working workspace is bound again');

  // The scratch one bound here (as a Terminal without its own would get the highest): start makes a fresh one.
  const repo = join(process.env['AURA_PATCHES_DIR']!, w.installationId);
  assert.equal(git(repo, 'config', '--get', 'aura.default.scratch'), '2');
  await bindWorkspace(APP, { n: 2 });
  const fresh = await quiet(() => startWorkspace(APP));
  assert.deepEqual([fresh.n, fresh.created], [3, true]);
  assert.match(readFileSync(join(fresh.path, 'status.js'), 'utf-8'), /"busy"/);
});

test('patch clean: keeps in-use and unsaved workspaces (listing why); --force deletes them after saying what is lost', async () => {
  const w = world();
  const posts: Array<Record<string, unknown>> = [];
  await fakeShell((r) => {
    if (r.url !== `/api/instances/${INST}/app-workspace/clean`) return w.routes(r);
    posts.push(r.body);
    // Bound here: 1. Workspace 5 is bound in another Terminal.
    const base = { ok: true, appId: APP, installationId: w.installationId, kept: [1], candidates: [2, 3, 4, 5], inUse: [5], detached: 0 };
    if (r.body['dryRun']) return [200, { ...base, deleted: [] }];
    const del = (r.body['delete'] as number[]).filter((n) => r.body['force'] || n !== 5);
    return [200, { ...base, deleted: del }];
  });
  await savedChange(w);                                              // 1: saved, bound
  const edit = (dir: string, text: string) => writeFileSync(join(dir, 'status.js'), readFileSync(join(dir, 'status.js'), 'utf-8').replace('"busy"', text));
  const two = await quiet(() => startWorkspace(APP, { new: true }));  // 2: uncommitted change
  edit(two.path, '"two"');
  const three = await quiet(() => startWorkspace(APP, { new: true })); // 3: committed, never saved
  edit(three.path, '"three"');
  git(three.path, 'commit', '-qam', 'three');
  await quiet(() => startWorkspace(APP, { new: true }));              // 4: as saved
  await quiet(() => startWorkspace(APP, { new: true }));              // 5: in use elsewhere
  await bindWorkspace(APP, { n: 1 });

  const out = await quiet(() => cleanApp(APP, { keep: 0 }));
  assert.deepEqual(posts[0], { app: APP, keep: 0, dryRun: true });
  assert.deepEqual(posts[1], { app: APP, keep: 0, delete: [4] }, 'only the saved workspace goes');
  assert.deepEqual(out.deleted, [4]);
  assert.deepEqual(out.held.map((h) => h.n), [2, 3, 5]);
  assert.match(out.held[0]!.why.join(), /uncommitted changes in status\.js/);
  assert.match(out.held[1]!.why.join(), /1 commit\(s\)|2 commit\(s\)/);
  assert.match(out.held[1]!.why.join(), /not saved/);
  assert.deepEqual(out.held[2]!.why, ['bound in another Terminal']);
  assert.equal(w.bound(), 1, 'the workspace bound before is bound again');

  posts.length = 0;
  let told: number[] = [];
  const forced = await quiet(() => cleanApp(APP, { keep: 0, force: true, onLoss: (held) => { told = held.map((h) => h.n); } }));
  assert.deepEqual(told, [2, 3, 5], 'what is lost is said before anything goes');
  assert.deepEqual(posts[1], { app: APP, keep: 0, delete: [2, 3, 4, 5], force: true });
  assert.deepEqual([forced.deleted, forced.held], [[2, 3, 4, 5], []]);
});

test('patch clean (command): passes --keep and --force', async () => {
  const seen = await fakeShell((r) => (r.url === `/api/instances/${INST}/app-workspace/clean`
    ? [200, { ok: true, appId: APP, installationId: 'x', kept: [4], candidates: [], inUse: [], deleted: [], detached: 0 }]
    : r.url.startsWith(`/api/instances/${INST}/app-source`) ? [200, { appId: APP, installationId: '00000000-1111-4222-8333-444444444444', workspace: null, workspaces: [4] }] : undefined));
  const program = new Command();
  program.exitOverride();
  registerDev(program);
  await quiet(() => program.parseAsync(['node', 'aura', 'dev', 'patch', 'clean', APP, '--keep', '1', '--force']));
  const cleans = seen.filter((r) => r.url.endsWith('/app-workspace/clean')).map((r) => r.body);
  assert.deepEqual(cleans, [{ app: APP, keep: 1, dryRun: true }, { app: APP, keep: 1, delete: [], force: true }]);
});
