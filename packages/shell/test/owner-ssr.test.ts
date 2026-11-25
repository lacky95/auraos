// D45 for a trusted system UI's server-side page render: the App Host router
// hands Settings and Nexus (their `system` installation, on a live owner
// session) a short-lived signed owner claim with each page request, and the
// shell takes it only next to the instance token of the instance it names.
// The router half runs against real sockets; the shell half calls the one
// principal resolver. The enforce decision is in phase3a-enforce-smoke.test.ts.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GATEWAY_IDENTITY_HEADER, OWNER_SSR_HEADER } from '@aura/core/host-rules';
import type { GatewayIdentityClaim } from '@aura/core';
import { createAppHostRouter } from '../server/app-hosts.mjs';
import { createAppHostAuth } from '../server/app-host-auth.mjs';
import {
  OWNER_SSR_CLAIM_TTL_S, signGatewayClaim, signOwnerSsrClaim, verifyGatewayClaim, verifyOwnerSsrClaim,
} from '../server/gateway-identity.mjs';
import { stripShellCredentials } from '../server/shell-credentials.mjs';
import type { GatewayOwnerDeps } from '../src/lib/access/identify.ts';
import { authenticate, type AuthDeps } from '../src/lib/auth.ts';

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

const SETTINGS = 'com.aura.settings';
const NEXUS = 'com.aura.nexus';
const COUNTER = 'com.example.counter';
const OWNER = { userId: 'default', sid: 'sess-1' };

// ── the router ──────────────────────────────────────────────────────────────

const BASE = 'desk.example';
/** label → [appId, installationId, scope] */
const APPS: Record<string, [string, string, string]> = {
  settings1234: [SETTINGS, 'inst-settings', 'system'],
  settingsuser: [SETTINGS, 'inst-settings-user', 'user'],
  nexus1234: [NEXUS, 'inst-nexus', 'system'],
  counter1234: [COUNTER, 'inst-counter', 'user'],
};
const installations = Object.fromEntries(Object.values(APPS).map(([appId, id, scope]) => [id, { appId, scope, state: 'active' }]));

const seen: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders }> = [];
// The app echoes the owner claim it got, as a careless page might: the browser must never see it.
const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
  const got = req.headers[OWNER_SSR_HEADER];
  res.writeHead(200, { 'content-type': 'text/plain', ...(got ? { [OWNER_SSR_HEADER]: got } : {}) });
  res.end('app');
});
const appPort = await listen(upstream);

const slot = (label: string, instanceId: string) => ({ slot: 1, label, instanceId, assignedAt: 1 });
const instanceOf = (label: string) => `${APPS[label]![0]}-${label}`;
let liveSessions = new Set<string>();
let registryDown = false;
const registry = {
  resolveLabel: async (label: string) => {
    const app = APPS[label];
    if (!app) return { status: 'unknown' };
    const s = slot(label, instanceOf(label));
    return {
      status: 'active', slot: s,
      record: { installationId: app[1], appId: app[0], instanceScope: { kind: 'user', userId: OWNER.userId }, baseName: label, state: 'active', slots: [s], createdAt: 1 },
    };
  },
  getInstallation: async (id: string) => {
    if (registryDown) throw new Error('kv down');
    return installations[id] ?? null;
  },
};
const svc = { registry, sessionLive: async (sid: string) => liveSessions.has(sid) };
const auth = createAppHostAuth({ secret: Buffer.alloc(32, 9) });
const appsList = async () => [...new Set(Object.values(APPS).map(([appId]) => appId))].map((appId) => ({
  manifest: { id: appId, name: appId, componentType: 'activity', hosts: [] },
  instances: Object.keys(APPS).filter((label) => APPS[label]![0] === appId)
    .map((label) => ({ instanceId: instanceOf(label), port: appPort, state: 'resumed', inPool: false, sandbox: 'proot' })),
}));
const front = http.createServer((_req, res) => res.end('desktop'));
createAppHostRouter({ appsList, services: async () => svc, auth, env: { AURA_DESKTOP_HOSTS: BASE } }).attach(front);
const port = await listen(front);

