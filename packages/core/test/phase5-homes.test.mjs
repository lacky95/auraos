// Phase 5 stream H: the kernel Home Resolver (D65, D67, D72, D74, D79), lazy
// creation, Private Home seeding as its owner, the import, reset and delete
// operations, the ownership apply with its journal (P5-2, D70), the App Home
// ownership rows (P5-3) and the warm-pool home rule.
//
// Runs as root (the shell's identity): creation and chown are real.
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, chownSync, existsSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kernelHomeResolver, ensureHomeDir, HOME_DIR_MODE } from '../dist/homes/HomeResolver.js';
import { HomeDeniedError } from '../dist/homes/types.js';
import { RuntimeCapabilityError } from '../dist/runtimes/types.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';
import {
  importIntoAppHome, resetAppHome, deleteInstallationHomes, normalizeHomePath, AppHomeAdminError,
} from '../dist/homes/appHomeAdmin.js';
import { seedHomeAs } from '../dist/app-manager/homeSeed.js';
import { appOwnershipSpecs, applyAppOwnership } from '../dist/identity/appOwnership.js';
import { buildOwnershipReport } from '../dist/identity/ownershipReport.js';
import {
  applyOwnershipRows, revertOwnershipJournal, runOwnershipApply, selectApplyRows,
} from '../dist/identity/ownershipApply.js';
import { AppManager } from '../dist/app-manager/AppManager.js';

const CONTAINER = ContainerRunner.prototype.capabilities.call({});
const PROOT = ProotRunner.prototype.capabilities.call({});
/** What stream J declares once in-environment sessions exist. */
const SESSIONS = { ...CONTAINER, sessionExec: true, privateHomeSession: true };
const APP = { uid: 200001, gid: 200001 };
const OWNER = { userId: 'default', role: 'owner' };
const MEMBER = { userId: 'u-bob', role: 'member' };
const USERS = { default: { uid: 1000, gid: 1000 }, 'u-bob': { uid: 100000, gid: 100000 } };

function resolver(dataDir, over = {}) {
  return kernelHomeResolver({
    dataDir,
    userIdentity: async (id) => USERS[id] ?? null,
    mayJumpApp: async (p, inst) => p.userId === 'u-bob' && inst === 'inst-granted',
    ...over,
  });
}
const tmp = () => mkdtempSync(join(tmpdir(), 'aura-homes-'));
const req = (o) => ({ installationId: 'inst-1', environmentScope: 'global', executionContext: 'application', runtime: CONTAINER, appIdentity: APP, ...o });
const mode = (p) => statSync(p).mode & 0o7777;
const owner = (p) => { const s = lstatSync(p); return `${s.uid}:${s.gid}`; };

// ─── resolution rules ─────────────────────────────────────────────────────

test('application: the global App Home, created empty, app-owned 0700 under root-owned 0711 parents', async () => {
  const d = tmp();
  const h = await resolver(d).resolve(req({}));
  assert.deepEqual(h, {
    kind: 'app-global', hostPath: join(d, 'aura/apphomes/inst-1/global'), volumeSubpath: 'aura/apphomes/inst-1/global',
    logicalPath: '/home/aura', uid: 200001, gid: 200001, mode: HOME_DIR_MODE,
  });
  assert.equal(owner(h.hostPath), '200001:200001');
  assert.equal(mode(h.hostPath), 0o700);
  assert.deepEqual(readdirSync(h.hostPath), [], 'App Homes start empty (Q15)');
  for (const p of ['aura/apphomes', 'aura/apphomes/inst-1']) {
    assert.equal(owner(join(d, p)), '0:0', p);
    assert.equal(mode(join(d, p)), 0o711, p);
  }
});

