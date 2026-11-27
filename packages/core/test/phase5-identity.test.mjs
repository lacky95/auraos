// Phase 5 stream I and I.2 part 1: the Linux identity registry, passwd, the
// read-only reports, the v2 user records, the `user` grant subject and the
// D85 A1/A3 guards. Against a REAL valkey-server (KvServer on a tmp dataDir).
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import {
  AdminAudit, Authorizer, FileSetupTickets, GENERATED_USER_ID_PATTERN, GrantError, GrantStore, LoginSessionStore,
  OWNER_RECORD_KEY, USER_ID_PATTERN, UserStoreError, ValkeyUserStore, createSetupTicket, defaultIdentityKeyFile,
  defaultSetupTicketDir, deriveIdentitySubkey, generateUserId, isForeignPrincipal, operatorAttribution, userRecordKey,
  usernameIndexKey,
} from '../dist/auth/index.js';
import {
  LinuxIdentityStore, LinuxIdentityError, identityNextKey, identityUidKey, identityUserKey,
} from '../dist/identity/LinuxIdentityStore.js';
import { LINUX_ID_RANGES, formatPrincipalRef } from '../dist/identity/types.js';
import { appAccountName, renderGroup, renderPasswd } from '../dist/identity/passwd.js';
import { buildOwnershipReport } from '../dist/identity/ownershipReport.js';
import { buildImportReport, PERSONAL_NOTE } from '../dist/homes/importReport.js';
import { loadHomeImportMarkers, parseHomeImportMarkers, HomeImportMarkersError } from '../dist/homes/importMarkers.js';

const SHIPPED_MARKERS = new URL('../../../os/home-import/markers.json', import.meta.url).pathname;
import { homePlan, planHomeTarget } from '../dist/homes/plan.js';
import { HomeDeniedError } from '../dist/homes/types.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-p5i-'));
const PASSWORD = 'correct horse battery';
const server = new KvServer();
let redis;
let clock = 1_800_000_000_000;
const now = () => clock;
const r = () => redis;

before(async () => {
  const uri = await server.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
});

after(async () => {
  redis?.disconnect();
  await server.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  clock += 120_000;
  await redis.flushdb();
});

const fresh = (name) => mkdtempSync(join(DATA_DIR, `${name}-`));
const identityStore = (dir = fresh('id')) => new LinuxIdentityStore({ redis: r, hwmFile: join(dir, 'hwm.json'), now });

// ── LinuxIdentityStore (D70, D84) ───────────────────────────────────────────

test('the owner is fixed at 1000:1000; allocation is idempotent', async () => {
  const ids = identityStore();
  const owner = await ids.ensureUser('default');
  assert.deepEqual({ uid: owner.uid, gid: owner.gid, state: owner.state }, { uid: 1000, gid: 1000, state: 'active' });
  assert.deepEqual(await ids.ensureUser('default'), owner);
  assert.equal(await redis.get(identityUidKey(1000)), 'user:default');
  const a = await ids.ensureUser('uabcdefghijklmno');
  assert.equal(a.uid, LINUX_ID_RANGES.user.first);
  assert.deepEqual(await ids.ensureUser('uabcdefghijklmno'), a);
  const app = await ids.ensureApp('3f1c2e7a-0000-4000-8000-000000000001', 'com.example.hello');
  assert.equal(app.uid, LINUX_ID_RANGES.app.first);
  assert.equal(await redis.get(identityUidKey(app.uid)), 'app:3f1c2e7a-0000-4000-8000-000000000001');
  assert.deepEqual((await ids.check()).findings, []);
});

test('100 parallel allocations (two stores sharing one mark) give unique uids in range', async () => {
  const dir = fresh('par');
  const a = identityStore(dir);
  const b = identityStore(dir); // a second "process": its own serialization, the same Valkey and mark
  const jobs = [];
  for (let i = 0; i < 50; i++) {
    const s = i % 2 ? a : b;
    jobs.push(s.ensureUser(`u${String(i).padStart(15, 'a')}`.slice(0, 16)));
    jobs.push(s.ensureApp(`inst-${i}`, 'com.example.app'));
  }
  // Same ids again, concurrently: still one record each.
  for (let i = 0; i < 10; i++) jobs.push(a.ensureUser(`u${String(i).padStart(15, 'a')}`.slice(0, 16)));
  const recs = await Promise.all(jobs);
  const users = new Map(); const apps = new Map();
  for (const rec of recs) (rec.userId ? users : apps).set(rec.userId ?? rec.installationId, rec.uid);
  assert.equal(users.size, 50);
  assert.equal(apps.size, 50);
  const all = [...users.values(), ...apps.values()];
  assert.equal(new Set(all).size, 100, 'no uid handed out twice');
  for (const uid of users.values()) assert.ok(uid >= 100_000 && uid <= 199_999);
  for (const uid of apps.values()) assert.ok(uid >= 200_000 && uid <= 299_999);
  const check = await a.check();
  assert.deepEqual(check.findings, []);
  assert.equal(check.users, 50);
  assert.ok(check.hwm.user >= Math.max(...users.values()));
});

