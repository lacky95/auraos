// D89 B4 + B7 on the shell side.
//   B4: the shell signs a relay claim on every call it forwards to an
//       owner-agent app (the Terminal, aurashelld) and on its own calls to the
//       Terminal; a caller can never bring its own (stripped like every shell
//       header). The claim names the caller the shell authorized.
//   B7: a verified instance token from an address its instance does not have
//       is counted in the access report (report-only, never a decision).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Authorizer, RELAY_CLAIM_HEADER } from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { createObserver } from '../src/lib/access/observer.ts';
import { tokenAddressMismatch, type ObserverDeps } from '../src/lib/access/observer.ts';
import { AccessReport } from '../src/lib/access/report.ts';
import type { RequestSnapshot, VerifiedIdentity } from '../src/lib/access/types.ts';
import { RELAY_SIGNER_KEY, installRelaySigner, relayCaller, relayClaimFor } from '../src/lib/access/relay.ts';
import { relayClaimOf } from '../server/access-bridge.mjs';
import { stripShellCredentials } from '../server/shell-credentials.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, '..', rel), 'utf-8');

/** A signer like AppManager.relayClaim: the instance's key, null for one without a start. */
const signer = {
  calls: [] as Array<{ instanceId: string; call: Record<string, unknown> }>,
  relayClaim(instanceId: string, call: { method: string; path: string; userId?: string; sid?: string; caller?: string }) {
    this.calls.push({ instanceId, call });
    if (instanceId !== 'com.aura.terminal-2' && instanceId !== 'com.aura.aurashelld-1') return null;
    // The real signer (core) is exercised in core's relay-claim test; this one only records.
    return `signed:${instanceId}:${call.method}:${call.path}:${call.caller}:${call.userId ?? ''}`;
  },
};

test('B4: a caller\'s own x-aura-relay never reaches an app, on every header form', () => {
  const h = stripShellCredentials(new Headers({ [RELAY_CLAIM_HEADER]: 'agr1.forged.mac', accept: 'x' }), 'proxy-http') as Headers;
  assert.equal(h.get(RELAY_CLAIM_HEADER), null);
  assert.equal(h.get('accept'), 'x');
  const node = stripShellCredentials({ 'X-Aura-Relay': 'agr1.forged.mac', cookie: 'app=1' }, 'ws-proxy') as Record<string, string>;
  assert.deepEqual(node, { cookie: 'app=1' });
  const raw = stripShellCredentials(['X-Aura-Relay', 'agr1.forged.mac', 'Accept', 'x'], 'app-hosts-http');
  assert.deepEqual(raw, ['Accept', 'x']);
});