after(() => { for (const s of [upstream, front]) { s.closeAllConnections?.(); s.close(); } });
beforeEach(() => {
  liveSessions = new Set([OWNER.sid]);
  registryDown = false;
  seen.length = 0;
});

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(label: string, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ port, path, method, agent: false, headers: { host: `${label}--${BASE}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function signIn(label: string): Promise<string> {
  const [appId, installationId] = APPS[label]!;
  const { code } = auth.issueCode({
    aud: `http://${label}--${BASE}`, label, installationId, appId, slot: 1, ...OWNER, returnPath: '/',
  } as never);
  const r = await request(label, `/_aura/handoff?code=${code}`);
  assert.equal(r.status, 303, label);
  return String(r.headers['set-cookie']![0]).split(';')[0]!;
}

/** A page request on `label` with its app cookie; the owner claim the app got, verified, and the reply. */
async function page(label: string, opts: { method?: string; headers?: Record<string, string> } = {}) {
  const cookie = await signIn(label);
  seen.length = 0;
  const r = await request(label, '/apps', { cookie, ...(opts.headers ?? {}) }, opts.method ?? 'GET');
  const got = seen[0]?.headers[OWNER_SSR_HEADER];
  return { reply: r, raw: got, claim: typeof got === 'string' ? verifyOwnerSsrClaim(got) : null };
}

test('router: system Settings on a live owner session gets the owner claim, bound to its instance and session', async () => {
  const before = Math.floor(Date.now() / 1000);
  const { reply, claim } = await page('settings1234');
  assert.equal(reply.status, 200);
  assert.ok(claim, 'a claim that verifies');
  assert.equal(claim.appId, SETTINGS);
  assert.equal(claim.installationId, 'inst-settings');
  assert.equal(claim.instanceId, instanceOf('settings1234'));
  assert.deepEqual(claim.owner, OWNER);
  assert.ok(claim.exp - before <= OWNER_SSR_CLAIM_TTL_S + 1 && claim.exp - before >= OWNER_SSR_CLAIM_TTL_S - 1, String(claim.exp - before));
  // Nexus too.
  assert.equal((await page('nexus1234')).claim?.appId, NEXUS);
});

test('router: the claim never reaches the browser, even when the app echoes it', async () => {
  const { reply, raw } = await page('settings1234');
  assert.ok(raw);
  assert.equal(reply.headers[OWNER_SSR_HEADER], undefined);
  assert.ok(!Object.values(reply.headers).some((v) => String(v).includes(String(raw).split('.')[2]!)));
});

test('router: no claim for an ordinary app, a user-scope copy, a mutation, or an unreadable registry', async () => {
  const counter = await page('counter1234');
  assert.equal(counter.reply.status, 200);
  assert.equal(counter.raw, undefined, 'Counter');
  const userCopy = await page('settingsuser');
  assert.equal(userCopy.reply.status, 200, 'the copy is served');
  assert.equal(userCopy.raw, undefined, 'a same-id copy in user scope');
  const post = await page('settings1234', { method: 'POST', headers: { origin: `http://settings1234--${BASE}`, 'content-type': 'application/json' } });
  assert.equal(post.reply.status, 200);
  assert.equal(post.raw, undefined, 'POST');
  registryDown = true;
  const down = await page('settings1234');
  assert.equal(down.reply.status, 200);
  assert.equal(down.raw, undefined, 'fails closed');
});

test('router: a client-sent owner claim is stripped; a revoked session gets no page at all', async () => {
  const forged = signOwnerSsrClaim({ appId: SETTINGS, installationId: 'inst-settings', instanceId: instanceOf('settings1234'), ...OWNER });
  // To Counter: removed.
  const counter = await page('counter1234', { headers: { [OWNER_SSR_HEADER]: forged } });
  assert.equal(counter.reply.status, 200);
  assert.equal(counter.raw, undefined);
  // To Settings: replaced by the router's own.
  const settings = await page('settings1234', { headers: { [OWNER_SSR_HEADER]: 'agw1.forged.mac' } });
  assert.ok(settings.claim);
  assert.notEqual(settings.raw, 'agw1.forged.mac');
  // A revoked session: the router refuses before the app is reached.
  const cookie = await signIn('settings1234');
  liveSessions.clear();
  seen.length = 0;
  assert.equal((await request('settings1234', '/apps', { cookie })).status, 401);
  assert.equal(seen.length, 0);
});

