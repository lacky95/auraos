// D46: the profile field registry, the filter that keeps `private` fields
// away from apps, and the user store's profile record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_FIELDS, PROFILE_FIELD_NAMES, filterProfile, parseProfilePatch, profileGrantPermission,
} from '../dist/users/profileRegistry.js';
import { ValkeyUserStore, profileKey } from '../dist/auth/ValkeyUserStore.js';
import { userPrefsNamespace } from '../dist/users/userData.js';

const ACCESS = new Set(['basic', 'granted', 'private']);

test('every registry field declares an access class, validation and editability', () => {
  assert.deepEqual(PROFILE_FIELD_NAMES, ['displayName', 'locale', 'avatar']);
  for (const [name, f] of Object.entries(PROFILE_FIELDS)) {
    assert.ok(ACCESS.has(f.access), `${name} has an access class`);
    assert.equal(typeof f.validate, 'function', name);
    assert.equal(typeof f.ownerEditable, 'boolean', name);
  }
  // The alpha fields are all basic.
  for (const name of PROFILE_FIELD_NAMES) assert.equal(PROFILE_FIELDS[name].access, 'basic', name);
  assert.equal(profileGrantPermission('phone'), 'user.profile.phone');
});

// A registry with every class, as later phases will have.
const FIELDS = { displayName: { access: 'basic' }, phone: { access: 'granted' }, recovery: { access: 'private' } };
const PROFILE = { displayName: 'Lu', phone: '+43', recovery: 'secret-ish', unknown: 'x' };

test('a private field never reaches an app, whatever the app holds', async () => {
  const everything = { kind: 'app', granted: () => true };
  const seen = await filterProfile(PROFILE, everything, FIELDS);
  assert.deepEqual(seen, { displayName: 'Lu', phone: '+43' });
  assert.equal('recovery' in seen, false);
  // Also with the live registry: no field of it is private today, and none leaks if one becomes so.
  for (const name of PROFILE_FIELD_NAMES) {
    const reg = { ...Object.fromEntries(PROFILE_FIELD_NAMES.map((n) => [n, { access: 'basic' }])), [name]: { access: 'private' } };
    const out = await filterProfile({ displayName: 'a', locale: 'en', avatar: 'https://x.test/a.png' }, everything, reg);
    assert.equal(name in out, false, `${name} as private`);
  }
});

test('granted fields need the grant; basic ones do not; unknown fields are dropped; the user sees all', async () => {
  const asked = [];
  const none = { kind: 'app', granted: (f) => { asked.push(f); return false; } };
  assert.deepEqual(await filterProfile(PROFILE, none, FIELDS), { displayName: 'Lu' });
  assert.deepEqual(asked, ['phone'], 'only granted fields are checked');
  const failing = { kind: 'app', granted: () => { throw new Error('store down'); } };
  assert.deepEqual(await filterProfile(PROFILE, failing, FIELDS), { displayName: 'Lu' }, 'a failed grant check is a no');
  assert.deepEqual(await filterProfile(PROFILE, { kind: 'user' }, FIELDS), { displayName: 'Lu', phone: '+43', recovery: 'secret-ish' });
});

test('a profile patch is validated by the registry', () => {
  assert.deepEqual(parseProfilePatch({ displayName: 'Lukas', locale: 'de-AT', avatar: null }),
    { ok: true, set: { displayName: 'Lukas', locale: 'de-AT' }, clear: ['avatar'] });
  for (const [body, field] of [
    [{ displayName: '' }, 'displayName'], [{ displayName: ' x' }, 'displayName'], [{ displayName: 'a‮b' }, 'displayName'],
    [{ displayName: 'x'.repeat(65) }, 'displayName'], [{ locale: 'english please' }, 'locale'],
    [{ avatar: 'http://x.test/a.png' }, 'avatar'], [{ avatar: 'javascript:alert(1)' }, 'avatar'],
    [{ role: 'owner' }, 'role'], [{ userId: 'other' }, 'userId'],
  ]) {
    const r = parseProfilePatch(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.field, field);
  }
  assert.equal(parseProfilePatch({}).ok, false);
  assert.equal(parseProfilePatch([]).ok, false);
  assert.equal(parseProfilePatch({ avatar: 'data:image/png;base64,AAAA' }).ok, true);
});

function fakeRedis() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async set(k, v) { m.set(k, v); return 'OK'; }, async del(k) { return m.delete(k) ? 1 : 0; } };
}

class Store extends ValkeyUserStore {
  constructor(redis, owner) { super({ identityKeyFile: '/nonexistent', redis: () => redis, now: () => 7 }); this.owner = owner; }
  // The account read (I.2: `user:<id>`, any role) is faked; the profile half is real.
  async getUser(id) { return this.owner && this.owner.id === id ? this.owner : null; }
}

test('UserStore: getUser and getProfile, with locale backed by the user\'s preference', async () => {
  const r = fakeRedis();
  const owner = { id: 'u1', username: 'lu', role: 'owner', createdAt: 1, disabled: false };
  const s = new Store(r, owner);
  assert.deepEqual(await s.getUser('u1'), owner);
  assert.equal(await s.getUser('u2'), null);
  assert.equal(await s.getProfile('u2'), null);
  assert.deepEqual(await s.getProfile('u1'), {});
  // The shared locale from before the move is the fallback.
  r.m.set('os:locale', JSON.stringify({ value: 'en-GB', updatedAt: 1 }));
  assert.deepEqual(await s.getProfile('u1'), { locale: 'en-GB' });

  const after = await s.updateProfile('u1', { set: { displayName: 'Lu', locale: 'de-AT' }, clear: [] });
  assert.deepEqual(after, { displayName: 'Lu', locale: 'de-AT' });
  assert.deepEqual(JSON.parse(r.m.get(profileKey('u1'))), { v: 1, displayName: 'Lu' }, 'locale is not stored twice');
  assert.equal(JSON.parse(r.m.get(`${userPrefsNamespace('u1')}:locale`)).value, 'de-AT');
  assert.equal(JSON.parse(r.m.get('os:locale')).value, 'en-GB', 'the old shared value is kept');

  assert.deepEqual(await s.updateProfile('u1', { set: {}, clear: ['displayName'] }), { locale: 'de-AT' });
  assert.equal(await s.updateProfile('u2', { set: { displayName: 'x' }, clear: [] }), null);
  // A stored value that no longer validates is left out.
  r.m.set(profileKey('u1'), JSON.stringify({ v: 1, displayName: ' bad' }));
  assert.deepEqual(await s.getProfile('u1'), { locale: 'de-AT' });
});
