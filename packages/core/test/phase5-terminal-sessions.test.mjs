// Phase 5 stream T (D69): the System Terminal as each user's session host.
// The session identity (the user's uid, never an app's, never root by
// fallback), its passwd name, the spawn args (AURA_SESSION_USER, the tmux
// socket tmpfs), the owner's transition until the ownership apply, another
// user's leftover instance data, adoption and the privilege review.
//
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appIdentityProvider, sessionHostIdentityProvider } from '../dist/identity/appIdentityProvider.js';
import { APP_MIGRATION, buildPrivilegeReview } from '../dist/identity/privilegeReview.js';
import { containerIdentityArgs, identityAccountName, isSessionIdentity, renderIdentityFiles } from '../dist/app-manager/spawn/identityArgs.js';
import { readKernelSessionSecret, sessionSecretSubpath, terminalSessionArgs, writeSessionSecret, SESSION_SECRET_FILE, TERMINAL_RUN_DIR } from '../dist/app-manager/spawn/sessionArgs.js';
import { ASTRO_START_SHELL } from '../dist/app-manager/provisioning.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { SECURITY_OPTIONS } from '../dist/security/options.js';
import { adoptedIdentity, ownerHomeAwaitsOwnership, retireForeignSessionData, terminalRootTransitionOpen, TERMINAL_ROOT_TRANSITION_FILE, TERMINAL_ROOT_TRANSITION_MS } from '../dist/app-manager/AppManager.js';
import { TERMINAL_SESSION_APPS } from '../dist/homes/plan.js';

const TERMINAL = 'com.aura.terminal';

function provider(accounts, identities, base = { identityFor: async () => ({ uid: 0, gid: 0, range: 'root' }) }) {
  return sessionHostIdentityProvider(base, {
    sessionApps: TERMINAL_SESSION_APPS,
    ownerId: 'default',
    account: async (id) => accounts[id] ?? null,
    identity: async (id) => {
      const r = identities[id];
      if (!r) throw new Error('no identity');
      return r;
    },
  });
}

test('T: a Terminal instance runs as its user\'s uid: the owner 1000 (range owner), a member from the user range', async () => {
  const p = provider(
    { default: { username: 'lukas', disabled: false }, u2: { username: 'bob', disabled: false } },
    { default: { uid: 1000, gid: 1000, state: 'active' }, u2: { uid: 100000, gid: 100000, state: 'active' } },
  );
  assert.deepEqual(await p.identityFor({ appId: TERMINAL, installationId: 'i', runAs: 'root', userId: 'default' }),
    { uid: 1000, gid: 1000, range: 'owner', userId: 'default', account: 'lukas' });
  assert.deepEqual(await p.identityFor({ appId: TERMINAL, installationId: 'i', runAs: 'root', userId: 'u2' }),
    { uid: 100000, gid: 100000, range: 'user', userId: 'u2', account: 'bob' });
  // The installation's runAs never decides a session host: not root, not an app uid.
  const viaApp = await p.identityFor({ appId: TERMINAL, installationId: 'i', runAs: 'app', userId: 'u2' });
  assert.equal(viaApp.uid, 100000);
});

test('T: fail closed: no user, an unknown or disabled user, an unallocatable or retired identity; never root', async () => {
  const p = provider(
    { default: { username: 'lukas', disabled: false }, off: { username: 'off', disabled: true }, ret: { username: 'ret', disabled: false }, bad: { username: 'bad', disabled: false } },
    { default: { uid: 1000, gid: 1000, state: 'active' }, ret: { uid: 100001, gid: 100001, state: 'retired' } },
  );
  const req = (userId) => ({ appId: TERMINAL, installationId: 'i', runAs: 'root', ...(userId ? { userId } : {}) });
  await assert.rejects(p.identityFor(req()), /for nobody/);
  await assert.rejects(p.identityFor(req('ghost')), /has no account/);
  await assert.rejects(p.identityFor(req('off')), /disabled/);
  await assert.rejects(p.identityFor(req('ret')), /retired/);
  await assert.rejects(p.identityFor(req('bad')), /could not be allocated/);
});