test('the high-water mark wins after a simulated Valkey rollback', async () => {
  const ids = identityStore();
  const first = await ids.ensureUser('uaaaaaaaaaaaaaaa');
  const second = await ids.ensureUser('ubbbbbbbbbbbbbbb');
  // An older Valkey: none of the identity keys exist any more.
  for (const k of await redis.keys('ident:linux:*')) await redis.del(k);
  const third = await ids.ensureUser('uccccccccccccccc');
  assert.ok(third.uid > second.uid && second.uid > first.uid, `${third.uid} after ${second.uid}`);
  const app = await ids.ensureApp('inst-1', 'com.example.app');
  for (const k of await redis.keys('ident:linux:*')) await redis.del(k);
  assert.ok((await ids.ensureApp('inst-2', 'com.example.app')).uid > app.uid);
});

test('tombstones block reuse even when the counter and the mark go back', async () => {
  const dir = fresh('tomb');
  const ids = identityStore(dir);
  const a = await ids.ensureUser('uaaaaaaaaaaaaaaa');
  assert.equal(await ids.retire('user', 'uaaaaaaaaaaaaaaa'), true);
  assert.equal((await ids.getUser('uaaaaaaaaaaaaaaa')).state, 'retired');
  assert.equal(await redis.get(identityUidKey(a.uid)), 'user:uaaaaaaaaaaaaaaa', 'the tombstone stays');
  // The counter and the mark both forget it: only the tombstone remembers.
  await redis.set(identityNextKey('user'), String(LINUX_ID_RANGES.user.first));
  writeFileSync(join(dir, 'hwm.json'), JSON.stringify({ user: 0, app: 0 }));
  const b = await ids.ensureUser('ubbbbbbbbbbbbbbb');
  assert.notEqual(b.uid, a.uid);
  assert.ok(b.uid > a.uid);
});

test('no allocation without a durable mark; a corrupt mark refuses; the mark file is private', async () => {
  const dir = fresh('hwm');
  const ids = identityStore(dir);
  await ids.ensureUser('uaaaaaaaaaaaaaaa');
  assert.equal(statSync(join(dir, 'hwm.json')).mode & 0o777, 0o600);
  writeFileSync(join(dir, 'hwm.json'), '{not json');
  await assert.rejects(ids.ensureUser('ubbbbbbbbbbbbbbb'), (e) => e instanceof LinuxIdentityError && e.code === 'corrupt');
  assert.equal(await redis.get(identityUserKey('ubbbbbbbbbbbbbbb')), null);
  if (process.getuid?.() !== 0) {
    const ro = fresh('ro');
    chmodSync(ro, 0o500);
    const blocked = new LinuxIdentityStore({ redis: r, hwmFile: join(ro, 'sub', 'hwm.json'), now });
    await assert.rejects(blocked.ensureUser('ucccccccccccccccc'.slice(0, 16)), (e) => e.code === 'hwm-unwritable');
    assert.equal(await redis.get(identityUserKey('ucccccccccccccccc'.slice(0, 16))), null);
  }
  assert.throws(() => ids.ensureUser('Not-Valid'), (e) => e.code === 'invalid-id');
});

test('check() reports a broken tombstone and a uid held twice', async () => {
  const ids = identityStore();
  const a = await ids.ensureUser('uaaaaaaaaaaaaaaa');
  await redis.set(identityUidKey(a.uid), 'user:someoneelse');
  await redis.set(identityUserKey('ubbbbbbbbbbbbbbb'), JSON.stringify({ userId: 'ubbbbbbbbbbbbbbb', uid: a.uid, gid: a.uid, allocatedAt: 'x', state: 'active' }));
  const { findings } = await ids.check();
  assert.ok(findings.some((f) => /tombstone names another principal/.test(f)), findings.join('\n'));
  assert.ok(findings.some((f) => /held by/.test(f)), findings.join('\n'));
});

test('the tombstone is the generic principal ref (D84: an open kind)', () => {
  assert.equal(formatPrincipalRef({ kind: 'agent', id: 'x1' }), 'agent:x1');
  assert.equal(LINUX_ID_RANGES.principal.first, 400_000);
});

// ── passwd ───────────────────────────────────────────────────────────────────

test('renderPasswd maps uid 1000 to the owner with pw_dir=/home/aura; deterministic; refuses injection', () => {
  const base = 'root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n';
  const entries = [
    { name: 'app-3f1c2e7a0000', uid: 200000, gid: 200000, shell: '/usr/sbin/nologin' },
    { name: 'lukas', uid: 1000, gid: 1000 },
  ];
  const out = renderPasswd(base, entries);
  assert.equal(out, 'root:x:0:0:root:/root:/bin/bash\nlukas:x:1000:1000::/home/aura:/bin/bash\napp-3f1c2e7a0000:x:200000:200000::/home/aura:/usr/sbin/nologin\n');
  assert.equal(renderPasswd(base, [...entries].reverse()), out);
  assert.throws(() => renderPasswd(base, [{ name: 'x:0:0', uid: 5, gid: 5 }]));
  assert.throws(() => renderPasswd(base, [{ name: 'evil', uid: 5, gid: 5, gecos: 'a\nroot::0:0' }]));
  assert.throws(() => renderPasswd(base, [{ name: 'a', uid: 7, gid: 7 }, { name: 'b', uid: 7, gid: 7 }]));
  const groups = renderGroup('root:x:0:\nnode:x:1000:\n', [{ name: 'lukas', gid: 1000, members: ['lukas'] }]);
  assert.equal(groups, 'root:x:0:\nlukas:x:1000:lukas\n');
  assert.equal(appAccountName('3f1c2e7a-0000-4000-8000-000000000001'), 'app-3f1c2e7a0000');
});