test('application: a user-scope App Home per owner; scopes coexist, never merged (D65 §14)', async () => {
  const d = tmp();
  const r = resolver(d);
  const u = await r.resolve(req({ environmentScope: 'user', userId: 'default' }));
  assert.equal(u.kind, 'app-user');
  assert.equal(u.volumeSubpath, 'aura/apphomes/inst-1/users/default');
  assert.equal(mode(join(d, 'aura/apphomes/inst-1/users')), 0o711);
  writeFileSync(join(u.hostPath, 'keep'), 'x');
  const g = await r.resolve(req({}));
  assert.notEqual(g.hostPath, u.hostPath);
  assert.ok(existsSync(join(u.hostPath, 'keep')), 'a scope change deletes nothing');
  await assert.rejects(r.resolve(req({ environmentScope: 'user' })), (e) => e instanceof HomeDeniedError && e.reason === 'user-required');
});

test('application and sidecar: never a Private Home; a root app gets a root-owned App Home', async () => {
  const d = tmp();
  const r = resolver(d);
  for (const executionContext of ['application', 'sidecar']) {
    await assert.rejects(r.resolve(req({ executionContext, principal: OWNER })), (e) => e instanceof HomeDeniedError && e.reason === 'private-home-not-allowed');
  }
  const root = await r.resolve(req({ installationId: 'inst-root', appIdentity: { uid: 0, gid: 0 } }));
  assert.equal(owner(root.hostPath), '0:0');
  assert.equal(mode(root.hostPath), 0o700);
});

test('fail closed: no installation, no identity, a bad id', async () => {
  const r = resolver(tmp());
  await assert.rejects(r.resolve(req({ installationId: null })), (e) => e.reason === 'installation-unresolved');
  await assert.rejects(r.resolve(req({ installationId: '../x' })), (e) => e.reason === 'installation-unresolved');
  await assert.rejects(r.resolve(req({ appIdentity: null })), (e) => e.reason === 'identity-unresolved');
  await assert.rejects(r.resolve(req({ executionContext: 'terminal-session', userId: 'nobody', principal: { userId: 'nobody', role: 'member' }, appIdentity: { uid: 0, gid: 0 } })),
    (e) => e.reason === 'identity-unresolved');
});

test('terminal-session: the user\'s own Private Home on a namespace runtime; never PRoot, never another user or an app uid', async () => {
  const d = tmp();
  const r = resolver(d);
  const h = await r.resolve(req({ executionContext: 'terminal-session', userId: 'default', principal: OWNER, appIdentity: { uid: 0, gid: 0 } }));
  assert.equal(h.kind, 'private');
  assert.equal(h.volumeSubpath, 'aura/home/default');
  assert.equal(owner(h.hostPath), '1000:1000', 'created lazily for its user');
  assert.equal(mode(h.hostPath), 0o700);
  const asUser = await r.resolve(req({ executionContext: 'terminal-session', userId: 'default', principal: OWNER, appIdentity: { uid: 1000, gid: 1000 } }));
  assert.equal(asUser.hostPath, h.hostPath);
  await assert.rejects(r.resolve(req({ executionContext: 'terminal-session', userId: 'default', principal: OWNER, appIdentity: { uid: 0, gid: 0 }, runtime: PROOT })),
    (e) => e instanceof RuntimeCapabilityError && e.missing.includes('isolation'));
  await assert.rejects(r.resolve(req({ executionContext: 'terminal-session', userId: 'default', principal: MEMBER, appIdentity: { uid: 0, gid: 0 } })),
    (e) => e.reason === 'not-authorized');
  await assert.rejects(r.resolve(req({ executionContext: 'terminal-session', userId: 'default', principal: OWNER, appIdentity: APP })),
    (e) => e.reason === 'not-authorized', 'an app identity never gets a Private Home');
  await assert.rejects(r.resolve(req({ executionContext: 'terminal-session', userId: 'default' })), (e) => e.reason === 'user-required');
});