test('T: every other app keeps its own provider (stream A)', async () => {
  const p = sessionHostIdentityProvider(appIdentityProvider(async () => ({ ensureApp: async () => ({ uid: 200005, gid: 200005, state: 'active' }) })), {
    sessionApps: TERMINAL_SESSION_APPS, ownerId: 'default', account: async () => { throw new Error('not asked'); }, identity: async () => { throw new Error('not asked'); },
  });
  assert.deepEqual(await p.identityFor({ appId: 'com.aura.counter', installationId: 'inst-1', runAs: 'app', userId: 'default' }), { uid: 200005, gid: 200005, range: 'app' });
  assert.deepEqual(await p.identityFor({ appId: 'com.aura.counter', installationId: 'inst-1', runAs: 'root' }), { uid: 0, gid: 0, range: 'root' });
});

test('T: the session identity\'s passwd names the user (pw_dir /home/aura); unsafe or base names become user-<uid>', () => {
  const owner = { uid: 1000, gid: 1000, range: 'owner', userId: 'default', account: 'Lukas' };
  assert.equal(isSessionIdentity(owner), true);
  assert.equal(isSessionIdentity({ uid: 200001, gid: 200001, range: 'app' }), false);
  assert.equal(isSessionIdentity({ uid: 0, gid: 0, range: 'root' }), false);
  assert.equal(identityAccountName(owner, 'inst'), 'lukas');
  assert.equal(identityAccountName({ ...owner, account: 'root' }, null), 'user-1000', 'never a base account name');
  assert.equal(identityAccountName({ ...owner, account: 'a:b' }, null), 'user-1000');
  assert.equal(identityAccountName({ ...owner, account: undefined }, null), 'user-1000');
  const files = renderIdentityFiles(owner, 'inst');
  assert.match(files.passwd, /^lukas:x:1000:1000:AuraOS user:\/home\/aura:\/bin\/bash$/m);
  assert.doesNotMatch(files.passwd, /^node:/m, 'the owner replaces the image\'s uid-1000 entry');
  assert.match(files.passwd, /^root:x:0:0:/m);
  assert.match(files.group, /^lukas:x:1000:$/m);
});

test('T: a session host container: the user\'s uid, no capabilities, AURA_RUN_AS=user', () => {
  const args = containerIdentityArgs({ uid: 100000, gid: 100000, range: 'user', userId: 'u2', account: 'bob' }, { appDataVolume: 'v', instanceId: `${TERMINAL}-2` });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--user'), '100000:100000');
  assert.equal(at('--cap-drop'), 'ALL');
  assert.equal(at('--security-opt'), 'no-new-privileges');
  assert.ok(args.includes('AURA_RUN_AS=user'));
});

test('T: terminalSessionArgs: the built-in Terminal only; its user and the tmux socket tmpfs owned by its uid', () => {
  const identity = { uid: 100000, gid: 100000, range: 'user', userId: 'u2' };
  assert.deepEqual(terminalSessionArgs(TERMINAL, { appDir: '/workspace/apps/com.aura.terminal', owner: 'u2', identity }, { appDataVolume: 'vol', instanceId: `${TERMINAL}-2` }), [
    '-e', 'AURA_SESSION_USER=u2',
    '--tmpfs', `${TERMINAL_RUN_DIR}:rw,nosuid,nodev,noexec,mode=0700,uid=100000,gid=100000`,
    '-e', 'AURA_SERVER_SEALED=1',
    '--mount', `type=volume,source=vol,target=/run/aura-secret,volume-subpath=${sessionSecretSubpath(`${TERMINAL}-2`)}`,
    '-e', `AURA_LIFECYCLE_TOKEN_FILE=${SESSION_SECRET_FILE}`,
  ]);
  // A pool member (no owner yet) names the user its identity is for.
  assert.ok(terminalSessionArgs(TERMINAL, { appDir: '/workspace/apps/com.aura.terminal', identity }).includes('AURA_SESSION_USER=u2'));
  assert.deepEqual(terminalSessionArgs(TERMINAL, { appDir: '/data/scopes/users/default/apps/com.aura.terminal', owner: 'u2', identity }), [], 'a same-id copy is no session host');
  assert.deepEqual(terminalSessionArgs('com.aura.counter', { appDir: '/workspace/apps/com.aura.counter', owner: 'u2' }), []);
  assert.deepEqual(terminalSessionArgs(TERMINAL, { appDir: '/workspace/apps/com.aura.terminal', owner: '-e X' }), [], 'an unsafe user id adds nothing');
});