test('B4: the claim names who the shell authorized, never a credential', () => {
  assert.deepEqual(relayCaller({ kind: 'user', userId: 'u1', role: 'owner', sessionId: 's1', verification: 'verified' } as AccessPrincipal),
    { userId: 'u1', sid: 's1', caller: 'user' });
  assert.deepEqual(relayCaller({ kind: 'user', userId: 'u1', role: 'owner', sessionId: 's1', verification: 'verified', through: { appId: 'com.aura.settings' } } as AccessPrincipal),
    { userId: 'u1', sid: 's1', caller: 'owner-through:com.aura.settings' });
  assert.deepEqual(relayCaller({ kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', userId: 'u1', verification: 'verified' } as AccessPrincipal),
    { userId: 'u1', caller: 'instance:com.aura.terminal-2' });
  assert.deepEqual(relayCaller({ kind: 'operator', verification: 'verified' } as AccessPrincipal), { caller: 'operator' });
  assert.deepEqual(relayCaller(null), { caller: 'anonymous' });
});

test('B4: only an owner-agent app gets a claim, bound to the call it receives', () => {
  signer.calls.length = 0;
  const who = { userId: 'u1', caller: 'user' };
  assert.equal(relayClaimFor(signer, { appId: 'com.aura.docs', instanceId: 'com.aura.docs-1', method: 'POST', path: '/mcp' }, who), null);
  assert.equal(signer.calls.length, 0, 'an ordinary app is not even asked');
  assert.equal(relayClaimFor(signer, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', method: 'POST', path: '/mcp/terminal?a=1' }, who),
    'signed:com.aura.terminal-2:POST:/mcp/terminal?a=1:user:u1');
  assert.equal(relayClaimFor(signer, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-9', method: 'GET', path: '/' }, who), null, 'no start key: no claim');
  assert.equal(relayClaimFor({ relayClaim: () => { throw new Error('x'); } }, { appId: 'com.aura.aurashelld', instanceId: 'com.aura.aurashelld-1', method: 'GET', path: '/' }, who), null, 'never throws');
  assert.equal(relayClaimFor(null, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', method: 'GET', path: '/' }, who), null);
});

test('B4: the .mjs servers reach the signer in every access mode; session and system callers', () => {
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[RELAY_SIGNER_KEY];
  try {
    delete g[RELAY_SIGNER_KEY];
    assert.equal(relayClaimOf({ appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', method: 'GET', path: '/ws' }), null, 'before the middleware loaded');
    installRelaySigner(() => signer);
    assert.equal(relayClaimOf({ appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', method: 'GET', path: '/ws', session: { userId: 'u1', sid: 's1' } }),
      'signed:com.aura.terminal-2:GET:/ws:user:u1');
    assert.equal(relayClaimOf({ appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', method: 'GET', path: '/api/sessions', system: true }),
      'signed:com.aura.terminal-2:GET:/api/sessions:system:');
    assert.equal(relayClaimOf({ appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', method: 'GET', path: '/ws', principal: { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', verification: 'verified' } }),
      'signed:com.aura.terminal-2:GET:/ws:instance:com.aura.terminal-3:');
    installRelaySigner(() => { throw new Error('no manager yet'); });
    assert.equal(relayClaimOf({ appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', method: 'GET', path: '/ws' }), null);
  } finally {
    if (prev === undefined) delete g[RELAY_SIGNER_KEY]; else g[RELAY_SIGNER_KEY] = prev;
  }
});

test('B4: every relay to an owner-agent upstream attaches the claim after stripping the caller\'s headers', () => {
  const proxy = read('src/pages/api/proxy/[id]/[...path].ts');
  assert.ok(proxy.indexOf('stripShellCredentials(') < proxy.indexOf('headers.set(RELAY_CLAIM_HEADER, relay)'), '/api/proxy');
  assert.match(proxy, /path: `\/\$\{forwardPath\}\$\{reqUrl\.search\}`/, '/api/proxy binds the path the upstream gets');
  const ws = read('server/attach.mjs');
  assert.ok(ws.indexOf("stripShellCredentials(upstreamHeaders, 'ws-proxy')") < ws.indexOf('upstreamHeaders[RELAY_CLAIM_HEADER] = relay'), 'WS proxy');
  const hosts = read('server/app-hosts.mjs');
  assert.ok(hosts.includes('headers.push(RELAY_CLAIM_HEADER, relay)'), 'App Host HTTP');
  assert.ok(hosts.includes('extra[RELAY_CLAIM_HEADER] = relay'), 'App Host upgrade');
  const embed = read('server/terminal-embed.mjs');
  assert.equal((embed.match(/shellRelayHeader\(/g) ?? []).length, 3, 'terminal-embed: the helper, fetchTerminal and the sweep');
  assert.ok(read('src/pages/api/terminal/share.ts').includes('shellRelayHeader(mgr, inst.instanceId'), 'terminal/share');
  assert.ok(read('src/middleware.ts').includes('installRelaySigner('), 'the middleware registers the signer');
});

// ── B7 ─────────────────────────────────────────────────────────────────────

const tokenInst = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'instance', appId: 'com.a.app', instanceId: 'com.a.app-1', verification: 'verified', ...over } as AccessPrincipal,
  via: 'instance-token' as const,
});
const addrMgr = { getInstanceAddresses: (id: string) => (id === 'com.a.app-1' ? ['172.20.0.5', '172.30.0.2'] : []) };

test('B7: a token from an address its instance does not have is a mismatch; nothing else is', () => {
  assert.equal(tokenAddressMismatch(tokenInst(), '172.20.0.9', addrMgr), true, 'another address');
  assert.equal(tokenAddressMismatch(tokenInst(), '::ffff:172.20.0.5', addrMgr), false, 'its own (mapped)');
  assert.equal(tokenAddressMismatch(tokenInst(), '172.30.0.2', addrMgr), false, 'its private network address');
  assert.equal(tokenAddressMismatch(tokenInst(), '127.0.0.1', addrMgr), true, 'a container token from the shell\'s own namespace');
  assert.equal(tokenAddressMismatch(tokenInst({ instanceId: 'com.a.proot-1' }), '127.0.0.1', addrMgr), false, 'no addresses (PRoot): never flagged');
  assert.equal(tokenAddressMismatch(tokenInst({ sidecar: 'db' }), '172.20.0.9', addrMgr), false, 'a sidecar has its own container');
  assert.equal(tokenAddressMismatch({ ...tokenInst(), via: 'network' }, '172.20.0.9', addrMgr), false, 'only a token');
  assert.equal(tokenAddressMismatch(tokenInst(), null, addrMgr), false, 'no peer');
  assert.equal(tokenAddressMismatch(tokenInst(), '172.20.0.9', null), false, 'no manager');
  assert.equal(tokenAddressMismatch(tokenInst(), '172.20.0.9', { getInstanceAddresses: () => { throw new Error('x'); } }), false);
});

test('B7: the observer counts it per app, and the decision is unchanged', async () => {
  const mgr = {
    ...addrMgr,
    tokens: { hasNonce: () => true, verify: () => null },
    getInstance: (id: string) => (id === 'com.a.app-1' ? { appId: 'com.a.app', instanceId: 'com.a.app-1' } : undefined),
    getInstancesByApp: () => [],
    registry: { getById: (id: string) => (id === 'com.a.app' ? {} : undefined) },
  };
  const deps: ObserverDeps = {
    authorizer: new Authorizer({ grants: { get: async () => null } as never, declared: () => [], appScope: () => 'user' }),
    mgr: () => mgr as never,
    services: () => null,
    redisReady: () => true,
    internalSecret: () => null,
  };
  const report = new AccessReport({ redis: () => null });
  const { observeRequest } = createObserver({ deps, report });
  const verified: VerifiedIdentity = { principal: tokenInst().principal, via: 'instance-token' } as VerifiedIdentity;
  const snap = (peer: string): RequestSnapshot => ({
    method: 'GET', routePattern: '/api/apps', pathname: '/api/apps', search: '', params: {}, https: false, status: 200, internal: null,
    identity: { verified: Promise.resolve(verified), referer: null, instanceId: null, peer },
  } as RequestSnapshot);
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await observeRequest(snap('172.20.0.5'));
    assert.equal(report.pending().meta['binding|token-address-mismatch|com.a.app'], undefined, 'its own address');
    await observeRequest(snap('172.20.0.9'));
    await observeRequest(snap('172.20.0.9'));
    assert.equal(report.pending().meta['binding|token-address-mismatch|com.a.app'], 2);
    assert.equal(lines.filter((l) => l.includes('token-address-mismatch')).length, 1, 'one log line per instance and address');
    assert.ok(!lines.join('\n').includes('aura1.'), 'never a token');
  } finally {
    console.warn = warn;
    report.stop();
  }
});