test('jump: private and ephemeral need session capabilities and a non-root target; app needs authorization (D74, D79, J.5)', async () => {
  const d = tmp();
  const r = resolver(d);
  const jump = (o) => req({ executionContext: 'jump', principal: OWNER, ...o });
  // Today's runtimes declare no in-environment sessions: every jump fails closed.
  for (const jumpHomeMode of ['private', 'app', 'ephemeral']) {
    await assert.rejects(r.resolve(jump({ jumpHomeMode, runtime: CONTAINER })), (e) => e instanceof RuntimeCapabilityError && e.missing.includes('sessionExec'), jumpHomeMode);
    await assert.rejects(r.resolve(jump({ jumpHomeMode, runtime: PROOT })), (e) => e instanceof RuntimeCapabilityError, `proot ${jumpHomeMode}`);
  }
  const priv = await r.resolve(jump({ runtime: SESSIONS }));
  assert.equal(priv.kind, 'private', 'the default mode is private');
  assert.equal(priv.uid, 1000);
  await assert.rejects(r.resolve(jump({ runtime: SESSIONS, appIdentity: { uid: 0, gid: 0 } })), (e) => e.reason === 'root-instance');
  await assert.rejects(r.resolve(jump({ runtime: SESSIONS, jumpHomeMode: 'ephemeral', appIdentity: { uid: 0, gid: 0 } })), (e) => e.reason === 'root-instance');
  await assert.rejects(r.resolve(jump({ runtime: SESSIONS, userId: 'u-bob' })), (e) => e.reason === 'not-authorized', 'another user\'s Private Home');
  const eph = await r.resolve(jump({ runtime: SESSIONS, jumpHomeMode: 'ephemeral' }));
  assert.deepEqual([eph.kind, eph.hostPath, eph.volumeSubpath, eph.uid], ['ephemeral', null, null, 1000]);
  // --home app: the App Home with the app's identity; the owner, or a member with app.jump.
  const app = await r.resolve(jump({ runtime: SESSIONS, jumpHomeMode: 'app', appIdentity: { uid: 0, gid: 0 } }));
  assert.deepEqual([app.kind, app.uid], ['app-global', 0], 'a root instance may be entered with --home app');
  await assert.rejects(r.resolve(jump({ runtime: SESSIONS, jumpHomeMode: 'app', principal: MEMBER })), (e) => e.reason === 'not-authorized');
  const granted = await r.resolve(jump({ runtime: SESSIONS, jumpHomeMode: 'app', principal: MEMBER, installationId: 'inst-granted' }));
  assert.equal(granted.uid, APP.uid);
  await assert.rejects(r.resolve(jump({ runtime: SESSIONS, principal: undefined })), (e) => e.reason === 'user-required');
});

test('a preview gets its own App Home per user, never the installed app\'s', async () => {
  const d = tmp();
  const r = resolver(d);
  const p = await r.resolve(req({ preview: true, userId: 'default' }));
  assert.equal(p.volumeSubpath, 'aura/apphomes/inst-1/previews/default');
  await assert.rejects(r.resolve(req({ preview: true })), (e) => e.reason === 'user-required');
});

test('lazy creation never changes an existing home and refuses links', async () => {
  const d = tmp();
  const existing = join(d, 'aura/home/default');
  mkdirSync(existing, { recursive: true });
  chmodSync(existing, 0o755);
  const r = resolver(d);
  const h = await r.resolve(req({ executionContext: 'terminal-session', userId: 'default', principal: OWNER, appIdentity: { uid: 0, gid: 0 } }));
  assert.equal(owner(h.hostPath), '0:0', 'the ownership apply hands an existing Private Home over, not the resolver');
  assert.equal(mode(h.hostPath), 0o755);
  // A link where a home belongs: refused, never followed.
  const outside = join(d, 'outside');
  mkdirSync(outside);
  mkdirSync(join(d, 'aura/apphomes/inst-2'), { recursive: true });
  symlinkSync(outside, join(d, 'aura/apphomes/inst-2/global'));
  await assert.rejects(r.resolve(req({ installationId: 'inst-2' })), (e) => e.reason === 'home-unsafe');
  symlinkSync(outside, join(d, 'aura/apphomes/inst-3'));
  await assert.rejects(r.resolve(req({ installationId: 'inst-3' })), (e) => e.reason === 'home-unsafe');
  assert.deepEqual(readdirSync(outside), []);
  assert.throws(() => ensureHomeDir(d, join(d, 'elsewhere/x'), APP), (e) => e.reason === 'home-unsafe');
  // Report mode decides without creating.
  const rep = await resolver(d, { create: false }).resolve(req({ installationId: 'inst-9' }));
  assert.equal(existsSync(rep.hostPath), false);
});

