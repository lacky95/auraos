// D64: the security options registry (src/security/options.ts) and its
// sealed store (SecurityPolicyStore): declared once, env wins, a tampered
// record means the defaults (D63's switch then reads off, as decided).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FRESH_AUTH_REQUIRE_HTTPS, SECURITY_OPTIONS, SECURITY_POLICY_KEY, SecurityPolicyStore, parseOptionValue,
  parseSecurityPolicy, resolveSecurityOptions, securityOption, securityPolicyValue, lifecycleStrictMode,
  resetLifecycleStrictModeForTests,
} from '../dist/index.js';

function memoryRedis() {
  const data = new Map();
  return {
    data,
    redis: {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v, nx) => { if (nx === 'NX' && data.has(k)) return null; data.set(k, v); return 'OK'; },
      eval: async (_s, _n, k, expected, next) => { if (data.get(k) !== expected) return 0; data.set(k, next); return 1; },
    },
  };
}

test('every option is declared with its default, source and the fresh change level', () => {
  for (const o of SECURITY_OPTIONS) {
    assert.ok(o.id && o.title && o.description && o.source && o.since && o.phase, o.id);
    // The shell mode's switch is one approval click (D57); every other option needs the password.
    assert.equal(o.change, o.id === 'shell-mode' ? 'session' : 'fresh', o.id);
    assert.ok(Object.isFrozen(o));
  }
  assert.ok(Object.isFrozen(SECURITY_OPTIONS));
  const fresh = securityOption(FRESH_AUTH_REQUIRE_HTTPS);
  assert.deepEqual([fresh.source, fresh.default, fresh.type], ['policy', false, 'boolean']);
});

test('values: parsed strictly; a record with an unknown or env id is refused whole', () => {
  const fresh = securityOption(FRESH_AUTH_REQUIRE_HTTPS);
  assert.equal(parseOptionValue(fresh, 'on'), true);
  assert.equal(parseOptionValue(fresh, 'OFF'), false);
  assert.equal(parseOptionValue(fresh, 'maybe'), undefined);
  assert.equal(parseOptionValue(fresh, 1), undefined);
  assert.deepEqual(parseSecurityPolicy({ [FRESH_AUTH_REQUIRE_HTTPS]: true }), { [FRESH_AUTH_REQUIRE_HTTPS]: true });
  assert.equal(parseSecurityPolicy({ 'access-enforce': 'off' }), null);
  assert.equal(parseSecurityPolicy({ nope: true }), null);
  assert.equal(parseSecurityPolicy([]), null);
});

test('effective values: env, then policy, then default', () => {
  assert.equal(securityPolicyValue({}, FRESH_AUTH_REQUIRE_HTTPS, {}), false);
  assert.equal(securityPolicyValue({ [FRESH_AUTH_REQUIRE_HTTPS]: true }, FRESH_AUTH_REQUIRE_HTTPS, {}), true);
  const list = resolveSecurityOptions({}, { AURA_LIFECYCLE_STRICT: 'strict', AURA_TRUSTED_PROXIES: '10.0.0.1, 10.0.0.2' });
  const by = Object.fromEntries(list.map((o) => [o.id, o]));
  assert.equal(by['lifecycle-strict'].value, 'strict');
  assert.equal(by['lifecycle-strict'].effectiveSource, 'env AURA_LIFECYCLE_STRICT');
  assert.deepEqual(by['trusted-proxies'].value, ['10.0.0.1', '10.0.0.2']);
  assert.equal(by['access-enforce'].effectiveSource, 'default');
});

test('lifecycle strict mode is read through the registry', () => {
  const saved = process.env.AURA_LIFECYCLE_STRICT;
  try {
    for (const [raw, want] of [['strict', 'strict'], [' Strict ', 'strict'], ['warn', 'warn'], ['bogus', 'warn'], ['', 'warn']]) {
      process.env.AURA_LIFECYCLE_STRICT = raw;
      resetLifecycleStrictModeForTests();
      assert.equal(lifecycleStrictMode(), want, raw);
    }
  } finally {
    if (saved === undefined) delete process.env.AURA_LIFECYCLE_STRICT; else process.env.AURA_LIFECYCLE_STRICT = saved;
    resetLifecycleStrictModeForTests();
  }
});

test('store: sealed; tampering or a swapped key means the defaults, reported once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secpol-'));
  const kv = memoryRedis();
  let tampered = 0;
  const store = new SecurityPolicyStore({ identityKeyFile: join(dir, 'identity.key'), redis: () => kv.redis, onTampered: () => { tampered += 1; } });
  await store.set(FRESH_AUTH_REQUIRE_HTTPS, true);
  assert.deepEqual(await store.get(), { [FRESH_AUTH_REQUIRE_HTTPS]: true });
  const other = new SecurityPolicyStore({ identityKeyFile: join(mkdtempSync(join(tmpdir(), 'secpol-')), 'identity.key'), redis: () => kv.redis });
  assert.deepEqual(await other.get(), {}, 'another identity key cannot read it as valid');
  kv.data.set(SECURITY_POLICY_KEY, 'not json');
  assert.deepEqual(await store.get(), {});
  assert.deepEqual(await store.get(), {});
  assert.equal(tampered, 1);
});

test('Phase 5 entries (D64): the runtimes record and the aura-root switch (J.6: a policy option)', () => {
  const runtimes = securityOption('runtimes');
  assert.deepEqual([runtimes.source, runtimes.record, runtimes.type, runtimes.change], ['record', 'user:policy:runtimes', 'record', 'fresh']);
  const root = securityOption('aura-root');
  assert.deepEqual([root.source, root.type, root.default, [...root.values]], ['policy', 'enum', 'enabled', ['enabled', 'disabled']]);
  assert.equal(securityOption('session-file-caps'), undefined, 'P5-2: no session capabilities, so no switch');
});