test('the shell strips the owner claim from anything leaving for an app', () => {
  const token = signOwnerSsrClaim({ appId: SETTINGS, installationId: 'inst-settings', instanceId: 'com.aura.settings-1', ...OWNER });
  const headers = new Headers({ [OWNER_SSR_HEADER]: token, accept: 'text/html' });
  stripShellCredentials(headers, 'test');
  assert.equal(headers.get(OWNER_SSR_HEADER), null);
  assert.deepEqual(stripShellCredentials([OWNER_SSR_HEADER, token, 'accept', 'x'], 'test'), ['accept', 'x']);
  const node: Record<string, string> = { [OWNER_SSR_HEADER]: token };
  stripShellCredentials(node, 'test');
  assert.deepEqual(node, {});
});

// ── the claim itself ────────────────────────────────────────────────────────

test('an owner SSR claim and a gateway claim never stand in for each other', () => {
  const ssr = signOwnerSsrClaim({ appId: SETTINGS, installationId: 'inst-settings', instanceId: 'com.aura.settings-1', ...OWNER });
  assert.ok(verifyOwnerSsrClaim(ssr));
  assert.equal(verifyGatewayClaim(ssr, { method: 'GET', path: '/api/apps' }), null);
  const iat = Math.floor(Date.now() / 1000);
  const gw = signGatewayClaim({
    v: 1, appId: SETTINGS, installationId: 'inst-settings', instanceId: 'com.aura.settings-1', label: 'x', slot: 1,
    origin: 'http://x', userId: OWNER.userId, owner: OWNER, method: 'GET', path: '/api/apps', iat, exp: iat + 30,
  });
  assert.ok(verifyGatewayClaim(gw, { method: 'GET', path: '/api/apps' }));
  assert.equal(verifyOwnerSsrClaim(gw), null);
  // Expiry.
  assert.equal(verifyOwnerSsrClaim(ssr, { now: Date.now() + (OWNER_SSR_CLAIM_TTL_S + 2) * 1000 }), null);
  // An owner that isn't the claim's user.
  const mixed = signGatewayClaim({ ...JSON.parse(Buffer.from(ssr.split('.')[1]!, 'base64url').toString()), owner: { userId: 'other', sid: OWNER.sid } } as GatewayIdentityClaim);
  assert.equal(verifyOwnerSsrClaim(mixed), null);
});

// ── the shell: authenticate() ───────────────────────────────────────────────

const instances: Record<string, { appId: string; instanceId: string }> = {
  'com.aura.settings-1': { appId: SETTINGS, instanceId: 'com.aura.settings-1' },
  'com.aura.nexus-1': { appId: NEXUS, instanceId: 'com.aura.nexus-1' },
  'com.example.counter-1': { appId: COUNTER, instanceId: 'com.example.counter-1' },
};
const TOKENS: Record<string, { instanceId: string; sidecar?: string }> = {
  'aura1.settings': { instanceId: 'com.aura.settings-1' },
  'aura1.settings-db': { instanceId: 'com.aura.settings-1', sidecar: 'db' },
  'aura1.nexus': { instanceId: 'com.aura.nexus-1' },
  'aura1.counter': { instanceId: 'com.example.counter-1' },
};
const installedScope: Record<string, string> = { [SETTINGS]: 'system', [NEXUS]: 'system', [COUNTER]: 'user' };
const deps = {
  mgr: {
    tokens: { verify: (t: string) => TOKENS[t] ?? null },
    getInstance: (id: string) => instances[id],
    getManifest: (id: string) => (installedScope[id] ? { scopeId: installedScope[id] } : undefined),
  },
  ownerServices: (async () => svc) as unknown as GatewayOwnerDeps['services'],
  apiKeys: { verify: async () => null },
} as unknown as AuthDeps;

const settingsClaim = (over: Record<string, string> = {}) =>
  signOwnerSsrClaim({ appId: SETTINGS, installationId: 'inst-settings', instanceId: 'com.aura.settings-1', ...OWNER, ...over });
const shellRequest = (path: string, headers: Record<string, string>, method = 'GET') =>
  new Request(`http://127.0.0.1:3000${path}`, { method, headers });
async function who(path: string, headers: Record<string, string>, method = 'GET') {
  const p = await authenticate(shellRequest(path, headers, method), deps);
  assert.ok(!(p instanceof Response), `${method} ${path}: refused`);
  return p;
}