// ── the dry-run ownership report ────────────────────────────────────────────

function tree() {
  const root = fresh('tree');
  mkdirSync(join(root, 'home', 'default', '.claude'), { recursive: true });
  writeFileSync(join(root, 'home', 'default', '.claude', 'x.json'), '12345');
  mkdirSync(join(root, 'ws', '.git', 'objects'), { recursive: true });
  writeFileSync(join(root, 'ws', '.git', 'objects', 'a'), 'aa');
  writeFileSync(join(root, 'ws', 'file.ts'), 'abc');
  mkdirSync(join(root, 'ws', 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'ws', 'node_modules', 'pkg', 'i.js'), 'x');
  symlinkSync(join(root, 'home'), join(root, 'link'));
  return root;
}

test('the ownership report: deterministic, read-only, refuses blanket and symlinked roots, excludes node_modules', async () => {
  const root = tree();
  const me = { uid: process.getuid(), gid: process.getgid() };
  const specs = [
    { section: 'planned', path: join(root, 'home', 'default'), kind: 'private-home', owner: 'default', to: { uid: 1000, gid: 1000 }, mode: '0700', recursive: true },
    { section: 'plannedUserPaths', path: join(root, 'ws'), kind: 'developer-mode-tree', to: { uid: 1000, gid: 1000 }, recursive: true, exclude: ['node_modules'], only: 'when Developer Mode is on', splitGit: true },
    { section: 'plannedAppPaths', path: join(root, 'appdata'), kind: 'app-data', owner: 'inst-1', to: null, recursive: true },
    { section: 'planned', path: root, kind: 'everything', to: me, recursive: true },
    { section: 'planned', path: join(root, 'link'), kind: 'private-home', to: me, recursive: true },
  ];
  const before = readFileSync(join(root, 'home', 'default', '.claude', 'x.json'), 'utf8');
  const opts = { refuseRoots: [root, '/'], now };
  const a = await buildOwnershipReport(specs, opts);
  const b = await buildOwnershipReport([...specs].reverse(), { ...opts, now: () => clock + 1 });
  assert.equal(a.digest, b.digest, 'same tree, same digest, whatever the time or order');
  assert.deepEqual(a.refused.map((x) => x.path).sort(), ['/', join(root, 'link'), root].sort());
  assert.ok(a.refused.find((x) => x.path === root).reason.includes('no blanket chown'));
  const home = a.planned.find((x) => x.kind === 'private-home');
  assert.equal(home.files, 1);
  assert.equal(home.bytes, 5);
  assert.equal(home.entries, 3);
  assert.equal(home.toChange, process.getuid() === 1000 ? 0 : 3);
  const ws = a.plannedUserPaths[0];
  assert.equal(ws.files, 2, 'node_modules is excluded');
  assert.deepEqual(ws.exclude, ['node_modules']);
  assert.equal(typeof ws.rootOwnedGit, 'number');
  const app = a.plannedAppPaths[0];
  assert.equal(app.exists, false);
  assert.equal(app.to, null);
  assert.equal(readFileSync(join(root, 'home', 'default', '.claude', 'x.json'), 'utf8'), before);
  writeFileSync(join(root, 'home', 'default', 'new'), 'n');
  assert.notEqual((await buildOwnershipReport(specs, opts)).digest, a.digest, 'a changed tree changes the digest');
});

test('the ownership report flags nested rows and truncated walks', async () => {
  const root = tree();
  const to = { uid: 1000, gid: 1000 };
  const rep = await buildOwnershipReport([
    { section: 'planned', path: join(root, 'home'), kind: 'a', to, recursive: true },
    { section: 'planned', path: join(root, 'home', 'default'), kind: 'b', to, recursive: true },
  ], { refuseRoots: [], maxEntries: 2 });
  assert.ok(rep.findings.some((f) => f.includes('lies inside')));
  assert.ok(rep.planned.some((row) => row.truncated));
  // Across sections: a planned app-data row inside a closed source tree that must stay as it is.
  const cross = await buildOwnershipReport([
    { section: 'reportOnly', path: join(root, 'ws'), kind: 'app-source', to: null, recursive: false },
    { section: 'plannedAppPaths', path: join(root, 'ws'), kind: 'app-data', to, recursive: true },
  ], { refuseRoots: [] });
  assert.ok(cross.findings.some((f) => f.includes('is also')), cross.findings.join('\n'));
});

// ── the home import report (Q15) ────────────────────────────────────────────