// ─── seeding ──────────────────────────────────────────────────────────────

test('a Private Home owned by its user is seeded as that user: files are theirs, planted links are not followed as root', () => {
  const d = tmp();
  const seed = join(d, 'seed');
  mkdirSync(join(seed, '.claude'), { recursive: true });
  writeFileSync(join(seed, 'AGENTS.md'), '# hi\n');
  writeFileSync(join(seed, '.claude', 'CLAUDE.md'), '@~/AGENTS.md\n');
  writeFileSync(join(seed, '.codex.toml'), 'x');
  chmodSync(d, 0o755);
  const home = join(d, 'home');
  mkdirSync(home, { mode: 0o700 });
  chownSync(home, 4242, 4242);
  // A link the user planted: root would write through it; the user can't.
  const target = join(d, 'rootonly');
  mkdirSync(target, { mode: 0o755 });
  symlinkSync(target, join(home, '.claude'));
  lchownSync(join(home, '.claude'), 4242, 4242);
  const warnings = [];
  const r = seedHomeAs(seed, home, (m) => warnings.push(m));
  assert.ok(r.copied.includes('AGENTS.md'));
  assert.equal(owner(join(home, 'AGENTS.md')), '4242:4242');
  assert.equal(existsSync(join(target, 'CLAUDE.md')), false, 'nothing written through the planted link');
  // A root-owned home (before the ownership apply) is seeded in-process, as before.
  const legacy = join(d, 'legacy');
  mkdirSync(legacy);
  seedHomeAs(seed, legacy);
  assert.equal(owner(join(legacy, '.claude', 'CLAUDE.md')), '0:0');
});

// ─── import, reset, delete ────────────────────────────────────────────────

function importFixture() {
  const d = tmp();
  const src = join(d, 'aura/home/default');
  mkdirSync(join(src, '.claude/projects'), { recursive: true });
  writeFileSync(join(src, '.claude.json'), '{"projects":{}}');
  chmodSync(join(src, '.claude.json'), 0o600);
  writeFileSync(join(src, '.claude/settings.json'), '{}');
  writeFileSync(join(src, '.claude/.credentials.json'), 'secret-not-read-by-the-test');
  writeFileSync(join(src, '.claude/projects/a.jsonl'), 'line');
  symlinkSync('/etc/hostname', join(src, '.claude/link'));
  mkdirSync(join(src, '.ssh'));
  writeFileSync(join(src, '.ssh/id_ed25519'), 'k');
  chownSync(src, 1000, 1000);
  return d;
}