test('T: the root transition is a deploy window only: a root-owned `deploy` switch file under 6 h old; anything else closed', () => {
  const now = 1_000_000_000_000;
  const io = (o) => ({ lstat: () => (o.missing ? null : { isFile: () => !o.dir, isSymbolicLink: () => !!o.link, uid: o.uid ?? 0, mtimeMs: o.mtime ?? now - 1000 }), read: () => o.text ?? 'deploy\n' });
  assert.equal(terminalRootTransitionOpen('/d', now, io({})), true);
  assert.equal(terminalRootTransitionOpen('/d', now, io({ missing: true })), false, 'no file: closed (the supported mode)');
  assert.equal(terminalRootTransitionOpen('/d', now, io({ mtime: now - TERMINAL_ROOT_TRANSITION_MS - 1 })), false, 'expired');
  assert.equal(terminalRootTransitionOpen('/d', now, io({ mtime: now + 120_000 })), false, 'from the future');
  assert.equal(terminalRootTransitionOpen('/d', now, io({ uid: 1000 })), false, 'not root\'s: a user can\'t open it');
  assert.equal(terminalRootTransitionOpen('/d', now, io({ link: true })), false);
  assert.equal(terminalRootTransitionOpen('/d', now, io({ dir: true })), false);
  assert.equal(terminalRootTransitionOpen('/d', now, io({ text: 'off' })), false);
  const opt = SECURITY_OPTIONS.find((o) => o.id === 'terminal-root-transition');
  assert.equal(opt.default, 'off');
  assert.equal(opt.source, 'file');
  assert.equal(opt.file, TERMINAL_ROOT_TRANSITION_FILE);
  assert.equal(opt.env, undefined, 'no host variable can open it beyond the window');
});

test('T: a sealed session host serves its production build only, from the execute-only node; else exit 78', () => {
  const at = ASTRO_START_SHELL.indexOf('AURA_SERVER_SEALED');
  assert.ok(at > 0 && at < ASTRO_START_SHELL.indexOf('dev --host'), 'decided before any dev server');
  assert.match(ASTRO_START_SHELL, /AURA_SERVE:-dev\}" != prod \] \|\| \[ ! -f dist\/server\/entry\.mjs \];\s*then[^]*?exit 78/);
  assert.match(ASTRO_START_SHELL, /\/usr\/local\/bin\/node-sealed \];\s*then[^]*?exit 78/);
  assert.match(ASTRO_START_SHELL, /exec "\$NODE_BIN" server\.mjs/);
  const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf-8');
  assert.match(dockerfile, /install -m 0111 -o root -g root \/usr\/local\/bin\/node \/usr\/local\/bin\/node-sealed/, 'aura-base ships it execute-only');
});