test('the import report: static table plus granted tools, personal credentials marked, nothing read', async () => {
  const home = fresh('home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"secret":"never read"}');
  writeFileSync(join(home, '.claude.json'), '{}');
  mkdirSync(join(home, '.config', 'glab-cli'), { recursive: true });
  writeFileSync(join(home, '.config', 'glab-cli', 'config.yml'), 'token: x');
  writeFileSync(join(home, '.gitconfig'), '[user]');
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'k');
  const rep = await buildImportReport(home, [
    { installationId: 'i-board', appId: 'io.lakner.improvementboard' },
    { installationId: 'i-x', appId: 'io.lakner.terminalx', tools: ['ssh', 'git'] },
    { installationId: 'i-n', appId: 'com.example.none' },
  ], { now, markers: loadHomeImportMarkers({ AURA_HOME_IMPORT_MARKERS: SHIPPED_MARKERS }) });
  const board = rep.installations.find((i) => i.appId === 'io.lakner.improvementboard');
  assert.deepEqual(board.candidates.map((c) => c.path), ['.claude', '.claude.json']);
  const claude = board.candidates.find((c) => c.path === '.claude');
  assert.deepEqual(claude.personal, ['.claude/.credentials.json']);
  assert.equal(claude.note, PERSONAL_NOTE);
  const x = rep.installations.find((i) => i.appId === 'io.lakner.terminalx');
  assert.deepEqual(x.candidates.map((c) => [c.path, c.source]), [['.config/glab-cli', 'static'], ['.gitconfig', 'static'], ['.ssh', 'tool']]);
  assert.ok(x.candidates.find((c) => c.path === '.ssh').personal.length > 0);
  assert.deepEqual(rep.installations.find((i) => i.appId === 'com.example.none').candidates, []);
  assert.ok(!JSON.stringify(rep).includes('never read'));
});

test('import markers are data (audit #11, N1): validated; missing or invalid refuses, never an empty personal list', () => {
  assert.throws(() => loadHomeImportMarkers({ AURA_HOME_IMPORT_MARKERS: '/nonexistent/markers.json' }), HomeImportMarkersError);
  assert.throws(() => parseHomeImportMarkers({ apps: {}, tools: {} }), /personal/);
  assert.throws(() => parseHomeImportMarkers({ personal: ['../etc/passwd'] }), HomeImportMarkersError);
  assert.throws(() => parseHomeImportMarkers({ personal: ['/abs'] }), HomeImportMarkersError);
  const m = parseHomeImportMarkers({ personal: ['.ssh'], tools: { ssh: ['.ssh'] } });
  assert.deepEqual([m.apps, m.tools, m.personal], [{}, { ssh: ['.ssh'] }, ['.ssh']]);
  assert.ok(loadHomeImportMarkers({ AURA_HOME_IMPORT_MARKERS: SHIPPED_MARKERS }).personal.length > 0);
});

// ── the Home Resolver in report mode ────────────────────────────────────────

test('planHomeTarget: App Homes for apps, Private Homes only for a verified user, fail closed', () => {
  const d = '/data';
  assert.equal(planHomeTarget(d, { installationId: 'i1', environmentScope: 'global', executionContext: 'application' }).hostPath, '/data/aura/apphomes/i1/global');
  assert.equal(planHomeTarget(d, { installationId: 'i1', environmentScope: 'user', executionContext: 'sidecar', userId: 'default' }).hostPath, '/data/aura/apphomes/i1/users/default');
  const t = planHomeTarget(d, { installationId: 'i1', environmentScope: 'global', executionContext: 'terminal-session', principal: { userId: 'default', role: 'owner' } });
  assert.deepEqual({ kind: t.kind, hostPath: t.hostPath }, { kind: 'private', hostPath: '/data/aura/home/default' });
  const reason = (req) => { try { planHomeTarget(d, req); return null; } catch (e) { assert.ok(e instanceof HomeDeniedError); return e.reason; } };
  assert.equal(reason({ installationId: null, environmentScope: 'global', executionContext: 'application' }), 'installation-unresolved');
  assert.equal(reason({ installationId: 'i1', environmentScope: 'user', executionContext: 'application' }), 'user-required');
  assert.equal(reason({ installationId: 'i1', environmentScope: 'global', executionContext: 'application', principal: { userId: 'default', role: 'owner' } }), 'private-home-not-allowed');
  assert.equal(reason({ installationId: 'i1', environmentScope: 'global', executionContext: 'jump' }), 'user-required');
  assert.equal(reason({ installationId: 'i1', environmentScope: 'global', executionContext: 'jump', userId: 'uother', principal: { userId: 'default', role: 'owner' } }), 'not-authorized');
  assert.equal(planHomeTarget(d, { installationId: 'i1', environmentScope: 'global', executionContext: 'jump', jumpHomeMode: 'ephemeral', principal: { userId: 'default', role: 'member' } }).hostPath, null);
});