test('import: a dry run measures, the apply copies (app-owned, modes kept), never links, never personal logins unless asked', async () => {
  const d = importFixture();
  const home = await resolver(d).resolve(req({}));
  const src = join(d, 'aura/home/default');
  const paths = ['.claude.json', '.claude', '.ssh', '.missing', '../etc'];
  assert.throws(() => importIntoAppHome({ source: src, target: home.hostPath, paths, owner: APP, apply: false }), AppHomeAdminError);
  const dry = importIntoAppHome({ source: src, target: home.hostPath, paths: paths.slice(0, 4), owner: APP, apply: false });
  assert.deepEqual(dry.items.map((i) => [i.path, i.action]), [['.claude', 'copy'], ['.claude.json', 'copy'], ['.missing', 'missing'], ['.ssh', 'personal']]);
  assert.equal(dry.copiedFiles, 3, '.claude.json, settings.json, projects/a.jsonl');
  assert.deepEqual(readdirSync(home.hostPath), [], 'a dry run copies nothing');
  const claude = dry.items.find((i) => i.path === '.claude');
  assert.ok(claude.skipped.some((s) => s.includes('.credentials.json') && s.includes('personal')));
  assert.ok(claude.skipped.some((s) => s.includes('link') && s.includes('symbolic link')));

  const done = importIntoAppHome({ source: src, target: home.hostPath, paths: paths.slice(0, 4), owner: APP, apply: true });
  assert.equal(done.copiedFiles, 3);
  assert.equal(readFileSync(join(home.hostPath, '.claude.json'), 'utf-8'), '{"projects":{}}');
  assert.equal(owner(join(home.hostPath, '.claude.json')), '200001:200001');
  assert.equal(mode(join(home.hostPath, '.claude.json')), 0o600);
  assert.equal(owner(join(home.hostPath, '.claude/projects')), '200001:200001');
  assert.equal(existsSync(join(home.hostPath, '.claude/.credentials.json')), false);
  assert.equal(existsSync(join(home.hostPath, '.claude/link')), false);
  assert.equal(existsSync(join(home.hostPath, '.ssh')), false);
  assert.ok(existsSync(join(src, '.claude.json')), 'copied, never moved');

  // Never overwritten; a second run copies only what is new.
  writeFileSync(join(home.hostPath, '.claude.json'), 'mine');
  const again = importIntoAppHome({ source: src, target: home.hostPath, paths: ['.claude.json', '.claude'], owner: APP, apply: true });
  assert.equal(readFileSync(join(home.hostPath, '.claude.json'), 'utf-8'), 'mine');
  assert.deepEqual(again.items.map((i) => [i.path, i.action]), [['.claude', 'exists'], ['.claude.json', 'exists']]);
  assert.equal(again.copiedFiles, 0);
  // Asked for, a personal login is copied.
  const personal = importIntoAppHome({ source: src, target: home.hostPath, paths: ['.claude/.credentials.json'], owner: APP, apply: true, includePersonal: true });
  assert.equal(personal.copiedFiles, 1);
});

test('import: a link planted in the App Home (by the app) or the source is never followed', async () => {
  const d = importFixture();
  const home = await resolver(d).resolve(req({}));
  const src = join(d, 'aura/home/default');
  const victim = join(d, 'victim');
  mkdirSync(victim);
  symlinkSync(victim, join(home.hostPath, '.claude'));
  const r = importIntoAppHome({ source: src, target: home.hostPath, paths: ['.claude'], owner: APP, apply: true });
  assert.equal(r.items[0].action, 'unsafe');
  assert.deepEqual(readdirSync(victim), []);
  mkdirSync(join(src, 'sub'));
  symlinkSync('/etc', join(src, 'sub/etc'));
  const r2 = importIntoAppHome({ source: src, target: home.hostPath, paths: ['sub/etc/hostname'], owner: APP, apply: false });
  assert.equal(r2.items[0].action, 'unsafe');
  assert.equal(normalizeHomePath('a//b/'), 'a/b');
});

test('reset removes only an App Home; delete removes every App Home of the installation, never a Private Home', async () => {
  const d = tmp();
  const r = resolver(d);
  const g = await r.resolve(req({}));
  const u = await r.resolve(req({ environmentScope: 'user', userId: 'default' }));
  writeFileSync(join(g.hostPath, 'login'), 'x');
  const priv = await r.resolve(req({ executionContext: 'terminal-session', userId: 'default', principal: OWNER, appIdentity: { uid: 0, gid: 0 } }));
  assert.throws(() => resetAppHome(d, priv.hostPath), (e) => e.code === 'unsafe');
  assert.equal(resetAppHome(d, g.hostPath), true);
  assert.equal(existsSync(g.hostPath), false);
  assert.ok(existsSync(u.hostPath));
  assert.equal(resetAppHome(d, g.hostPath), false, 'nothing to reset');
  const again = await r.resolve(req({}));
  assert.deepEqual(readdirSync(again.hostPath), [], 'the next start gets it empty');
  assert.equal(deleteInstallationHomes(d, 'inst-1'), true);
  assert.equal(existsSync(join(d, 'aura/apphomes/inst-1')), false);
  assert.ok(existsSync(priv.hostPath), 'the Private Home stays');
  assert.equal(deleteInstallationHomes(d, 'inst-1'), false);
  assert.throws(() => deleteInstallationHomes(d, '../home'), (e) => e.code === 'invalid-path');
});

