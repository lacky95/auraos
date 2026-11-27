// D46 / F0: per-user preferences and app storage, and the one-time migration
// that keeps the old values, falls back to them, and runs once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  USER_DATA_MIGRATION, USER_PREF_KEYS, appStorageNamespace, isUserPrefKey, migrateUserData,
  readAppStorage, readUserPref, readUserPrefValue, userPrefsNamespace, writeUserPref,
} from '../dist/users/userData.js';
import { KV_USER_NAMESPACE_PATTERN, isValidNamespace } from '@aura/kv-store';

/** In-memory KvClient stand-in: `<ns>:<key>` → { value, updatedAt }. */
function fakeKv(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, { value: v, updatedAt: 1 }]));
  let t = 100;
  return {
    m,
    async get(ns, key) { return m.get(`${ns}:${key}`) ?? null; },
    async set(ns, key, value) { const e = { value, updatedAt: ++t }; m.set(`${ns}:${key}`, e); return e; },
    async del(ns, key) { return m.delete(`${ns}:${key}`); },
    async exists(ns, key) { return m.has(`${ns}:${key}`); },
    async scan(match) {
      const re = new RegExp(`^${match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return [...m.keys()].filter((k) => re.test(k));
    },
  };
}

const OWNER = 'u-owner';
const theme = { themeIdDark: 'neon', themeIdLight: 'paper', colorMode: 'auto' };

test('the per-user namespaces are valid server-side, and none of them is an /api/kv URL namespace', () => {
  for (const ns of [userPrefsNamespace(OWNER), appStorageNamespace('com.a.b', { userId: OWNER }), appStorageNamespace('com.a.b', 'shared')]) {
    assert.ok(KV_USER_NAMESPACE_PATTERN.test(ns), ns);
    assert.ok(isValidNamespace(ns), ns);
  }
  // The route builds `os` or `app/<id>` from the URL: a user or per-user app area never.
  for (const ns of ['user', 'user/x', 'app/com.a.b/u', 'app/com.a.b/u/', 'user/../prefs']) assert.equal(isValidNamespace(ns), false, ns);
  assert.deepEqual([...USER_PREF_KEYS], ['theme', 'locale', 'keymap', 'workspaces', 'app-mru', 'session', 'lastWindow']);
  assert.equal(isUserPrefKey('lockscreen'), false);
});

test('a preference reads the user\'s own value, else falls back to the old shared one; a write never touches os', async () => {
  const kv = fakeKv({ 'os:theme': theme });
  assert.deepEqual(await readUserPrefValue(kv, OWNER, 'theme'), theme, 'fallback');
  const mine = { ...theme, colorMode: 'dark' };
  await writeUserPref(kv, OWNER, 'theme', mine);
  assert.deepEqual(await readUserPrefValue(kv, OWNER, 'theme'), mine);
  assert.deepEqual(kv.m.get('os:theme').value, theme, 'old value kept');
  assert.deepEqual(await readUserPrefValue(kv, 'someone-else', 'theme'), theme, 'another user sees only the fallback');
  assert.equal(await readUserPref(kv, OWNER, 'keymap'), null);
});

test('app storage: per user, with the pre-D46 bucket as the fallback; shared has no fallback', async () => {
  const kv = fakeKv({ 'app/com.a.notes:draft': 'old' });
  assert.equal((await readAppStorage(kv, 'com.a.notes', { userId: OWNER }, 'draft')).value, 'old');
  assert.equal(await readAppStorage(kv, 'com.a.notes', 'shared', 'draft'), null);
  await kv.set(appStorageNamespace('com.a.notes', { userId: OWNER }), 'draft', 'mine');
  assert.equal((await readAppStorage(kv, 'com.a.notes', { userId: OWNER }, 'draft')).value, 'mine');
  assert.equal((await readAppStorage(kv, 'com.a.notes', { userId: 'other' }, 'draft')).value, 'old');
});

test('migration round trip: backup first, old values kept, copies into the owner\'s area, second run is a no-op', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-mig-'));
  const kv = fakeKv({
    'os:theme': theme, 'os:workspaces': { activeWorkspaceId: 'ws-1', workspaces: [] }, 'os:session': { schema: 1 },
    'os:lockscreen': { locked: false },                      // not a preference: stays OS-wide, not copied
    'app/com.a.notes:draft': 'hello', 'app/com.a.notes:dir/x': 1,
    'app/com.b.todo:list': [1, 2],
    [`${userPrefsNamespace(OWNER)}:keymap`]: { bindings: { a: 1 } }, // already the user's: never overwritten
  });
  kv.m.set('os:keymap', { value: { bindings: {} }, updatedAt: 1 });
  const before = new Map([...kv.m].map(([k, v]) => [k, JSON.stringify(v)]));

  const r = await migrateUserData(kv, { ownerId: OWNER, dataDir, now: () => 42 });
  assert.equal(r.ran, true);
  assert.equal(r.prefs, 3, 'theme, workspaces, session; keymap was already there');
  assert.equal(r.appKeys, 3);
  // Old values untouched.
  for (const [k, v] of before) assert.equal(JSON.stringify(kv.m.get(k)), v, `kept ${k}`);
  // Copied.
  assert.deepEqual(await readUserPrefValue(kv, OWNER, 'theme'), theme);
  assert.deepEqual((await kv.get(userPrefsNamespace(OWNER), 'keymap')).value, { bindings: { a: 1 } });
  assert.equal(await kv.get(userPrefsNamespace(OWNER), 'lockscreen'), null);
  assert.equal((await kv.get(appStorageNamespace('com.a.notes', { userId: OWNER }), 'dir/x')).value, 1);
  assert.deepEqual((await kv.get(appStorageNamespace('com.b.todo', { userId: OWNER }), 'list')).value, [1, 2]);
  // The backup holds every value read, private to the master.
  assert.equal(r.backup, join(dataDir, 'aura', 'backups', `${USER_DATA_MIGRATION}-42.json`));
  assert.equal(statSync(r.backup).mode & 0o777, 0o600);
  const snap = JSON.parse(readFileSync(r.backup, 'utf-8'));
  assert.deepEqual(snap.os.theme.value, theme);
  assert.equal(snap.app['app/com.a.notes:draft'].value, 'hello');
  assert.equal(snap.os.lockscreen, undefined);

  // A change after the migration, then a second run: nothing moves.
  await writeUserPref(kv, OWNER, 'theme', { ...theme, colorMode: 'light' });
  const after = JSON.stringify([...kv.m]);
  const again = await migrateUserData(kv, { ownerId: OWNER, dataDir, now: () => 43 });
  assert.deepEqual(again, { ran: false, prefs: 0, appKeys: 0 });
  assert.equal(JSON.stringify([...kv.m]), after, 'second run is a no-op');
});

test('a failed backup copies nothing and leaves the marker unset, so the next boot retries', async () => {
  const kv = fakeKv({ 'os:theme': theme });
  // A data dir that is a file: the backup directory can't be made.
  const notADir = join(mkdtempSync(join(tmpdir(), 'aura-mig-')), 'file');
  writeFileSync(notADir, '');
  await assert.rejects(migrateUserData(kv, { ownerId: OWNER, dataDir: notADir }));
  assert.equal(await kv.get(userPrefsNamespace(OWNER), 'theme'), null);
  assert.equal([...kv.m.keys()].some((k) => k.includes('migrations')), false);
});

test('an empty store needs no backup and is marked done', async () => {
  const kv = fakeKv();
  const r = await migrateUserData(kv, { ownerId: OWNER, dataDir: '/nonexistent' });
  assert.deepEqual(r, { ran: true, prefs: 0, appKeys: 0 });
  assert.equal((await migrateUserData(kv, { ownerId: OWNER, dataDir: '/nonexistent' })).ran, false);
});