test('homePlan: today against the target, per instance', () => {
  const rep = homePlan('/data', [
    { instanceId: 'b', appId: 'com.example.notes', installationId: 'i2', environmentScope: 'global', owner: 'default', currentHostPath: '/data/aura/home/default' },
    { instanceId: 'a', appId: 'com.aura.terminal', installationId: 'i1', environmentScope: 'global', owner: 'default', currentHostPath: '/data/aura/home/default' },
    { instanceId: 'c', appId: 'com.example.lost', installationId: null, environmentScope: 'global', owner: 'default', currentHostPath: '/data/aura/home/default' },
  ], { now });
  assert.deepEqual(rep.rows.map((x) => [x.appId, x.change]), [['com.aura.terminal', 'same'], ['com.example.lost', 'denied'], ['com.example.notes', 'moves']]);
  assert.deepEqual(rep.summary, { same: 1, moves: 1, denied: 1 });
  assert.equal(rep.mode, 'report');
});

// ── user records v2 (I.2) ───────────────────────────────────────────────────

function accounts(extra = {}) {
  const dataDir = fresh('acct');
  mkdirSync(join(dataDir, 'aura', 'secrets'), { recursive: true });
  const identityKeyFile = defaultIdentityKeyFile(dataDir);
  const sessions = new LoginSessionStore({ identityKeyFile, redis: r, now });
  const audit = new AdminAudit(r, now, () => 'sys-test');
  const identity = new LinuxIdentityStore({ redis: r, hwmFile: join(dataDir, 'aura', 'identity', 'hwm.json'), now });
  const users = new ValkeyUserStore({ identityKeyFile, redis: r, now, sessions, audit, identity, ...extra });
  const tickets = new FileSetupTickets({ dir: defaultSetupTicketDir(dataDir), now });
  const claim = (input) => tickets.claim(createSetupTicket(dataDir, { purpose: 'reset', ...input }, now).code, 'reset');
  return { dataDir, identityKeyFile, sessions, audit, identity, users, claim };
}

/** The record the pre-I.2 store wrote: no `v`, a MAC over the fixed owner key. */
function v1Record(identityKeyFile, u) {
  const key = deriveIdentitySubkey(identityKeyFile, 'user-record');
  const mac = createHmac('sha256', key).update(JSON.stringify([OWNER_RECORD_KEY, u.id, u.username, u.passwordHash, u.role, u.createdAt, u.disabled])).digest('base64url');
  return JSON.stringify({ ...u, mac });
}

test('a v1 owner record is read, re-sealed as v2 at boot and indexed; a bad MAC stays untrusted', async () => {
  const { identityKeyFile, users } = accounts();
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const { v, mac, externalIdentities, ...v1 } = JSON.parse(await redis.get(OWNER_RECORD_KEY));
  assert.equal(v, 2);
  assert.deepEqual(externalIdentities, []);
  await redis.set(OWNER_RECORD_KEY, v1Record(identityKeyFile, v1));
  await redis.del(usernameIndexKey('lukas'));
  assert.equal((await users.getOwner()).username, 'lukas', 'v1 still reads');
  assert.equal((await users.verifyPassword('lukas', PASSWORD, { rateLimitKey: 'a' })).ok, true, 'login works before the migration');
  const m = await users.migrateRecords();
  assert.deepEqual(m, { resealed: true, indexed: 1, owner: 'v2', conflicts: 0 });
  assert.equal(JSON.parse(await redis.get(OWNER_RECORD_KEY)).v, 2);
  assert.equal(await redis.get(usernameIndexKey('lukas')), 'default');
  assert.deepEqual(await users.migrateRecords(), { resealed: false, indexed: 0, owner: 'v2', conflicts: 0 }, 'idempotent');
  assert.deepEqual((await users.checkAccounts()).findings, []);

  const raw = JSON.parse(v1Record(identityKeyFile, v1));
  await redis.set(OWNER_RECORD_KEY, JSON.stringify({ ...raw, username: 'mallory' }));
  const bad = await redis.get(OWNER_RECORD_KEY);
  assert.equal((await users.migrateRecords()).owner, 'untrusted');
  assert.equal(await redis.get(OWNER_RECORD_KEY), bad, 'a tampered record is left as it is');
  assert.equal(await users.getOwner(), null);
});

test('unseal refuses a planted external identity, an owner without a password and a moved record', async () => {
  const { users } = accounts();
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const good = JSON.parse(await redis.get(OWNER_RECORD_KEY));
  await redis.set(OWNER_RECORD_KEY, JSON.stringify({ ...good, externalIdentities: [{ issuer: 'https://idp', subject: 'x' }] }));
  assert.equal(await users.getOwner(), null, 'a non-empty externalIdentities never unseals');
  await redis.set(OWNER_RECORD_KEY, JSON.stringify({ ...good, passwordHash: null }));
  assert.equal(await users.getOwner(), null, 'an owner without a password never unseals');
  await redis.set(OWNER_RECORD_KEY, JSON.stringify(good));
  // The same sealed bytes under another id do not verify (the MAC binds the key).
  await redis.set(userRecordKey('uaaaaaaaaaaaaaaa'), JSON.stringify(good));
  assert.equal(await users.getUser('uaaaaaaaaaaaaaaa'), null);
  assert.equal((await users.getOwner()).username, 'lukas');
});