// ─── ownership ────────────────────────────────────────────────────────────

test('App Home rows: listed with the app\'s rows and handed over at a runAs: app start; never created by the rows', async () => {
  const d = tmp();
  const home = await resolver(d).resolve(req({ appIdentity: { uid: 0, gid: 0 } }));
  writeFileSync(join(home.hostPath, 'f'), 'x');
  const rows = appOwnershipSpecs({
    appId: 'org.x', installationId: 'inst-1', appDataRoot: join(d, 'none'), instanceDirs: [], appDir: d, devServed: false,
    identity: APP, appHomes: [home.hostPath, join(d, 'aura/apphomes/inst-1/users/gone')],
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.mode]), [['app-home', '0700'], ['app-home', '0700']]);
  const r = applyAppOwnership(rows, APP);
  assert.equal(owner(home.hostPath), '200001:200001');
  assert.equal(owner(join(home.hostPath, 'f')), '200001:200001');
  assert.ok(r.skipped.some((s) => s.includes('no such App Home')));
  assert.equal(existsSync(join(d, 'aura/apphomes/inst-1/users/gone')), false);
});

test('ownership apply: only the approved planned rows, journaled; the journal reverts exactly', async () => {
  const d = tmp();
  const priv = join(d, 'aura/home/default');
  mkdirSync(join(priv, '.claude'), { recursive: true });
  chmodSync(priv, 0o755);
  writeFileSync(join(priv, '.claude/x'), 'x');
  symlinkSync('/etc/hostname', join(priv, 'ln'));
  const ws = join(d, 'ws');
  mkdirSync(join(ws, 'node_modules/p'), { recursive: true });
  writeFileSync(join(ws, 'a.ts'), 'a');
  const dev = join(d, 'devtree');
  mkdirSync(dev);
  const report = await buildOwnershipReport([
    { section: 'planned', path: priv, kind: 'private-home', owner: 'default', to: { uid: 1000, gid: 1000 }, mode: '0700', recursive: true },
    { section: 'planned', path: join(d, 'aura/workspaces/default'), kind: 'user-workspaces', owner: 'default', to: { uid: 1000, gid: 1000 }, recursive: true },
    { section: 'plannedUserPaths', path: ws, kind: 'own-app-source', to: { uid: 1000, gid: 200001 }, mode: 'g+rX, setgid dirs', recursive: true, exclude: ['node_modules'] },
    { section: 'plannedUserPaths', path: dev, kind: 'developer-mode-tree', to: { uid: 1000, gid: 1000 }, recursive: true, only: 'when Developer Mode is on' },
    { section: 'plannedAppPaths', path: join(d, 'appdata'), kind: 'app-data', to: APP, recursive: true },
    { section: 'reportOnly', path: d, kind: 'x', to: null, recursive: false },
  ], { refuseRoots: ['/', d] });
  const { rows, notApplied } = selectApplyRows(report, { holds: () => false });
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['own-app-source', 'private-home']);
  assert.deepEqual(notApplied.map((n) => [n.kind, n.reason]).sort(), [
    ['developer-mode-tree', 'only when Developer Mode is on'], ['user-workspaces', 'does not exist'],
  ]);
  const journal = join(d, 'journal.ndjson');
  const res = applyOwnershipRows(rows, journal);
  assert.ok(res.every((r) => r.changed > 0));
  assert.equal(owner(priv), '1000:1000');
  assert.equal(mode(priv), 0o700);
  assert.equal(owner(join(priv, '.claude/x')), '1000:1000');
  assert.equal(owner(join(priv, 'ln')), '1000:1000', 'the link itself, never its target');
  assert.equal(owner('/etc/hostname'), '0:0');
  assert.equal(owner(join(ws, 'a.ts')), '1000:200001');
  assert.equal(mode(join(ws, 'a.ts')) & 0o040, 0o040, 'g+r');
  assert.equal(mode(ws) & 0o2000, 0o2000, 'setgid dir');
  assert.equal(owner(join(ws, 'node_modules/p')), '0:0', 'excluded');
  assert.equal(mode(journal), 0o600);
  assert.throws(() => applyOwnershipRows(rows, journal), /EEXIST/, 'a journal is never overwritten');
  const rev = revertOwnershipJournal(journal);
  assert.equal(rev.skipped.length, 0);
  assert.equal(owner(priv), '0:0');
  assert.equal(mode(priv), 0o755);
  assert.equal(owner(join(ws, 'a.ts')), '0:0');
  assert.equal(mode(ws) & 0o2000, 0);
});