test('authenticate(): Settings\' token plus its owner claim is the owner through Settings', async () => {
  const p = await who('/api/apps', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: settingsClaim() });
  assert.deepEqual(p, {
    kind: 'user', userId: OWNER.userId, role: 'owner', sessionId: OWNER.sid, verification: 'verified',
    through: { appId: SETTINGS, instanceId: 'com.aura.settings-1' },
  });
  const nexus = signOwnerSsrClaim({ appId: NEXUS, installationId: 'inst-nexus', instanceId: 'com.aura.nexus-1', ...OWNER });
  assert.equal((await who('/api/nexus/installed', { authorization: 'Bearer aura1.nexus', [OWNER_SSR_HEADER]: nexus })).kind, 'user');
});

test('authenticate(): the claim is ignored without the right token, session, scope, method or path', async () => {
  const expired = (() => {
    const iat = Math.floor(Date.now() / 1000) - 3600;
    const body = { v: 1, use: 'owner-ssr', appId: SETTINGS, installationId: 'inst-settings', instanceId: 'com.aura.settings-1', userId: OWNER.userId, owner: OWNER, iat, exp: iat + 60 };
    return signGatewayClaim(body as unknown as GatewayIdentityClaim);
  })();
  const cases: Array<[string, string, Record<string, string>, string, string]> = [
    ['no token', '/api/apps', { [OWNER_SSR_HEADER]: settingsClaim() }, 'GET', 'anonymous'],
    ['expired', '/api/apps', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: expired }, 'GET', 'instance'],
    ['another instance\'s token', '/api/apps', { authorization: 'Bearer aura1.counter', [OWNER_SSR_HEADER]: settingsClaim() }, 'GET', 'instance'],
    ['Nexus replaying Settings\' claim', '/api/apps', { authorization: 'Bearer aura1.nexus', [OWNER_SSR_HEADER]: settingsClaim() }, 'GET', 'instance'],
    ['a sidecar token', '/api/apps', { authorization: 'Bearer aura1.settings-db', [OWNER_SSR_HEADER]: settingsClaim() }, 'GET', 'instance'],
    ['Counter with a claim of its own', '/api/apps', {
      authorization: 'Bearer aura1.counter',
      [OWNER_SSR_HEADER]: signOwnerSsrClaim({ appId: COUNTER, installationId: 'inst-counter', instanceId: 'com.example.counter-1', ...OWNER }),
    }, 'GET', 'instance'],
    ['a dead session', '/api/apps', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: settingsClaim({ sid: 'sess-gone' }) }, 'GET', 'instance'],
    ['the user-scope installation', '/api/apps', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: settingsClaim({ installationId: 'inst-settings-user' }) }, 'GET', 'instance'],
    ['a mutation', '/api/admin/apps/enabled', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: settingsClaim() }, 'POST', 'instance'],
    ['a path outside Settings\' scope', '/api/nexus/installed', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: settingsClaim() }, 'GET', 'instance'],
    ['a forged signature', '/api/apps', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: settingsClaim().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }, 'GET', 'instance'],
  ];
  for (const [why, path, headers, method, kind] of cases) {
    assert.equal((await who(path, headers, method)).kind, kind, why);
  }
  // Settings shadowed by a user-scope copy: the installed one no longer qualifies.
  installedScope[SETTINGS] = 'user';
  try {
    assert.equal((await who('/api/apps', { authorization: 'Bearer aura1.settings', [OWNER_SSR_HEADER]: settingsClaim() })).kind, 'instance');
  } finally {
    installedScope[SETTINGS] = 'system';
  }
  // Next to a gateway claim it is not read at all: the gateway's own rules apply.
  const iat = Math.floor(Date.now() / 1000);
  const gateway = signGatewayClaim({
    v: 1, appId: COUNTER, installationId: 'inst-counter', instanceId: 'com.example.counter-1', label: 'x', slot: 1,
    origin: 'http://x', userId: OWNER.userId, method: 'GET', path: '/api/apps', iat, exp: iat + 30,
  });
  assert.equal((await who('/api/apps', { [GATEWAY_IDENTITY_HEADER]: gateway, [OWNER_SSR_HEADER]: settingsClaim() })).kind, 'instance');
});