test('createUser: a member with a generated id, no password, an index entry and a Linux identity; never an owner', async () => {
  const { users, identity, audit } = accounts();
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const by = operatorAttribution();
  await assert.rejects(users.createUser({ username: 'boss', role: 'owner' }, by), (e) => e instanceof UserStoreError && e.code === 'invalid-role');
  const results = await Promise.all([1, 2, 3, 4].map(() => users.createUser({ username: 'Bob' }, by)));
  assert.equal(results.filter((x) => x.created).length, 1, 'one user per username');
  assert.equal(new Set(results.map((x) => x.user.id)).size, 1);
  const bob = results[0].user;
  assert.match(bob.id, GENERATED_USER_ID_PATTERN);
  assert.deepEqual({ username: bob.username, role: bob.role, disabled: bob.disabled }, { username: 'bob', role: 'member', disabled: false });
  assert.equal(await redis.get(usernameIndexKey('bob')), bob.id);
  assert.equal(JSON.parse(await redis.get(userRecordKey(bob.id))).passwordHash, null);
  assert.ok((await identity.getUser(bob.id)).uid >= 100_000);
  assert.deepEqual((await users.verifyPassword('bob', 'anything at all', { rateLimitKey: 'b' })), { ok: false, reason: 'invalid' }, 'no password yet: no login');
  const check = await users.checkAccounts();
  assert.deepEqual(check.findings, []);
  assert.deepEqual({ users: check.users, owners: check.owners, members: check.members }, { users: 2, owners: 1, members: 1 });
  assert.deepEqual((await users.listUsers()).map((u) => u.id), ['default', bob.id]);
  const created = (await audit.list()).find((e) => e.action === 'auth.user-created');
  assert.equal(created.target, `user:${bob.id}`);
});

test('generated ids fit every id rule: records, instance owner label, GrantStore, Terminal networks', () => {
  const instanceOwner = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const network = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
  for (let i = 0; i < 200; i++) {
    const id = generateUserId();
    assert.match(id, GENERATED_USER_ID_PATTERN);
    assert.match(id, USER_ID_PATTERN);
    assert.match(id, instanceOwner);
    assert.match(`aura-term-${id}`, network);
    assert.ok(!id.includes('@'));
  }
});

test('member enrolment and reset with a one-time code revoke only that member; the owner\'s sessions survive (C5)', async () => {
  const { users, sessions, audit, claim } = accounts();
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const { user: bob } = await users.createUser({ username: 'bob' }, operatorAttribution());
  const ownerSession = await sessions.issue({ method: 'password', userId: 'default' });
  assert.equal((await users.setPasswordWithTicket(await claim({ userId: bob.id, username: 'bob' }), 'bobs first password')).ok, true);
  const login = await users.verifyPassword('bob', 'bobs first password', { rateLimitKey: 'c' });
  assert.equal(login.ok, true);
  assert.equal(login.user.role, 'member', 'the role comes from the record');
  const bobSession = await sessions.issue({ method: 'password', userId: bob.id });
  // The host CLI names the account by username only.
  const out = await users.setPasswordWithTicket(await claim({ username: 'bob' }), 'bobs second password');
  assert.equal(out.ok, true);
  assert.equal(out.sessionsRevoked, 1);
  assert.equal(await sessions.verify(bobSession.token), null);
  assert.ok(await sessions.verify(ownerSession.token), 'the owner stays signed in');
  assert.equal((await users.verifyPassword('bob', 'bobs first password', { rateLimitKey: 'c' })).ok, false);
  // A ticket bound to bob can't set the owner's password, and a mismatched name is refused.
  assert.deepEqual(await users.setPasswordWithTicket(await claim({ userId: bob.id, username: 'lukas' }), 'whatever password'), { ok: false, reason: 'username-mismatch' });
  const resets = (await audit.list()).filter((e) => e.action === 'auth.password-reset');
  assert.ok(resets.length >= 2 && resets.every((e) => e.target === `user:${bob.id}`));
});

test('owner recovery revokes only the owner\'s sessions (C5) and names the owner by id', async () => {
  const events = [];
  const { users, sessions, claim } = accounts({ onOwnerRecovered: (e) => { events.push(e); } });
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const { user: bob } = await users.createUser({ username: 'bob' }, operatorAttribution());
  const bobSession = await sessions.issue({ method: 'password', userId: bob.id });
  const ownerSession = await sessions.issue({ method: 'password', userId: 'default' });
  const out = await users.setPasswordWithTicket(await claim({ username: 'lukas' }), 'a new owner password');
  assert.equal(out.ok, true);
  assert.equal(await sessions.verify(ownerSession.token), null);
  assert.ok(await sessions.verify(bobSession.token), 'a member is not signed out');
  assert.equal(events[0].userId, 'default');
});