test('ownership apply runs in a child process, journaled under the data dir', async () => {
  const d = tmp();
  const priv = join(d, 'aura/home/default');
  mkdirSync(priv, { recursive: true });
  writeFileSync(join(priv, 'f'), 'x');
  const r = await runOwnershipApply(d, 'a'.repeat(64), [{ path: priv, kind: 'private-home', to: { uid: 1000, gid: 1000 }, recursive: true, mode: '0700' }]);
  assert.match(r.journal, /aura\/state\/ownership-journal\/.*-aaaaaaaaaaaa\.ndjson$/);
  assert.equal(owner(join(priv, 'f')), '1000:1000');
  assert.equal(mode(priv), 0o700);
  await assert.rejects(runOwnershipApply(d, 'nope', []), /invalid digest/);
});

// ─── the warm pool ────────────────────────────────────────────────────────

test('pool: a member warmed for a user is that user\'s only; one from before App Homes is replaced, never handed out', () => {
  const stopped = [];
  const self = {
    instances: new Map([
      ['t-1', { instanceId: 't-1', appId: 'com.aura.terminal', inPool: true, state: 'resumed', pid: 1 }],
      ['t-2', { instanceId: 't-2', appId: 'com.aura.terminal', inPool: true, state: 'resumed', pid: 2 }],
    ]),
    poolHomes: new Map([['t-2', 'default']]),
    recycling: new Set(),
    instanceAlive: () => true,
    savePoolIds() {},
    registry: { getById: () => null },
    stop: async (id) => { stopped.push(id); },
  };
  self.recycleStalePoolMember = AppManager.prototype.recycleStalePoolMember.bind(self);
  const claim = AppManager.prototype.claimFromPool.bind(self);
  assert.equal(claim('com.aura.terminal', 'u-bob'), null, 'warmed for the owner: never bob\'s');
  assert.deepEqual(stopped, ['t-1'], 'the pre-App-Home member is replaced');
  const got = claim('com.aura.terminal', 'default');
  assert.equal(got.instanceId, 't-2');
  assert.equal(got.owner, 'default');
  // A global App Home ('') is anyone's.
  self.instances.set('g-1', { instanceId: 'g-1', appId: 'org.g', inPool: true, state: 'resumed', pid: 3 });
  self.poolHomes.set('g-1', '');
  assert.equal(claim('org.g', 'u-bob').owner, 'u-bob');
});

test('homeRequirements: plain, serializable data per context and mode (5b requirementsOf, D85 A5)', async () => {
  const { homeRequirements } = await import('../dist/homes/HomeResolver.js');
  const app = homeRequirements({ executionContext: 'application' });
  assert.deepEqual(app, { executionContext: 'application', capabilities: {}, installation: true, principal: false, nonRootTarget: false, jumpAuthorization: false });
  assert.deepEqual(JSON.parse(JSON.stringify(app)), app);
  assert.deepEqual(homeRequirements({ executionContext: 'terminal-session' }).capabilities, { isolation: 'namespace' });
  const priv = homeRequirements({ executionContext: 'jump' });
  assert.deepEqual([priv.jumpHomeMode, priv.capabilities, priv.nonRootTarget], ['private', { sessionExec: true, privateHomeSession: true }, true]);
  const appJump = homeRequirements({ executionContext: 'jump', jumpHomeMode: 'app' });
  assert.deepEqual([appJump.capabilities, appJump.jumpAuthorization, appJump.nonRootTarget], [{ sessionExec: true }, true, false]);
});
