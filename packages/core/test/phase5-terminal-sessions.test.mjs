// Phase 5 stream T (D69): the System Terminal as each user's session host.
// The session identity (the user's uid, never an app's, never root by
// fallback), its passwd name, the spawn args (AURA_SESSION_USER, the tmux
// socket tmpfs), the owner's transition until the ownership apply, another
// user's leftover instance data, adoption and the privilege review.
//
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appIdentityProvider, sessionHostIdentityProvider } from '../dist/identity/appIdentityProvider.js';
import { APP_MIGRATION, buildPrivilegeReview } from '../dist/identity/privilegeReview.js';
import { containerIdentityArgs, identityAccountName, isSessionIdentity, renderIdentityFiles } from '../dist/app-manager/spawn/identityArgs.js';
import { terminalSessionArgs, TERMINAL_RUN_DIR } from '../dist/app-manager/spawn/sessionArgs.js';
import { adoptedIdentity, ownerHomeAwaitsOwnership, retireForeignSessionData } from '../dist/app-manager/AppManager.js';
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
  assert.deepEqual(terminalSessionArgs(TERMINAL, { appDir: '/workspace/apps/com.aura.terminal', owner: 'u2', identity }), [
    '-e', 'AURA_SESSION_USER=u2',
    '--tmpfs', `${TERMINAL_RUN_DIR}:rw,nosuid,nodev,noexec,mode=0700,uid=100000,gid=100000`,
  ]);
  // A pool member (no owner yet) names the user its identity is for.
  assert.ok(terminalSessionArgs(TERMINAL, { appDir: '/workspace/apps/com.aura.terminal', identity }).includes('AURA_SESSION_USER=u2'));
  assert.deepEqual(terminalSessionArgs(TERMINAL, { appDir: '/data/scopes/users/default/apps/com.aura.terminal', owner: 'u2', identity }), [], 'a same-id copy is no session host');
  assert.deepEqual(terminalSessionArgs('com.aura.counter', { appDir: '/workspace/apps/com.aura.counter', owner: 'u2' }), []);
  assert.deepEqual(terminalSessionArgs(TERMINAL, { appDir: '/workspace/apps/com.aura.terminal', owner: '-e X' }), [], 'an unsafe user id adds nothing');
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
