// D89 B4: the shell's relay claim (app-hosts/relayClaim.ts). Signed with a key
// derived from one start's lifecycle token, bound to the instance, method and
// path, seconds-long; the SDK carries a byte-identical copy that verifies it.
// `relay-strict` is a D64 registry option, handed to an app only when strict.
//
//   pnpm --filter @aura/core build && node --test test/relay-claim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELAY_CLAIM_HEADER, RELAY_CLAIM_TTL_S, relayKey, relayPath, signRelayClaim, verifyRelayClaim } from '../dist/app-hosts/relayClaim.js';
import { relayStrictEnv, relayStrictMode } from '../dist/app-manager/lifecycleGate.js';
import { SECURITY_OPTIONS, resolveSecurityOptions } from '../dist/security/options.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const KEY = relayKey('lifecycle-token-of-this-start');
const call = { key: KEY, instanceId: 'com.aura.terminal-2', method: 'POST', path: '/mcp/terminal?x=1' };
const sign = (over = {}, now = Date.now()) => signRelayClaim(KEY, { i: 'com.aura.terminal-2', m: 'POST', p: '/mcp/terminal?x=1', u: 'owner-1', c: 'user', ...over }, now);

test('the SDK copy of the relay claim is byte-identical', () => {
  assert.equal(
    readFileSync(join(ROOT, 'packages/app-sdk/src/relayClaim.ts'), 'utf-8'),
    readFileSync(join(ROOT, 'packages/core/src/app-hosts/relayClaim.ts'), 'utf-8'),
  );
});

test('a claim verifies for its instance, method, path and start, and names the caller', () => {
  assert.equal(RELAY_CLAIM_HEADER, 'x-aura-relay');
  const token = sign();
  assert.match(token, /^agr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const claim = verifyRelayClaim(token, call);
  assert.equal(claim?.i, 'com.aura.terminal-2');
  assert.equal(claim?.u, 'owner-1');
  assert.equal(claim?.c, 'user');
  assert.equal(claim.exp - claim.iat, RELAY_CLAIM_TTL_S);
  assert.ok(verifyRelayClaim(sign({ m: 'post', p: '/x/../mcp/terminal?x=1' }), call), 'method case and dot segments normalize');
  assert.equal(verifyRelayClaim(token, { ...call, instanceId: 'com.aura.terminal-3' }), null, 'another instance');
  assert.equal(verifyRelayClaim(token, { ...call, method: 'GET' }), null, 'another method');
  assert.equal(verifyRelayClaim(token, { ...call, path: '/mcp/terminal' }), null, 'another query');
  assert.equal(verifyRelayClaim(token, { ...call, path: '/api/sessions/input' }), null, 'another path');
  assert.equal(verifyRelayClaim(token, { ...call, key: relayKey('an-earlier-start') }), null, 'another start');
  assert.equal(verifyRelayClaim(sign({}, Date.now() - (RELAY_CLAIM_TTL_S + 2) * 1000), call), null, 'expired');
  assert.equal(verifyRelayClaim(sign({}, Date.now() + 60_000), call), null, 'from the future');
  const [p, body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), u: 'someone-else' })).toString('base64url');
  assert.equal(verifyRelayClaim(`${p}.${forged}.${mac}`, call), null, 'a changed payload');
  for (const bad of [undefined, null, '', 'agr1', 'agw1.x.y', `agw1.${body}.${mac}`, 'agr1.!.!']) {
    assert.equal(verifyRelayClaim(bad, call), null, String(bad));
  }
  assert.equal(relayPath('/a/./b/../c?q=1'), '/a/c?q=1');
});

test('the key is derived from the lifecycle token, never the token itself', () => {
  assert.notEqual(KEY.toString('utf-8'), 'lifecycle-token-of-this-start');
  assert.equal(KEY.length, 32);
  assert.deepEqual(relayKey('lifecycle-token-of-this-start'), KEY);
});

test('relay-strict: a D64 registry option, default warn, handed to an app only when strict', () => {
  const opt = SECURITY_OPTIONS.find((o) => o.id === 'relay-strict');
  assert.ok(opt, 'registered');
  assert.equal(opt.env, 'AURA_RELAY_STRICT');
  assert.equal(opt.default, 'warn');
  assert.deepEqual(opt.values, ['warn', 'strict']);
  assert.equal(relayStrictMode({}), 'warn');
  assert.equal(relayStrictMode({ AURA_RELAY_STRICT: 'Strict ' }), 'strict');
  assert.equal(relayStrictMode({ AURA_RELAY_STRICT: 'bogus' }), 'warn');
  assert.deepEqual(relayStrictEnv({}), {});
  assert.deepEqual(relayStrictEnv({ AURA_RELAY_STRICT: 'strict' }), { AURA_RELAY_STRICT: 'strict' });
  const eff = resolveSecurityOptions({}, { AURA_RELAY_STRICT: 'strict' }, () => null).find((o) => o.id === 'relay-strict');
  assert.equal(eff.value, 'strict');
  assert.equal(eff.effectiveSource, 'env AURA_RELAY_STRICT');
});

test('a container start carries AURA_RELAY_STRICT only in strict mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-relay-'));
  const prev = process.env.AURA_RELAY_STRICT;
  try {
    const dataDir = join(root, 'data');
    const appDir = join(dataDir, 'scopes/users/default/apps/com.aura.terminal');
    const instDir = join(appDir, 'com.aura.terminal-1');
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(appDir, 'server.mjs'), '');
    const runner = new ContainerRunner({ baseRootfs: root, toolchainDir: join(root, 'tc'), appsDir: join(root, 'apps'), dataDir, osApiBase: 'http://aura-shell:3000' });
    Object.assign(runner, { appDataVolume: 'aura_aura-app-data', nodeModulesVolume: 'aura_aura-node-modules' });
    const manifest = { id: 'com.aura.terminal', entrypoint: 'server.mjs', tools: ['*'], sandbox: 'container' };
    const args = () => runner.buildDockerArgs('com.aura.terminal-1', 'com.aura.terminal', 4000, manifest, 'aura-com.aura.terminal-1',
      { appDir, instanceDataDir: instDir }, {}, []);
    delete process.env.AURA_RELAY_STRICT;
    assert.ok(!args().some((a) => a.startsWith('AURA_RELAY_STRICT')), 'warn: nothing added');
    process.env.AURA_RELAY_STRICT = 'strict';
    assert.ok(args().includes('AURA_RELAY_STRICT=strict'), 'strict: in the env');
    assert.equal(runner.relayKey('com.aura.terminal-1'), null, 'no start, no key');
  } finally {
    if (prev === undefined) delete process.env.AURA_RELAY_STRICT; else process.env.AURA_RELAY_STRICT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