test('setDisabled: refuses login, revokes the sessions, deletes nothing; the owner is never disabled', async () => {
  const { users, sessions, identity, claim, audit } = accounts();
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const { user: bob } = await users.createUser({ username: 'bob' }, operatorAttribution());
  await users.setPasswordWithTicket(await claim({ userId: bob.id }), 'bobs first password');
  const s = await sessions.issue({ method: 'password', userId: bob.id });
  const uid = (await identity.getUser(bob.id)).uid;
  assert.deepEqual(await users.setDisabled('default', true, operatorAttribution()), { ok: false, reason: 'owner' });
  const off = await users.setDisabled(bob.id, true, operatorAttribution());
  assert.deepEqual(off, { ok: true, changed: true, sessionsRevoked: 1 });
  assert.equal(await sessions.verify(s.token), null);
  assert.equal((await users.verifyPassword('bob', 'bobs first password', { rateLimitKey: 'd' })).ok, false);
  assert.equal((await users.getUser(bob.id)).disabled, true);
  await users.setDisabled(bob.id, false, operatorAttribution());
  const back = await users.verifyPassword('bob', 'bobs first password', { rateLimitKey: 'd' });
  assert.equal(back.ok, true);
  assert.equal(back.user.id, bob.id, 'the same id');
  assert.equal((await identity.getUser(bob.id)).uid, uid, 'the same uid');
  const actions = (await audit.list()).filter((e) => e.action.startsWith('auth.user-'));
  assert.ok(actions.every((e) => e.target === `user:${bob.id}` || e.target === undefined));
});

test('audit targets name users by id only (C6)', async () => {
  const { users, audit, claim } = accounts();
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const { user: bob } = await users.createUser({ username: 'bob' }, operatorAttribution());
  await users.setPasswordWithTicket(await claim({ userId: bob.id }), 'bobs first password');
  await users.setDisabled(bob.id, true, operatorAttribution());
  for (const e of await audit.list()) {
    if (e.target?.startsWith('user:')) assert.match(e.target, /^user:(default|u[a-z2-7]{15})$/, `${e.action} → ${e.target}`);
  }
});

// ── the `user` grant subject and the A1/A3 guards ───────────────────────────

test('GrantStore: a user holds app.use/app.jump only; nobody else holds them; ids stay local (A3a)', async () => {
  const grants = new GrantStore(r, now);
  const by = operatorAttribution();
  await grants.grant({ kind: 'user', id: 'uaaaaaaaaaaaaaaa' }, 'app.use:3f1c2e7a-0000-4000-8000-000000000001', { by });
  await grants.grant({ kind: 'user', id: 'uaaaaaaaaaaaaaaa' }, 'app.jump:3f1c2e7a-0000-4000-8000-000000000001', { by });
  assert.ok(await grants.get({ kind: 'user', id: 'uaaaaaaaaaaaaaaa' }, 'app.use:3f1c2e7a-0000-4000-8000-000000000001'));
  const refused = (subject, permission, scope) => assert.rejects(grants.grant(subject, permission, { by, ...(scope ? { scope } : {}) }), (e) => e instanceof GrantError && e.status === 400);
  await refused({ kind: 'app', id: 'com.example.x' }, 'app.use:i1');
  await refused({ kind: 'apiKey', id: 'k1' }, 'app.jump:i1');
  await refused({ kind: 'user', id: 'uaaaaaaaaaaaaaaa' }, 'notifications.popup');
  await refused({ kind: 'user', id: 'uaaaaaaaaaaaaaaa' }, 'app.use:i1', { kind: 'user', id: 'uaaaaaaaaaaaaaaa' });
  // D85 A3a: a qualified (`…@systemId`) subject or installation id is a federation change, not a value.
  await refused({ kind: 'user', id: 'uaaaaaaaaaaaaaaa@sys-other' }, 'app.use:i1');
  await refused({ kind: 'app', id: 'com.example.x@sys-other' }, 'notifications.popup');
  await refused({ kind: 'user', id: 'uaaaaaaaaaaaaaaa' }, 'app.use:i1@sys-other');
  await refused({ kind: 'user', id: 'UPPER' }, 'app.use:i1');
});

test('Authorizer: a user or an instance acting for it holds its app grants; absent grants deny; foreign principals are refused first (A1)', async () => {
  const grants = new GrantStore(r, now);
  const authz = new Authorizer({ grants, declared: () => [], appBinding: async () => ({ scope: 'system', installationId: 'inst-1' }), localSystemId: () => 'sys-local' });
  const perm = 'app.use:i1';
  await grants.grant({ kind: 'user', id: 'uaaaaaaaaaaaaaaa' }, perm, { by: operatorAttribution() });
  const member = { kind: 'user', userId: 'uaaaaaaaaaaaaaaa', role: 'member', sessionId: 's', verification: 'verified', systemId: 'sys-local' };
  assert.equal((await authz.authorize(member, perm)).allow, true);
  assert.equal((await authz.authorize({ ...member, userId: 'ubbbbbbbbbbbbbbb' }, perm)).allow, false);
  assert.equal((await authz.authorize(member, 'app.jump:i1')).allow, false);
  assert.equal((await authz.authorize(member, 'notifications.popup')).allow, false);
  const { systemId: _drop, ...local } = member;
  assert.equal((await authz.authorize(local, perm)).allow, true, 'absent systemId is local');
  const inst = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'i-1', verification: 'verified', userId: 'uaaaaaaaaaaaaaaa' };
  assert.equal((await authz.authorize(inst, perm)).allow, true);
  assert.equal((await authz.authorize({ ...inst, userId: undefined }, perm)).allow, false);
  // A1: a remote owner is never a local owner; its grants are never read.
  const foreignOwner = { ...member, role: 'owner', systemId: 'sys-other' };
  const d = await authz.authorize(foreignOwner, perm);
  assert.equal(d.allow, false);
  assert.match(d.reason, /foreign-system/);
  assert.equal((await authz.authorize({ ...inst, systemId: 'sys-other' }, perm)).allow, false);
  assert.equal(isForeignPrincipal({ systemId: 'x' }, () => { throw new Error('unreadable'); }), true, 'an unreadable local id fails closed');
  assert.equal(isForeignPrincipal({}, () => 'sys-local'), false);
});