test('T: a session host gets its lifecycle token as a one-time file, never in its container env', { skip: process.getuid?.() !== 0 && 'needs root to chown' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-t-sec-'));
  try {
    const dataDir = join(root, 'data');
    writeSessionSecret(dataDir, `${TERMINAL}-4`, 'lt-secret-1', { uid: 1000, gid: 1000 });
    const dir = join(dataDir, sessionSecretSubpath(`${TERMINAL}-4`));
    const f = lstatSync(join(dir, 'lifecycle-token'));
    assert.equal(f.uid, 1000); assert.equal(f.mode & 0o777, 0o400);
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    const k = lstatSync(join(dataDir, 'aura/runtime', `${TERMINAL}-4`, 'lifecycle-token.kernel'));
    assert.equal(k.uid, 0); assert.equal(k.mode & 0o777, 0o600);
    assert.equal(readKernelSessionSecret(dataDir, `${TERMINAL}-4`), 'lt-secret-1', 'a shell restart re-learns it');
    writeSessionSecret(dataDir, `${TERMINAL}-4`, 'lt-secret-2', { uid: 1000, gid: 1000 });
    assert.equal(readFileSync(join(dir, 'lifecycle-token'), 'utf-8'), 'lt-secret-2', 'replaced at the next start');
    rmSync(dir, { recursive: true });
    symlinkSync('/etc', dir);
    assert.throws(() => writeSessionSecret(dataDir, `${TERMINAL}-4`, 'x', { uid: 1000, gid: 1000 }), /not a directory/);

    // The container: the token's name only for an ordinary app; nothing for the session host.
    const appDir = join(dataDir, 'scopes/system/apps/com.aura.terminal');
    mkdirSync(join(appDir, `${TERMINAL}-1`), { recursive: true });
    const runner = new ContainerRunner({ baseRootfs: root, toolchainDir: join(root, 'tc'), appsDir: join(root, 'apps'), dataDir, osApiBase: 'http://aura-shell:3000' });
    Object.assign(runner, { appDataVolume: 'v', nodeModulesVolume: 'n' });
    const home = { kind: 'private', hostPath: '/x', volumeSubpath: 'aura/home/default', logicalPath: '/home/aura', uid: 1000, gid: 1000, mode: 0o700 };
    const args = (id, dir) => runner.buildDockerArgs(`${id}-1`, id, 4000, { id, entrypoint: 'server.mjs', tools: [], sandbox: 'container' }, `aura-${id}-1`,
      { appDir: dir, instanceDataDir: join(appDir, `${TERMINAL}-1`), home, identity: { uid: 1000, gid: 1000, range: 'owner', userId: 'default' } }, {}, []);
    const term = args(TERMINAL, '/workspace/apps/com.aura.terminal');
    assert.ok(!term.includes('AURA_LIFECYCLE_TOKEN'), 'no lifecycle token in the session host\'s env');
    assert.ok(term.includes(`AURA_LIFECYCLE_TOKEN_FILE=${SESSION_SECRET_FILE}`));
    assert.ok(term.includes('AURA_SERVER_SEALED=1'));
    assert.ok(args('com.aura.counter', '/workspace/apps/com.aura.counter').includes('AURA_LIFECYCLE_TOKEN'), 'an ordinary app keeps it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T: the owner\'s Terminal waits for the ownership apply only while the owner\'s Private Home is root\'s; never a member\'s', () => {
  const home = { kind: 'private', hostPath: '/data/aura/home/default' };
  assert.equal(ownerHomeAwaitsOwnership(home, 'default', () => ({ uid: 0 })), true);
  assert.equal(ownerHomeAwaitsOwnership(home, 'default', () => ({ uid: 1000 })), false, 'after the apply');
  assert.equal(ownerHomeAwaitsOwnership(home, 'u2', () => ({ uid: 0 })), false, 'a member never runs as root');
  assert.equal(ownerHomeAwaitsOwnership({ kind: 'app-global', hostPath: '/x' }, 'default', () => ({ uid: 0 })), false);
  assert.equal(ownerHomeAwaitsOwnership(home, 'default', () => null), false, 'no home yet: created the owner\'s');
});

test('T: a reused instance id never hands one user\'s session data to another', { skip: process.getuid?.() !== 0 && 'needs root to chown' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-t-'));
  try {
    const dir = join(root, `${TERMINAL}-3`);
    mkdirSync(join(dir, 'scrollback'), { recursive: true });
    writeFileSync(join(dir, 'launch-commands.json'), '{"x":"rm -rf ~"}');
    chownSync(dir, 100000, 100000);
    assert.equal(retireForeignSessionData(dir, 100000), null, 'its own user: kept');
    const aside = retireForeignSessionData(dir, 1000, 42);
    assert.ok(aside && aside.endsWith(`.${TERMINAL}-3.retired-100000-42`));
    assert.deepEqual(readdirSync(dir), [], 'the new user starts empty');
    assert.ok(existsSync(join(aside, 'launch-commands.json')));
    assert.equal(statSync(aside).mode & 0o777, 0o700);
    // Root-owned: from before stream T, the owner's.
    chownSync(dir, 0, 0);
    writeFileSync(join(dir, 'session-cwd.json'), '{}');
    assert.equal(retireForeignSessionData(dir, 1000), null);
    assert.ok(existsSync(join(dir, 'session-cwd.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T: adoption reads a user\'s uid as a session host (runAs user), an app uid as app', () => {
  assert.deepEqual(adoptedIdentity('1000:1000'), { runAs: 'user', uid: 1000, gid: 1000 });
  assert.deepEqual(adoptedIdentity('100004:100004'), { runAs: 'user', uid: 100004, gid: 100004 });
  assert.deepEqual(adoptedIdentity('200001:200001'), { runAs: 'app', uid: 200001, gid: 200001 });
  assert.deepEqual(adoptedIdentity(''), { runAs: 'root', uid: 0, gid: 0 });
});

test('T: the privilege review records the Terminal as a session host: non-root, no elevated privileges, any user\'s uid', () => {
  assert.equal(APP_MIGRATION[TERMINAL].expect, 'session-host');
  const rv = buildPrivilegeReview([{
    appId: TERMINAL, scope: 'system', installationId: 'i', runAs: 'root', identity: null, needs: [],
    instances: [{ instanceId: `${TERMINAL}-1`, uid: 1000 }, { instanceId: `${TERMINAL}-2`, uid: 100000 }],
  }]);
  assert.equal(rv.rows[0].verdict, 'app');
  assert.deepEqual(rv.rows[0].elevated, []);
  assert.deepEqual(rv.rows[0].mismatched, []);
});

test('T recovery: an apply is reverted from its journal by name only; owner and mode come back exactly', { skip: process.getuid?.() !== 0 && 'needs root to chown' }, async () => {
  const { ownershipJournalPath, ownershipJournalDir, applyOwnershipRows, revertOwnershipJournal } = await import('../dist/identity/ownershipApply.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-t-rev-'));
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}', { mode: 0o600 });
    const dir = ownershipJournalDir(root);
    mkdirSync(dir, { recursive: true });
    const journal = join(dir, 'apply-test-1.jsonl');
    applyOwnershipRows([{ path: home, kind: 'private-home', to: { uid: 1000, gid: 1000 }, recursive: true }], journal);
    assert.equal(statSync(join(home, '.claude', '.credentials.json')).uid, 1000);
    assert.equal(statSync(join(home, '.claude', '.credentials.json')).mode & 0o777, 0o600, 'credential modes kept');
    assert.equal(ownershipJournalPath(root, 'apply-test-1.jsonl'), journal);
    assert.equal(ownershipJournalPath(root, '../../etc/passwd'), null, 'a name, never a path out of the journal dir');
    assert.equal(ownershipJournalPath(root, 'missing.jsonl'), null);
    const r = revertOwnershipJournal(ownershipJournalPath(root, 'apply-test-1.jsonl'));
    assert.ok(r.restored >= 3);
    assert.equal(statSync(join(home, '.claude', '.credentials.json')).uid, 0);
    assert.equal(statSync(join(home, '.claude', '.credentials.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