// ── D85 A9: nothing stale reaches a reused instance id ──────────────────────

test('A9: a reused instance id gets a new nonce and lifetime; the old token stops verifying', async () => {
  const { InstanceTokens } = await import('../dist/app-manager/InstanceTokens.js');
  const tokens = new InstanceTokens(join(fresh('tok'), 'instance-token.key'));
  const first = tokens.mint('com.example.app-2', undefined, 'default');
  const life1 = tokens.lifetimeId('com.example.app-2');
  assert.deepEqual(tokens.verify(first.token), { instanceId: 'com.example.app-2', userId: 'default' });
  tokens.forgetInstance('com.example.app-2'); // the instance stopped
  assert.equal(tokens.verify(first.token), null);
  const second = tokens.mint('com.example.app-2', undefined, 'uaaaaaaaaaaaaaaa'); // the id is reused, by another user
  assert.equal(tokens.verify(first.token), null, 'the previous life\'s token never verifies again');
  assert.notEqual(tokens.lifetimeId('com.example.app-2'), life1);
  assert.equal(tokens.verify(second.token).userId, 'uaaaaaaaaaaaaaaa');
});

test('A9: an approval binds the requesting instance\'s lifetime, so a reused id can\'t consume it', async () => {
  const { approvalRequester, sameRequester } = await import('../dist/approvals/index.js');
  const p = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', verification: 'verified', userId: 'default', lifetime: 'L1' };
  const a = approvalRequester(p);
  assert.equal(a.lifetime, 'L1');
  assert.equal(sameRequester(a, approvalRequester({ ...p })), true, 'the same spawn consumes its approval');
  assert.equal(sameRequester(a, approvalRequester({ ...p, lifetime: 'L2' })), false, 'the next spawn with the same id does not');
  const { lifetime: _l, ...unbound } = p;
  assert.equal(sameRequester(a, approvalRequester(unbound)), false);
});

// ── D87 B1: shell screens belong to the user that opened them ───────────────

test('B1: a user\'s screen counts only for that user and ends with its login session or the account', async () => {
  const { ClientSessionStore } = await import('../dist/auth/ClientSessions.js');
  const screens = new ClientSessionStore({ redis: r, now, secret: Buffer.alloc(32, 7) });
  const owner = await screens.register({ lock: 'unlocked', userId: 'default', loginSessionId: 'a'.repeat(32) });
  const bob = await screens.register({ lock: 'unlocked', userId: 'uaaaaaaaaaaaaaaa', loginSessionId: 'b'.repeat(32) });
  const anon = await screens.register({ lock: 'unlocked' });
  assert.equal(await screens.effectiveLock(owner.sid, { userId: 'default' }), 'unlocked');
  assert.equal(await screens.effectiveLock(bob.sid, { userId: 'default' }), 'locked', 'another user\'s sid is ignored');
  assert.equal(await screens.effectiveLock(owner.sid), 'unlocked', 'unchanged for callers that name no user');
  assert.equal(await screens.effectiveLock(anon.sid, { userId: 'default' }), 'unlocked', 'an unbound screen, as before');
  // A revoke: bob's login session is gone, the owner's is live.
  assert.equal(await screens.endRevoked(async (id) => id === 'a'.repeat(32)), 1);
  assert.equal(await screens.get(bob.sid), null);
  assert.ok(await screens.get(owner.sid));
  assert.ok(await screens.get(anon.sid), 'an unbound screen is not touched');
  assert.equal(await screens.endBy({ userId: 'default' }), 1);
  assert.equal(await screens.get(owner.sid), null);
  const again = await screens.register({ userId: 'default', loginSessionId: 'c'.repeat(32) });
  assert.equal(await screens.endBy({ loginSessionId: 'c'.repeat(32) }), 1);
  assert.equal(await screens.get(again.sid), null);
});

test('B1: disabling an account ends its screens', async () => {
  const { ClientSessionStore } = await import('../dist/auth/ClientSessions.js');
  const screens = new ClientSessionStore({ redis: r, now, secret: Buffer.alloc(32, 8) });
  const { users } = accounts({ clientSessions: screens });
  await users.createOwner({ username: 'lukas', password: PASSWORD });
  const { user: bob } = await users.createUser({ username: 'bob' }, operatorAttribution());
  const s = await screens.register({ userId: bob.id, loginSessionId: 'd'.repeat(32) });
  const o = await screens.register({ userId: 'default', loginSessionId: 'e'.repeat(32) });
  await users.setDisabled(bob.id, true, operatorAttribution());
  assert.equal(await screens.get(s.sid), null);
  assert.ok(await screens.get(o.sid));
});
