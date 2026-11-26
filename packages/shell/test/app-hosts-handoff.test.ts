// The App Host router, against real sockets: a fake app,
// a fake shell API, and a fake registry. Covers the handoff, the app cookie,
// the Host and Origin checks, and slot routing.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { activityHeaders, classifyHost, createAppHostRouter } from '../server/app-hosts.mjs';
import { browserDocumentRequest, hostListed, hostParses, hostPolicy } from '../server/host-policy.mjs';
import { createAppHostAuth, safeReturnPath } from '../server/app-host-auth.mjs';
import { POST as handoffRoute } from '../src/pages/api/app-hosts/handoff.ts';
import { ALL as machineProxyRoute } from '../src/pages/api/proxy/[id]/[...path].ts';

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

const BASE = 'desk.example';
const HOST = `notes1234--${BASE}`;
const ORIGIN = `http://${HOST}`;
const INSTALL = '11111111-1111-4111-8111-111111111111';

const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url ?? '', headers: req.headers });
  res.setHeader('set-cookie', ['own=1; Path=/', 'aura_app=forged; Path=/', 'aura_session=forged; Domain=desk.example']);
  res.setHeader('x-frame-options', 'DENY');
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('app');
});
upstream.on('upgrade', (req, socket) => {
  seen.push({ url: req.url ?? '', headers: req.headers });
  socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
});
const appPort = await listen(upstream);

let startCalls = 0;
let startDelayMs = 0;
const shellApi = http.createServer((req, res) => {
  startCalls += 1;
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ instanceId: 'io.acme.notes-9' }));
  }, startDelayMs);
  req.resume();
});
const shellPort = await listen(shellApi);

const scope = { kind: 'user', userId: 'default' } as const;
const slotOf = (slot: number, label: string, instanceId: string | null) => ({ slot, label, instanceId, assignedAt: instanceId ? 1 : null });
const record = (slots: any[]) => ({
  installationId: INSTALL, appId: 'io.acme.notes', instanceScope: scope, baseName: 'notes1234', state: 'active', slots, createdAt: 1,
});
const live = (instanceId: string, extra = {}) => ({ instanceId, port: appPort, state: 'resumed', inPool: false, sandbox: 'proot', upstreamHost: '127.0.0.1', ...extra });

let labels: Record<string, any>;
let apps: any[];
let liveSessions: Set<string>;
let registryDown = false;

const registry = {
  resolveLabel: async (label: string) => {
    if (registryDown) throw new Error('kv down');
    return labels[label] ?? { status: 'unknown' };
  },
};
const svc = { registry, sessionLive: async (sid: string) => liveSessions.has(sid) };

let nowMs = 1_000_000;
const auth = createAppHostAuth({ secret: Buffer.alloc(32, 7), now: () => nowMs });
const embedCalls: unknown[] = [];
let embedOrigins: string[] = [];
const env = { AURA_TRUSTED_PROXIES: '10.9.9.9', AURA_DESKTOP_HOSTS: BASE };
const router = createAppHostRouter({
  appsList: async () => apps, shellPort: String(shellPort), services: async () => svc, auth, env,
  embedAncestors: (ctx: unknown) => { embedCalls.push(ctx); return embedOrigins; },
});
const front = http.createServer((_req, res) => res.end('desktop'));
front.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 418 Desktop\r\n\r\n'));
router.attach(front);
const port = await listen(front);

after(() => { for (const s of [upstream, shellApi, front]) { s.closeAllConnections?.(); s.close(); } });

beforeEach(() => {
  labels = { notes1234: { status: 'active', record: record([slotOf(1, 'notes1234', 'io.acme.notes')]), slot: slotOf(1, 'notes1234', 'io.acme.notes') } };
  apps = [{ manifest: { id: 'io.acme.notes', name: 'Notes', componentType: 'activity', hosts: [] }, instances: [live('io.acme.notes')] }];
  liveSessions = new Set(['sess-1']);
  registryDown = false;
  startCalls = 0;
  startDelayMs = 0;
  seen.length = 0;
  embedOrigins = [];
  embedCalls.length = 0;
});

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };
function get(host: string, path = '/', headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ port, path, method, agent: false, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function upgrade(host: string, path: string, headers: Record<string, string>) {
  return new Promise<string>((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${extra}\r\n`);
    setTimeout(() => sock.destroy(), 300);
  });
}

const issue = (over: Record<string, unknown> = {}) => auth.issueCode({
  aud: ORIGIN, label: 'notes1234', installationId: INSTALL, appId: 'io.acme.notes', slot: 1,
  userId: 'default', sid: 'sess-1', returnPath: '/start?x=1', ...over,
} as never).code;

async function signIn(): Promise<string> {
  const r = await get(HOST, `/_aura/handoff?code=${issue()}`);
  assert.equal(r.status, 303);
  return String(r.headers['set-cookie']![0]).split(';')[0]!;
}

// ── handoff ─────────────────────────────────────────────────────────────────

test('a handoff sets a host-only Lax cookie and redirects to its path', async () => {
  const r = await get(HOST, `/_aura/handoff?code=${issue()}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/start?x=1');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  const cookie = String(r.headers['set-cookie']![0]);
  assert.match(cookie, /^aura_app=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
  assert.doesNotMatch(cookie, /Domain/i);
});

test('on HTTPS from a trusted proxy the cookie is __Host- and Secure', async () => {
  const code = issue({ aud: `https://${HOST}` });
  const r = await new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      port, path: `/_aura/handoff?code=${code}`, localAddress: '127.0.0.1', agent: false,
      headers: { host: HOST, 'x-forwarded-proto': 'https' },
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: '', headers: res.headers })); });
    req.on('error', reject);
    req.end();
  });
  // This peer is not the configured proxy, so the code's https audience fails.
  assert.equal(r.status, 403);

  const trustedRouter = createAppHostRouter({
    appsList: async () => apps, services: async () => svc, auth, env: { AURA_TRUSTED_PROXIES: '127.0.0.1', AURA_DESKTOP_HOSTS: BASE },
  });
  const edgeFront = http.createServer((_q, s) => s.end('desktop'));
  trustedRouter.attach(edgeFront);
  const edgePort = await listen(edgeFront);
  try {
    const good = issue({ aud: `https://${HOST}` });
    const viaEdge = await new Promise<Reply>((resolve, reject) => {
      const req = http.request({
        port: edgePort, path: `/_aura/handoff?code=${good}`, agent: false,
        headers: { host: HOST, 'x-forwarded-proto': 'https' },
      }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: '', headers: res.headers })); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(viaEdge.status, 303);
    assert.match(String(viaEdge.headers['set-cookie']![0]), /^__Host-aura_app=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  } finally { edgeFront.closeAllConnections?.(); edgeFront.close(); }
});

test('a request served from an App Host is marked for the app, and the mark cannot be forged away', async () => {
  const cookie = await signIn();
  await get(HOST, '/page', { cookie, 'x-aura-frame-route': 'forged' });
  assert.equal(seen.at(-1)!.headers['x-aura-frame-route'], 'host');
});

test('a code works once, even when redeemed concurrently', async () => {
  const code = issue();
  const replies = await Promise.all([1, 2, 3, 4].map(() => get(HOST, `/_aura/handoff?code=${code}`)));
  assert.equal(replies.filter((r) => r.status === 303).length, 1);
  assert.equal(replies.filter((r) => r.status === 403).length, 3);
});

test('an expired code is refused', async () => {
  const code = issue();
  nowMs += 60_001;
  try { assert.equal((await get(HOST, `/_aura/handoff?code=${code}`)).status, 403); }
  finally { nowMs -= 60_001; }
});

test('a code for another label is refused and burned', async () => {
  labels['other5678'] = { status: 'active', record: { ...record([]), appId: 'io.acme.notes' }, slot: slotOf(1, 'other5678', 'io.acme.notes') };
  const code = issue();
  assert.equal((await get(`other5678--${BASE}`, `/_aura/handoff?code=${code}`)).status, 403);
  assert.equal((await get(HOST, `/_aura/handoff?code=${code}`)).status, 403);
});

test('a code for another slot or installation is refused', async () => {
  assert.equal((await get(HOST, `/_aura/handoff?code=${issue({ slot: 2 })}`)).status, 403);
  assert.equal((await get(HOST, `/_aura/handoff?code=${issue({ installationId: '22222222-2222-4222-8222-222222222222' })}`)).status, 403);
});

test('a code from a dead session sets no cookie', async () => {
  const r = await get(HOST, `/_aura/handoff?code=${issue({ sid: 'gone' })}`);
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('return paths stay on this origin', () => {
  for (const bad of [
    'https://evil.example/', '//evil.example', '/\\evil.example', '/.//evil.example', '/..//evil.example',
    '/a/..//evil.example', '/x\r\nSet-Cookie: a=b', '', 'relative', '/_aura/os/x', '/%5f%61ura/handoff', 7, null,
  ]) assert.equal(safeReturnPath(bad), null, String(bad));
  assert.equal(safeReturnPath('/a/b?c=1#d'), '/a/b?c=1#d');
});

test('a stored open redirect is refused at redemption', async () => {
  const r = await get(HOST, `/_aura/handoff?code=${issue({ returnPath: '/.//evil.example' })}`);
  assert.equal(r.status, 403);
  assert.equal(r.headers.location, undefined);
});

// ── the app cookie ──────────────────────────────────────────────────────────

test('without a valid cookie nothing reaches the app', async () => {
  for (const cookie of [undefined, 'aura_app=forged', 'aura_app=a.b']) {
    const r = await get(HOST, '/', cookie ? { cookie } : {});
    assert.equal(r.status, 401);
  }
  assert.equal(seen.length, 0);
});

test('a planted cookie does not hide or replace the valid one', async () => {
  const good = await signIn();
  for (const cookie of [`aura_app=planted.bad; ${good}`, `${good}; aura_app=planted.bad`]) {
    assert.equal((await get(HOST, '/', { cookie })).status, 200);
  }
  assert.equal((await get(HOST, '/', { cookie: 'aura_app=planted.bad; aura_app=other.bad' })).status, 401);
});

test('a cookie from one App Host is refused on another', async () => {
  const good = await signIn();
  labels['other5678'] = { status: 'active', record: record([]), slot: slotOf(1, 'other5678', 'io.acme.notes') };
  assert.equal((await get(`other5678--${BASE}`, '/', { cookie: good })).status, 401);
});

test('the cookie dies with its session', async () => {
  const good = await signIn();
  assert.equal((await get(HOST, '/', { cookie: good })).status, 200);
  liveSessions.delete('sess-1');
  assert.equal((await get(HOST, '/', { cookie: good })).status, 401);
});

test('Aura credentials and identity claims never reach the app', async () => {
  const good = await signIn();
  await get(HOST, '/', {
    cookie: `${good}; aura_session=S; __Host-aura_session=T; mine=1`,
    authorization: 'Bearer aura1.instance',
    'x-aura-gateway-identity': 'forged', 'x-aura-app-id': 'io.evil', 'x-aura-internal-service': 'forged',
    forwarded: 'for=1.1.1.1', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https',
  });
  const h = seen.at(-1)!.headers;
  assert.equal(h.cookie, 'mine=1');
  assert.equal(h.authorization, undefined);
  assert.equal(h['x-aura-gateway-identity'], undefined);
  assert.equal(h['x-aura-internal-service'], undefined);
  assert.equal(h.forwarded, undefined);
  assert.equal(h['x-aura-app-id'], 'io.acme.notes');
  assert.equal(h['x-forwarded-host'], HOST);
  assert.equal(h['x-forwarded-proto'], 'http');
});

test('an app bearer of its own passes through', async () => {
  const good = await signIn();
  await get(HOST, '/', { cookie: good, authorization: 'Bearer app-token' });
  assert.equal(seen.at(-1)!.headers.authorization, 'Bearer app-token');
});

test('the response is framed by the exact shell (and its own pages) only, and cannot set Aura cookies', async () => {
  const good = await signIn();
  const r = await get(HOST, '/', { cookie: good });
  assert.equal(r.headers['content-security-policy'], `frame-ancestors 'self' http://${BASE}`);
  assert.equal(r.headers['x-frame-options'], undefined);
  assert.deepEqual(r.headers['set-cookie'], ['own=1; Path=/']);
});

test('the Browser App Host may not frame its own pages, only the shell may', async () => {
  // Its engine frames any site with allow-same-origin: a redirect back onto
  // its own App Host must be refused by the browser before any script runs.
  labels.notes1234!.record.appId = 'com.aura.browser';
  apps = [{ manifest: { id: 'com.aura.browser', name: 'Browser', componentType: 'activity', hosts: [] }, instances: [live('io.acme.notes')] }];
  const good = await signIn();
  const r = await get(HOST, '/', { cookie: good });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-security-policy'], `frame-ancestors http://${BASE}`);
});

test('embedding adds granted origins only on an embed document', async () => {
  const good = await signIn();
  embedOrigins = ['http://terminalx1--desk.example', 'javascript:alert(1)'];
  assert.equal((await get(HOST, '/', { cookie: good })).headers['content-security-policy'], `frame-ancestors 'self' http://${BASE}`);
  assert.equal(embedCalls.length, 0);
  const r = await get(HOST, '/?embed=1', { cookie: good });
  assert.equal(r.headers['content-security-policy'], `frame-ancestors 'self' http://${BASE} http://terminalx1--desk.example`);
});

test('the embed grant is asked for asynchronously, with the route and edge', async () => {
  const good = await signIn();
  const router2 = createAppHostRouter({
    appsList: async () => apps, shellPort: String(shellPort), services: async () => svc, auth, env,
    embedAncestors: async (ctx: any) => {
      assert.equal(ctx.base, BASE);
      assert.equal(ctx.edge.origin, ORIGIN);
      assert.equal(ctx.registry, registry);
      return ['http://terminalx1--desk.example'];
    },
  });
  const front2 = http.createServer((_req, res) => res.end('desktop'));
  router2.attach(front2);
  const port2 = await listen(front2);
  try {
    const r = await new Promise<Reply>((resolve, reject) => {
      const req = http.request({ port: port2, path: '/?embed=1', agent: false, headers: { host: HOST, cookie: good } }, (res) => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: '', headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.headers['content-security-policy'], `frame-ancestors 'self' http://${BASE} http://terminalx1--desk.example`);
  } finally { front2.close(); }
});

test('an embedded page\'s socket needs the embed grant its frame needed', async () => {
  const good = await signIn();
  const path = '/ws?_aura_session=s&embed=1&session=s&_aura_embedder=terminalx1';
  assert.match(await upgrade(HOST, path, { Cookie: good, Origin: ORIGIN }), /^HTTP\/1\.1 403/);
  assert.equal(seen.length, 0);
  embedOrigins = ['http://terminalx1--desk.example'];
  assert.match(await upgrade(HOST, path, { Cookie: good, Origin: ORIGIN }), /^HTTP\/1\.1 101/);
  // The window's own socket needs no embed grant.
  embedOrigins = [];
  assert.match(await upgrade(HOST, '/ws?_aura_session=s', { Cookie: good, Origin: ORIGIN }), /^HTTP\/1\.1 101/);
});

test('the Terminal answers its own origin only, while a navigation may still arrive', async () => {
  const TERM = 'term1234';
  const termHost = `${TERM}--${BASE}`;
  const termOrigin = `http://${termHost}`;
  const termRecord = { ...record([slotOf(1, TERM, 'com.aura.terminal-1')]), appId: 'com.aura.terminal', baseName: TERM };
  labels[TERM] = { status: 'active', record: termRecord, slot: slotOf(1, TERM, 'com.aura.terminal-1') };
  apps.push({ manifest: { id: 'com.aura.terminal', name: 'Terminal', componentType: 'activity', hosts: [] }, instances: [live('com.aura.terminal-1')] });
  const code = auth.issueCode({
    aud: termOrigin, label: TERM, installationId: INSTALL, appId: 'com.aura.terminal', slot: 1,
    userId: 'default', sid: 'sess-1', returnPath: '/',
  } as never).code;
  const signedIn = await get(termHost, `/_aura/handoff?code=${code}`);
  assert.equal(signedIn.status, 303);
  const cookie = String(signedIn.headers['set-cookie']![0]).split(';')[0]!;
  const sibling = `http://notes1234--${BASE}`;
  // A sibling page's fetch, with this host's cookie: refused, reads too.
  for (const h of <Array<Record<string, string>>>[
    { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', origin: sibling },
    { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', origin: 'http://evil.example' },
  ]) {
    assert.equal((await get(termHost, '/api/sessions', { cookie, ...h })).status, 403, JSON.stringify(h));
  }
  assert.equal((await get(termHost, '/api/sessions?id=x', { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }, 'DELETE')).status, 403);
  // Plain HTTP: no Sec-Fetch-*, and a no-cors GET carries no Origin either.
  assert.equal((await get(termHost, '/api/sessions', { cookie })).status, 403);
  assert.equal((await get(termHost, '/mcp/terminal', { cookie })).status, 403);
  // The header that would pass needs a preflight, refused for another origin.
  assert.equal((await get(termHost, '/api/sessions', { cookie, origin: sibling, 'access-control-request-method': 'GET' }, 'OPTIONS')).status, 403);
  assert.equal(seen.length, 0);
  // Its own page, and a frame the Shell or an embedder navigates.
  assert.equal((await get(termHost, '/api/sessions', { cookie, 'x-aura-same-origin': '1' })).status, 200);
  assert.equal(seen.at(-1)!.headers['x-aura-same-origin'], undefined, 'not passed on to the app');
  assert.equal((await get(termHost, '/api/sessions', { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-aura-same-origin': '1' })).status, 200);
  assert.equal((await get(termHost, '/', { cookie })).status, 200, 'its page and assets need no header');
  assert.equal((await get(termHost, '/api/os/theme.css', { cookie })).status, 200, 'nor the SDK\'s shell-asset redirect');
  assert.equal((await get(termHost, '/api/sessions?id=x', { cookie, origin: termOrigin, 'sec-fetch-site': 'same-origin' }, 'DELETE')).status, 200);
  const nav = await get(termHost, '/?embed=1', { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' });
  assert.equal(nav.status, 200);
  assert.equal(nav.headers['content-security-policy'], `frame-ancestors 'self' http://${BASE}`);
  // The PTY socket: exact Origin only.
  assert.match(await upgrade(termHost, '/ws', { Cookie: cookie, Origin: sibling }), /^HTTP\/1\.1 403/);
  assert.match(await upgrade(termHost, '/ws', { Cookie: cookie, Origin: termOrigin }), /^HTTP\/1\.1 101/);
  // Another app keeps its cross-origin reads.
  const good = await signIn();
  assert.equal((await get(HOST, '/', { cookie: good, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' })).status, 200);
});

test('with no embed grant, an embed document is framed by the shell only', async () => {
  const good = await signIn();
  const r = await get(HOST, '/?embed=1', { cookie: good });
  assert.equal(r.headers['content-security-policy'], `frame-ancestors 'self' http://${BASE}`);
});

// ── reserved paths ──────────────────────────────────────────────────────────

test('/_aura/* never reaches the app, in any spelling', async () => {
  const good = await signIn();
  for (const path of ['/_aura/', '/_aura/x', '/_AURA/x', '/%5faura/x', '/a/../_aura/x', '//_aura/x', '/_aura/os']) {
    const r = await get(HOST, path, { cookie: good });
    assert.equal(r.status, 404, path);
  }
  assert.equal(seen.length, 0);
});

test('an app\'s /api/lifecycle routes never reach it through its App Host, in any spelling', async () => {
  const good = await signIn();
  for (const path of ['/api/lifecycle/onDestroy', '/api/lifecycle/health', '/API/Lifecycle/onStop', '/api/%6cifecycle/onStop', '/a/../api/lifecycle/x', '//api//lifecycle']) {
    for (const method of ['GET', 'POST']) {
      const r = await get(HOST, path, { cookie: good, 'x-aura-lifecycle': 'guess' }, method);
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  }
  const up = await upgrade(HOST, '/api/lifecycle/onDestroy', { cookie: good, origin: ORIGIN });
  assert.match(up, /^HTTP\/1\.1 404/);
  assert.equal(seen.length, 0);
  // Any other path still reaches the app, without a caller's lifecycle header.
  const r = await get(HOST, '/api/lifecyclex', { cookie: good, 'x-aura-lifecycle': 'guess' });
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1)!.headers['x-aura-lifecycle'], undefined);
});

test('an absolute-form target cannot hide a reserved path', async () => {
  const good = await signIn();
  const r = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    sock.write(`GET http://x/_aura/os/secret HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${good}\r\nConnection: close\r\n\r\n`);
  });
  assert.match(r, /^HTTP\/1\.1 400/);
  assert.equal(seen.length, 0);
});

test('the gateway and runtime need the cookie', async () => {
  assert.equal((await get(HOST, '/_aura/runtime.js')).status, 401);
  assert.equal((await get(HOST, '/_aura/os/apps')).status, 401);
  const good = await signIn();
  assert.notEqual((await get(HOST, '/_aura/runtime.js', { cookie: good })).status, 401);
  assert.notEqual((await get(HOST, '/_aura/os/apps', { cookie: good })).status, 401);
  assert.equal(seen.length, 0);
});

// ── Host and forwarded headers ──────────────────────────────────────────────

test('classifyHost sorts every access path', () => {
  const kinds: Array<[string, string]> = [
    ['notes--10-0-0-2.nip.io:3000', 'app'], ['notes--os.aura.localhost:3000', 'app'], ['notes--box.example.com', 'app'],
    ['127.0.0.1:3000', 'shell'], ['[::1]:3000', 'shell'], ['10.0.0.2:3000', 'shell'], ['localhost:3000', 'shell'],
    ['aura.localhost:3000', 'shell'], ['10-0-0-2.nip.io:3000', 'shell'], ['box.example.com', 'shell'],
    ['aura-shell:3000', 'shell'], ['xn--bcher-kva.example', 'shell'],
    ['notes--localhost:3000', 'unknown'], ['aura--x.example', 'unknown'], ['bad host', 'unknown'], ['', 'unknown'],
  ];
  for (const [host, kind] of kinds) assert.equal(classifyHost(host).kind, kind, host);
});

test('X-Forwarded-Host from an untrusted peer cannot select an App Host', async () => {
  const r = await get(BASE, '/', { 'x-forwarded-host': HOST });
  assert.equal(r.body, 'desktop');
  assert.equal(seen.length, 0);
});

test('X-Forwarded-Proto from an untrusted peer cannot change the cookie audience', async () => {
  const code = issue();
  const r = await get(HOST, `/_aura/handoff?code=${code}`, { 'x-forwarded-proto': 'https' });
  assert.equal(r.status, 303);
  assert.match(String(r.headers['set-cookie']![0]), /^aura_app=/);
});

test('a spoofed Host gets a cookie that is useless on the real one', async () => {
  const good = await signIn();
  assert.equal((await get(`notes1234--evil.example`, '/', { cookie: good })).status, 400, 'an unlisted base is refused outright');
  const lax = createAppHostRouter({ appsList: async () => apps, services: async () => svc, auth, env: { ...env, AURA_HOST_POLICY: 'report' } });
  const server = http.createServer((_q, s) => s.end('desktop'));
  lax.attach(server);
  const laxPort = await listen(server);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ port: laxPort, agent: false, headers: { host: 'notes1234--evil.example', cookie: good } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
    });
    assert.equal(status, 401, 'and in report mode the cookie is useless there');
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('an unknown or malformed Host is refused by default, and served only in report mode', async () => {
  // An App Host name no app uses is 404 in both (see below), never the desktop.
  assert.equal((await get('zzz--desk.example')).status, 404);
  for (const host of ['bad_host', 'a..b', 'a..b:3000', 'unknown.example']) {
    const r = await get(host);
    assert.equal(r.status, 400, host);
    assert.notEqual(r.body, 'desktop', host);
  }
  assert.equal((await get('notes1234--a..b')).status, 404, 'App Host shaped on a base that carries none');
  assert.match(await upgrade('a..b', '/os-events/?EIO=4&transport=websocket', {}), /^HTTP\/1\.1 400/);
  const strict = createAppHostRouter({
    appsList: async () => apps, services: async () => svc, auth, env: { AURA_HOST_POLICY: 'report', AURA_DESKTOP_HOSTS: 'desk.example' },
  });
  const server = http.createServer((_q, s) => s.end('desktop'));
  strict.attach(server);
  const strictPort = await listen(server);
  const at = (host: string) => new Promise<number>((resolve, reject) => {
    http.get({ port: strictPort, agent: false, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
  try {
    assert.equal(await at('zzz--desk.example'), 404);
    assert.equal(await at('bad_host'), 200, 'report mode serves it and logs it');
    assert.equal(await at('a..b'), 200);
    assert.equal(await at('10.0.0.2:3000'), 200);
    assert.equal(await at('aura-shell:3000'), 200);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('DNS rebinding: only listed custom domains are served, and every other access path stays', async () => {
  const listed = { AURA_DESKTOP_HOSTS: ' Box.Example.com:443 , desk.example. ' };
  const cls = (h: string) => hostListed(classifyHost(h), listed);
  for (const h of [
    '127.0.0.1:3000', '[::1]:3000', '10.0.0.2:3000', '203.0.113.5:3000',      // loopback, LAN IP (setup mode), any IP
    'localhost:3000', 'aura.localhost:3000', 'os.aura.localhost:3000',          // loopback names
    '10-0-0-2.nip.io:3000', '127-0-0-1.nip.io:3000', 'notes--10-0-0-2.nip.io:3000',
    'aura-shell:3000',                                                          // a container name
    'box.example.com', 'notes1234--box.example.com', 'desk.example:3000',       // configured custom domains
  ]) assert.equal(cls(h), true, h);
  for (const h of ['evil.example', 'rebind.attacker.com:3000', 'notes1234--evil.example', 'sub.box.example.com', 'bad_host', '']) {
    assert.equal(cls(h), false, h);
  }
  assert.equal(hostListed(classifyHost('box.example.com'), {}), false, 'nothing listed: no custom domain');
  assert.equal(hostPolicy({}), 'enforce', 'enforce by default');
  assert.equal(hostPolicy({ AURA_HOST_POLICY: 'report' }), 'report');
  assert.equal(hostPolicy({ AURA_HOST_POLICY: 'bogus' }), 'enforce');

  const strict = createAppHostRouter({
    appsList: async () => apps, services: async () => svc, auth, env: { AURA_DESKTOP_HOSTS: 'desk.example' },
  });
  const server = http.createServer((_q, s) => s.end('desktop'));
  strict.attach(server);
  const strictPort = await listen(server);
  const at = (host: string) => new Promise<number>((resolve, reject) => {
    http.get({ port: strictPort, agent: false, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
  try {
    for (const h of ['desk.example', '127.0.0.1:3000', '[::1]:3000', '10.0.0.2:3000', '10-0-0-2.nip.io:3000', '127-0-0-1.nip.io:3000',
      'os.aura.localhost:3000', 'localhost:3000', 'aura-shell:3000']) {
      assert.equal(await at(h), 200, h);
    }
    assert.equal(await at('rebind.attacker.com'), 400);
    assert.equal(await at('notes1234--rebind.attacker.com'), 400);
    assert.equal(await at(HOST), 401, 'a listed base still routes its App Hosts');
  } finally { server.closeAllConnections?.(); server.close(); }
  // The default router refuses an unlisted custom domain too.
  assert.equal((await get('rebind.attacker.com')).status, 400);
});

// ── Origin ──────────────────────────────────────────────────────────────────

test('a WebSocket needs the cookie and the exact Origin', async () => {
  const good = await signIn();
  assert.match(await upgrade(HOST, '/ws', { Cookie: good, Origin: ORIGIN }), /^HTTP\/1\.1 101/);
  const h = seen.at(-1)!.headers;
  assert.equal(h.cookie, undefined);
  seen.length = 0;
  assert.match(await upgrade(HOST, '/ws', { Cookie: good, Origin: `http://other5678--${BASE}` }), /^HTTP\/1\.1 403/);
  assert.match(await upgrade(HOST, '/ws', { Cookie: good, Origin: `http://${BASE}` }), /^HTTP\/1\.1 403/);
  assert.match(await upgrade(HOST, '/ws', { Cookie: good }), /^HTTP\/1\.1 403/);
  assert.match(await upgrade(HOST, '/ws', { Origin: ORIGIN }), /^HTTP\/1\.1 401/);
  assert.match(await upgrade(HOST, '/_aura/os/ws', { Cookie: good, Origin: ORIGIN }), /^HTTP\/1\.1 404/);
  assert.equal(seen.length, 0);
});

test('the gateway mux upgrade needs the cookie and exact Origin, and never reaches the app', async () => {
  const good = await signIn();
  const mux = '/_aura/os/sse-mux';
  assert.match(await upgrade(HOST, mux, { Origin: ORIGIN }), /^HTTP\/1\.1 401/);
  assert.match(await upgrade(HOST, mux, { Cookie: good, Origin: `http://other5678--${BASE}` }), /^HTTP\/1\.1 403/);
  assert.doesNotMatch(await upgrade(HOST, mux, { Cookie: good, Origin: ORIGIN }), /^HTTP\/1\.1 (401|403|404)/);
  assert.equal(seen.length, 0);
});

test('SSE, socket.io polling and writes refuse another origin', async () => {
  const good = await signIn();
  const sibling = `http://other5678--${BASE}`;
  assert.equal((await get(HOST, '/events', { cookie: good, accept: 'text/event-stream', origin: sibling })).status, 403);
  assert.equal((await get(HOST, '/events', { cookie: good, accept: 'text/event-stream', 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await get(HOST, '/socket.io/?EIO=4', { cookie: good, origin: sibling })).status, 403);
  assert.equal((await get(HOST, '/save', { cookie: good, origin: sibling }, 'POST')).status, 403);
  assert.equal(seen.length, 0);
  assert.equal((await get(HOST, '/events', { cookie: good, accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await get(HOST, '/save', { cookie: good, origin: ORIGIN }, 'POST')).status, 200);
});

// ── labels and slots ────────────────────────────────────────────────────────

test('a retired label is 410 and a reserved label 404', async () => {
  labels['gone1234'] = { status: 'retired', tombstone: { label: 'gone1234', installationId: INSTALL, appId: 'io.acme.notes', retiredAt: 1 } };
  labels['kept1234'] = { status: 'reserved', record: record([]), slot: slotOf(1, 'kept1234', null) };
  assert.equal((await get(`gone1234--${BASE}`)).status, 410);
  assert.equal((await get(`kept1234--${BASE}`)).status, 404);
  assert.match(await upgrade(`gone1234--${BASE}`, '/ws', { Origin: `http://gone1234--${BASE}` }), /^HTTP\/1\.1 410/);
});

test('a warm-pool member never gets traffic', async () => {
  const good = await signIn();
  labels['notes1234'] = { status: 'active', record: record([slotOf(1, 'notes1234', null)]), slot: slotOf(1, 'notes1234', null) };
  apps[0].instances = [live('io.acme.notes-pool', { inPool: true })];
  startDelayMs = 20;
  const r = await get(HOST, '/', { cookie: good });
  assert.equal(r.status, 503);
  assert.equal(seen.length, 0);

  // Assigned to a pool member: still not routed.
  labels['notes1234'] = { status: 'active', record: record([slotOf(1, 'notes1234', 'io.acme.notes-pool')]), slot: slotOf(1, 'notes1234', 'io.acme.notes-pool') };
  assert.equal((await get(HOST, '/', { cookie: good })).status, 503);
  assert.equal(seen.length, 0);
  await new Promise((r) => setTimeout(r, 60));   // let the slot-1 start from above finish
});

test('concurrent requests ask for one slot-1 start', async () => {
  const fresh = 'freshlabel1';
  const rec = { ...record([slotOf(1, fresh, null)]), installationId: '33333333-3333-4333-8333-333333333333' };
  labels[fresh] = { status: 'active', record: rec, slot: slotOf(1, fresh, null) };
  apps[0].instances = [];
  startDelayMs = 60;
  const code = auth.issueCode({
    aud: `http://${fresh}--${BASE}`, label: fresh, installationId: rec.installationId, appId: 'io.acme.notes',
    slot: 1, userId: 'default', sid: 'sess-1', returnPath: '/',
  }).code;
  const signed = await get(`${fresh}--${BASE}`, `/_aura/handoff?code=${code}`);
  const cookie = String(signed.headers['set-cookie']![0]).split(';')[0]!;
  const replies = await Promise.all(Array.from({ length: 8 }, () => get(`${fresh}--${BASE}`, '/', { cookie })));
  assert.ok(replies.every((r) => r.status === 503));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(startCalls, 1);
});

test('a running instance without the slot gets a not-ready answer, never traffic', async () => {
  const label = 'notes1234x3';
  const unassigned = slotOf(3, label, null);
  labels[label] = { status: 'active', record: record([unassigned]), slot: unassigned };
  const code = auth.issueCode({
    aud: `http://${label}--${BASE}`, label, installationId: INSTALL, appId: 'io.acme.notes', slot: 3,
    userId: 'default', sid: 'sess-1', returnPath: '/',
  }).code;
  const signed = await get(`${label}--${BASE}`, `/_aura/handoff?code=${code}`);
  const cookie = String(signed.headers['set-cookie']![0]).split(';')[0]!;
  const r = await get(`${label}--${BASE}`, '/', { cookie });
  assert.equal(r.status, 503);
  assert.match(r.body, /not ready/);
  assert.equal(r.headers['retry-after'], undefined);
  assert.match(await upgrade(`${label}--${BASE}`, '/ws', { Cookie: cookie, Origin: `http://${label}--${BASE}` }), /^HTTP\/1\.1 503/);
  assert.equal(seen.length, 0);
  assert.equal(startCalls, 0);
});

test('no start without a valid cookie', async () => {
  labels['notes1234'] = { status: 'active', record: record([slotOf(1, 'notes1234', null)]), slot: slotOf(1, 'notes1234', null) };
  apps[0].instances = [];
  assert.equal((await get(HOST)).status, 401);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(startCalls, 0);
});

test('a higher slot routes only when assigned and never starts', async () => {
  const label = 'notes1234x2';
  const signIn2 = async (slot: any) => {
    labels[label] = { status: 'active', record: record([slot]), slot };
    const code = auth.issueCode({
      aud: `http://${label}--${BASE}`, label, installationId: INSTALL, appId: 'io.acme.notes', slot: 2,
      userId: 'default', sid: 'sess-1', returnPath: '/',
    }).code;
    const r = await get(`${label}--${BASE}`, `/_aura/handoff?code=${code}`);
    return String(r.headers['set-cookie']![0]).split(';')[0]!;
  };
  const cookie = await signIn2(slotOf(2, label, null));
  assert.equal((await get(`${label}--${BASE}`, '/', { cookie })).status, 503);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(startCalls, 0);

  labels[label] = { status: 'active', record: record([slotOf(2, label, 'io.acme.notes-2')]), slot: slotOf(2, label, 'io.acme.notes-2') };
  apps[0].instances = [live('io.acme.notes-2')];
  assert.equal((await get(`${label}--${BASE}`, '/', { cookie })).status, 200);
});

test('the router dials the host the runtime names (upstreamHost, D58), and none means not routable', async () => {
  const good = await signIn();
  apps[0].instances = [live('io.acme.notes', { upstreamHost: null })];
  const before = seen.length;
  assert.equal((await get(HOST, '/', { cookie: good })).status, 503);
  assert.equal(seen.length, before, 'nothing reached the app');
  apps[0].instances = [live('io.acme.notes')];
  assert.equal((await get(HOST, '/', { cookie: good })).status, 200);
});

test('a service-only app gets no UI host', async () => {
  const good = await signIn();
  apps[0].manifest.componentType = 'service';
  assert.equal((await get(HOST, '/', { cookie: good })).status, 404);
  assert.equal(seen.length, 0);
});

// ── failure ─────────────────────────────────────────────────────────────────

test('a manifest host name is not served: only registry labels are', async () => {
  labels = {};
  apps = [{ manifest: { id: 'io.acme.notes', name: 'Notes', componentType: 'activity', hosts: [{ name: 'named' }] }, instances: [live('io.acme.notes')] }];
  assert.equal((await get(`named--${BASE}`)).status, 404);
  assert.match(await upgrade(`named--${BASE}`, '/ws', { Origin: `http://named--${BASE}` }), /^HTTP\/1\.1 404/);
  assert.equal(seen.length, 0);
});

test('a registry failure fails closed', async () => {
  const good = await signIn();
  registryDown = true;
  assert.equal((await get(HOST, '/', { cookie: good })).status, 503);
  assert.equal(seen.length, 0);
});

// ── POST /api/app-hosts/handoff ─────────────────────────────────────────────

/** The owner's login cookie on the desktop (a fake login session store below). */
const OWNER_COOKIE = 'aura_session=owner-token';
const callRoute = (headers: Record<string, string>, body: unknown) => handoffRoute({
  request: new Request(`http://${BASE}/api/app-hosts/handoff`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: BASE, cookie: OWNER_COOKIE, ...headers }, body: JSON.stringify(body),
  }),
  clientAddress: '127.0.0.1',
} as never) as Promise<Response>;

const SHELL = `http://${BASE}`;
const routeBody = (over: Record<string, unknown> = {}) => ({
  appId: 'io.acme.notes', instanceId: 'io.acme.notes', activityId: 'io.acme.notes#a1', returnPath: '/page?_aura_activity=x', ...over,
});
const G = globalThis as unknown as Record<string | symbol, unknown>;
const SERVICES = Symbol.for('aura.appHosts.services');
const AUTH = Symbol.for('aura.appHosts.auth');
const MANAGER = '__aura_app_manager__';
const AUTH_SERVICES = '__auraAuthServices';
/** core.getAuthServices(), faked: one owner with one live login session, `sess-route`. */
const fakeAuthServices = {
  version: Number.MAX_SAFE_INTEGER,
  users: {
    recoverOwnerPassword: async () => ({ ok: false }), credentialEpoch: () => 0,
    getOwner: async () => ({ id: 'default', username: 'owner', role: 'owner', disabled: false }),
  },
  loginSessions: {
    verify: async (token: string) => (token === 'owner-token'
      ? { sessionId: 'sess-route', method: 'password', userId: 'default', expiresAt: Date.now() + 3_600_000 } : null),
  },
  setupTickets: {},
};

async function withRouteWorld(run: () => Promise<void>) {
  const saved = [G[SERVICES], G[AUTH], G[MANAGER], G[AUTH_SERVICES]];
  G[AUTH_SERVICES] = fakeAuthServices;
  const instances: Record<string, unknown> = {
    'io.acme.notes': { instanceId: 'io.acme.notes', appId: 'io.acme.notes', inPool: false },
    'io.acme.notes-pool': { instanceId: 'io.acme.notes-pool', appId: 'io.acme.notes', inPool: true },
    'io.acme.notes-free': { instanceId: 'io.acme.notes-free', appId: 'io.acme.notes', inPool: false },
    'io.other.app': { instanceId: 'io.other.app', appId: 'io.other.app', inPool: false },
  };
  const activities: Record<string, unknown> = {
    'io.acme.notes#a1': { activityId: 'io.acme.notes#a1', parentInstanceId: 'io.acme.notes', appId: 'io.acme.notes' },
    'io.other.app#a1': { activityId: 'io.other.app#a1', parentInstanceId: 'io.other.app', appId: 'io.other.app' },
  };
  G[MANAGER] = {
    getManifest: (id: string) => (id === 'io.acme.notes' || id === 'io.other.app' ? { id, componentType: 'activity' } : undefined),
    getInstance: (id: string) => instances[id],
    getActivity: (id: string) => activities[id],
    claimHostSlot: async () => {},
  };
  G[AUTH] = auth;
  G[SERVICES] = {
    ...svc,
    registry: {
      ...registry,
      listForApp: async (appId: string) => (appId === 'io.acme.notes' ? [labels['notes1234'].record] : []),
    },
  };
  try { await run(); } finally {
    [G[SERVICES], G[AUTH], G[MANAGER], G[AUTH_SERVICES]] = saved;
    if (saved[0] === undefined) delete G[SERVICES];
    if (saved[1] === undefined) delete G[AUTH];
    if (saved[2] === undefined) delete G[MANAGER];
    if (saved[3] === undefined) delete G[AUTH_SERVICES];
  }
}

test('the handoff route refuses a sibling origin', async () => {
  for (const headers of [
    { origin: ORIGIN }, { origin: SHELL, 'sec-fetch-site': 'same-site' }, {},
  ] as Array<Record<string, string>>) {
    assert.equal((await callRoute(headers, routeBody())).status, 403);
  }
});

test('the handoff route refuses an open redirect and malformed ids before any lookup', async () => {
  for (const over of [{ returnPath: '//evil.example' }, { appId: 7 }, { instanceId: '../x' }, { activityId: 'a b' }]) {
    assert.equal((await callRoute({ origin: SHELL }, routeBody(over))).status, 400);
  }
});

test('the handoff route needs the owner\'s login session', async () => {
  await withRouteWorld(async () => {
    for (const cookie of ['', 'aura_session=forged', `${OWNER_COOKIE}; ${OWNER_COOKIE}`]) {
      const r = await callRoute({ origin: SHELL, cookie }, routeBody());
      assert.equal(r.status, 401, cookie);
      assert.deepEqual(await r.json(), { error: 'login-required' });
    }
  });
});

test('the handoff route answers {code, origin, slot}, and the code signs in', async () => {
  await withRouteWorld(async () => {
    const r = await callRoute({ origin: SHELL }, routeBody());
    assert.equal(r.status, 200);
    const out = await r.json() as { code: string; origin: string; slot: number; system: boolean };
    assert.deepEqual(Object.keys(out).sort(), ['code', 'origin', 'slot', 'system']);
    assert.equal(out.origin, ORIGIN);
    assert.equal(out.slot, 1);
    assert.equal(out.system, false, 'a user-scope installation');
    liveSessions.add('sess-route');
    const signed = await get(HOST, `/_aura/handoff?code=${out.code}`);
    assert.equal(signed.status, 303);
    assert.equal(signed.headers.location, '/page?_aura_activity=x');
  });
});

test('the handoff route marks only the app\'s active system installation', async () => {
  await withRouteWorld(async () => {
    const world = G[SERVICES] as { registry: Record<string, unknown> };
    for (const [installation, system] of [
      [{ appId: 'io.acme.notes', scope: 'system', state: 'active' }, true],
      [{ appId: 'io.acme.notes', scope: 'global', state: 'active' }, false],
      [{ appId: 'io.acme.notes', scope: 'system', state: 'reserved' }, false],
      [{ appId: 'io.other.app', scope: 'system', state: 'active' }, false],
      [null, false],
    ] as const) {
      world.registry['getInstallation'] = async (id: string) => (id === INSTALL ? installation : null);
      const out = await (await callRoute({ origin: SHELL }, routeBody())).json() as { system: boolean };
      assert.equal(out.system, system, JSON.stringify(installation));
    }
  });
});

test('the handoff route takes a new code on every call', async () => {
  await withRouteWorld(async () => {
    const a = await (await callRoute({ origin: SHELL }, routeBody())).json() as { code: string };
    const b = await (await callRoute({ origin: SHELL }, routeBody())).json() as { code: string };
    assert.notEqual(a.code, b.code);
  });
});

test('the handoff route checks every id in the body', async () => {
  await withRouteWorld(async () => {
    const status = async (over: Record<string, unknown>) => (await callRoute({ origin: SHELL }, routeBody(over))).status;
    assert.equal(await status({ appId: 'io.missing.app' }), 404);
    assert.equal(await status({ instanceId: 'io.missing' }), 404);
    assert.equal(await status({ instanceId: 'io.other.app', activityId: null }), 404);   // another app's instance
    assert.equal(await status({ instanceId: 'io.acme.notes-pool', activityId: null }), 404);   // warm pool
    assert.equal(await status({ activityId: 'io.other.app#a1' }), 404);   // another app's window
    assert.equal(await status({ activityId: 'io.acme.notes#a9' }), 404);
    assert.equal(await status({ instanceId: 'io.acme.notes-free', activityId: null }), 409);   // running, no slot
    assert.equal(await status({ appId: 'io.other.app', instanceId: 'io.other.app', activityId: null }), 409);   // proxy route
  });
});

test('the handoff route refuses a slot whose label was retired', async () => {
  await withRouteWorld(async () => {
    const held = labels['notes1234'];
    const world = G[SERVICES] as { registry: Record<string, unknown> };
    world.registry['listForApp'] = async () => [held.record];
    world.registry['resolveLabel'] = async () => ({ status: 'retired', tombstone: {} });
    assert.equal((await callRoute({ origin: SHELL }, routeBody())).status, 410);
  });
});

test('an App Host forwards only an Activity of the routed instance', () => {
  const own = encodeURIComponent('io.acme.notes-2#a1');
  assert.deepEqual(activityHeaders(`/?_aura_activity=${own}`, 'io.acme.notes-2'), { 'x-aura-activity-id': 'io.acme.notes-2#a1' });
  assert.deepEqual(activityHeaders(`/?_aura_activity=${own}`, 'io.acme.notes'), {});
  assert.deepEqual(activityHeaders('/?_aura_activity=other%23a1', 'io.acme.notes-2'), {});
  assert.deepEqual(activityHeaders('/page', 'io.acme.notes-2'), {});
});

test('a spent code continues only for a browser that holds the cookie', async () => {
  const code = issue();
  const next = encodeURIComponent('/page?_aura_activity=x');
  const signed = await get(HOST, `/_aura/handoff?code=${code}&next=${next}`);
  assert.equal(signed.status, 303);
  const cookie = String(signed.headers['set-cookie']![0]).split(';')[0]!;
  const again = await get(HOST, `/_aura/handoff?code=${code}&next=${next}`, { cookie });
  assert.equal(again.status, 303);
  assert.equal(again.headers.location, '/page?_aura_activity=x');
  assert.equal(again.headers['set-cookie'], undefined);
  assert.equal((await get(HOST, `/_aura/handoff?code=${code}&next=${next}`)).status, 403);
  const evil = encodeURIComponent('//evil.example');
  assert.equal((await get(HOST, `/_aura/handoff?code=${code}&next=${evil}`, { cookie })).status, 403);
});

// ── a Terminal embed handoff (5.16): restricted to one session ──────────────

const TERM = 'term1234';
const TERM_HOST = `${TERM}--${BASE}`;
const TERM_ORIGIN = `http://${TERM_HOST}`;
const EMBED_SESSION = 'com.aura.terminal-1#a3';
const EMBED_DOC = `/?embed=1&session=${encodeURIComponent(EMBED_SESSION)}&_aura_embedder=terminalx1`;
const EMBED_WS = `/ws?_aura_session=${encodeURIComponent(EMBED_SESSION)}&embed=1&session=${encodeURIComponent(EMBED_SESSION)}&_aura_embedder=terminalx1`;

function terminalWorld() {
  const termRecord = { ...record([slotOf(1, TERM, 'com.aura.terminal-1')]), appId: 'com.aura.terminal', baseName: TERM };
  labels[TERM] = { status: 'active', record: termRecord, slot: slotOf(1, TERM, 'com.aura.terminal-1') };
  apps.push({ manifest: { id: 'com.aura.terminal', name: 'Terminal', componentType: 'activity', hosts: [] }, instances: [live('com.aura.terminal-1')] });
  embedOrigins = ['http://terminalx1--desk.example'];
}
async function terminalSignIn(embed: { sessionId: string; embedder: string } | null): Promise<{ name: string; cookie: string }> {
  const code = auth.issueCode({
    aud: TERM_ORIGIN, label: TERM, installationId: INSTALL, appId: 'com.aura.terminal', slot: 1,
    userId: 'default', sid: 'sess-1', returnPath: embed ? EMBED_DOC : '/', ...(embed ? { embed } : {}),
  } as never).code;
  const r = await get(TERM_HOST, `/_aura/handoff?code=${code}`);
  assert.equal(r.status, 303);
  const cookie = String(r.headers['set-cookie']![0]).split(';')[0]!;
  return { name: cookie.split('=')[0]!, cookie };
}

test('an embed handoff signs in for its one session only, never as the Terminal', async () => {
  terminalWorld();
  const { name, cookie } = await terminalSignIn({ sessionId: EMBED_SESSION, embedder: 'terminalx1' });
  assert.equal(name, 'aura_app_embed', 'its own cookie, which never replaces a window\'s full one');
  // The embed document, for exactly this session and embedder, and its assets.
  const doc = await get(TERM_HOST, EMBED_DOC, { cookie });
  assert.equal(doc.status, 200);
  assert.equal(doc.headers['content-security-policy'], `frame-ancestors 'self' http://${BASE} http://terminalx1--desk.example`);
  assert.equal((await get(TERM_HOST, '/_astro/index.abc.js', { cookie })).status, 200);
  assert.equal((await get(TERM_HOST, '/api/os/theme.css', { cookie })).status, 200);
  // Nothing else on the Terminal's host: other pages, its API, MCP, the gateway.
  seen.length = 0;
  for (const path of [
    '/', '/?embed=1', `/?embed=1&session=${encodeURIComponent('com.aura.terminal-1#a9')}&_aura_embedder=terminalx1`,
    `/?embed=1&session=${encodeURIComponent(EMBED_SESSION)}&_aura_embedder=other1`, '/index.html',
    '/api/sessions', '/api/sessions/screen?id=x', '/mcp/terminal', '/_aura/os/api/apps', '/_aura/os/api/os/context',
  ]) {
    assert.equal((await get(TERM_HOST, path, { cookie, 'x-aura-same-origin': '1' })).status, 403, path);
  }
  assert.equal((await get(TERM_HOST, EMBED_DOC, { cookie, origin: TERM_ORIGIN }, 'POST')).status, 403);
  assert.equal(seen.length, 0);
  // The socket: only this session, as an embed.
  const ws = (path: string) => upgrade(TERM_HOST, path, { Cookie: cookie, Origin: TERM_ORIGIN });
  assert.match(await ws(EMBED_WS), /^HTTP\/1\.1 101/);
  for (const path of [
    `/ws?_aura_session=${encodeURIComponent(EMBED_SESSION)}`,
    `/ws?_aura_session=${encodeURIComponent('com.aura.terminal-1#a1')}`,
    EMBED_WS.replace('_aura_session=com.aura.terminal-1%23a3', '_aura_session=com.aura.terminal-1%23a1'),
    '/_aura/os/sse-mux', '/?token=hmr',
  ]) assert.match(await ws(path), /^HTTP\/1\.1 403/, path);
  // Copied under the full cookie's name it is nothing.
  const value = cookie.slice(cookie.indexOf('=') + 1);
  assert.equal((await get(TERM_HOST, '/', { cookie: `aura_app=${value}` })).status, 401);
  // Revoking the grant ends the document too.
  embedOrigins = [];
  assert.equal((await get(TERM_HOST, EMBED_DOC, { cookie })).status, 403);
});

test('a full Terminal cookie keeps working beside an embed cookie, and an embed socket names one session', async () => {
  terminalWorld();
  const full = await terminalSignIn(null);
  const embed = await terminalSignIn({ sessionId: EMBED_SESSION, embedder: 'terminalx1' });
  assert.equal(full.name, 'aura_app');
  const both = `${embed.cookie}; ${full.cookie}`;
  assert.equal((await get(TERM_HOST, '/api/sessions', { cookie: both, 'x-aura-same-origin': '1' })).status, 200);
  // Even the full cookie may not attach an embed socket to a different session.
  const mismatched = EMBED_WS.replace('_aura_session=com.aura.terminal-1%23a3', '_aura_session=com.aura.terminal-1%23a1');
  assert.match(await upgrade(TERM_HOST, mismatched, { Cookie: full.cookie, Origin: TERM_ORIGIN }), /^HTTP\/1\.1 403/);
  assert.match(await upgrade(TERM_HOST, EMBED_WS, { Cookie: full.cookie, Origin: TERM_ORIGIN }), /^HTTP\/1\.1 101/);
});

test('an embed claim must be well formed', () => {
  for (const embed of [{ sessionId: 'x', embedder: 'tx' }, { sessionId: EMBED_SESSION, embedder: 'Bad-Label' }, { sessionId: EMBED_SESSION }]) {
    assert.throws(() => auth.issueCode({
      aud: TERM_ORIGIN, label: TERM, installationId: INSTALL, appId: 'com.aura.terminal', slot: 1,
      userId: 'default', sid: 'sess-1', returnPath: '/', embed,
    } as never), /embed/);
  }
});

// ── the shell's own listener: no other site may write or open a socket (D40) ─

test('a write or socket to the shell from another site is refused before the shell sees it', async () => {
  const intent = JSON.stringify({ action: 'aura.intent.action.OPEN_TERMINAL', extras: { command: 'id' } });
  const post = (headers: Record<string, string>, host = BASE) => new Promise<Reply>((resolve, reject) => {
    const req = http.request({ port, path: '/api/intents/start', method: 'POST', agent: false, headers: { host, 'content-type': 'text/plain', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(intent);
  });
  // Any web page's no-cors text/plain POST, an App Host sibling, a sandboxed frame.
  for (const origin of ['http://evil.example', ORIGIN, 'null', `http://${BASE}.evil.example`, 'http://desk.example:3001']) {
    const r = await post({ origin });
    assert.equal(r.status, 403, origin);
    assert.notEqual(r.body, 'desktop', origin);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal((await get(BASE, '/api/x', { origin: 'http://evil.example' }, method)).status, 403, method);
  }
  assert.match(await upgrade(BASE, '/os-events/?EIO=4&transport=websocket', { Origin: 'http://evil.example' }), /^HTTP\/1\.1 403/);
  assert.match(await upgrade(BASE, '/api/proxy/com.aura.terminal/ws', { Origin: ORIGIN }), /^HTTP\/1\.1 403/);
  // The desktop's own page, on either scheme an edge may terminate.
  assert.equal((await post({ origin: `http://${BASE}` })).body, 'desktop');
  assert.equal((await post({ origin: `https://${BASE}` })).body, 'desktop');
  assert.equal((await post({ origin: 'http://10.0.0.2:3000' }, '10.0.0.2:3000')).body, 'desktop');
  // Behind an edge that sets X-Forwarded-Host.
  assert.equal((await post({ origin: 'https://box.example.com', 'x-forwarded-host': 'box.example.com' }, '10.0.0.2:3000')).body, 'desktop');
  assert.match(await upgrade(BASE, '/os-events/?EIO=4&transport=websocket', { Origin: `http://${BASE}` }), /^HTTP\/1\.1 418/);
  // Reads are untouched: a cross-site <img>, a script tag, the setup probe.
  assert.equal((await get(BASE, '/api/os/theme.css', { origin: 'http://evil.example' })).body, 'desktop');
});

test('machine callers send no Origin and keep working: the CLI, an app server\'s SDK, the Terminal backend', async () => {
  // Each of them calls the shell with Node's fetch (CLI api.ts, app-sdk OsClient
  // and osAuthHeaders, the Terminal's session-grants.ts), which sends no Origin.
  const seenOrigins: Array<string | undefined> = [];
  const probe = http.createServer((req, res) => { seenOrigins.push(req.headers.origin); res.end('ok'); });
  const probePort = await listen(probe);
  try {
    await (await fetch(`http://127.0.0.1:${probePort}/api/intents/start`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).text();
  } finally { probe.close(); }
  assert.deepEqual(seenOrigins, [undefined], 'Node fetch sends no Origin');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await fetch(`http://127.0.0.1:${port}/api/intents/start`, {
      method, body: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer aura1.token' },
    });
    assert.equal(await r.text(), 'desktop', method);
  }
  for (const method of ['POST', 'DELETE']) assert.equal((await get('aura-shell:3000', '/api/x', {}, method)).body, 'desktop', method);
  assert.match(await upgrade('aura-shell:3000', '/os-events/?EIO=4&transport=websocket', {}), /^HTTP\/1\.1 418/);
});

test('the host probe answers alike for every App Host name and never asks the registry', async () => {
  labels['gone1234'] = { status: 'retired' };
  labels['held1234'] = { status: 'reserved' };
  const asked: string[] = [];
  const original = registry.resolveLabel;
  registry.resolveLabel = async (label: string) => { asked.push(label); return original(label); };
  try {
    const answers = [];
    for (const label of ['notes1234', 'gone1234', 'held1234', 'nosuchapp1', 'zzzzzzzz']) {
      const r = await get(`${label}--${BASE}`, '/_aura/host-probe');
      answers.push([r.status, r.headers['access-control-allow-origin'], r.body]);
    }
    assert.deepEqual(new Set(answers.map((a) => JSON.stringify(a))).size, 1, JSON.stringify(answers));
    assert.deepEqual(answers[0], [204, '*', '']);
    assert.deepEqual(asked, []);
  } finally { registry.resolveLabel = original; }
});

// ── the cookie probe (D44) ──────────────────────────────────────────────────

test('the cookie probe sets a cookie like the handoff and reports it to this desktop only, for every label', async () => {
  const asked: string[] = [];
  const original = registry.resolveLabel;
  registry.resolveLabel = async (label: string) => { asked.push(label); return original(label); };
  try {
    for (const label of ['hostprobe', 'notes1234', 'nosuchapp1']) {
      const set = await get(`${label}--${BASE}:3000`, '/_aura/host-probe?cookie=set');
      assert.equal(set.status, 303, label);
      assert.equal(set.headers.location, '/_aura/host-probe?cookie=check');
      assert.match(String(set.headers['set-cookie']![0]), /^aura_host_probe=1; Path=\/; Max-Age=60; HttpOnly; SameSite=Lax$/);

      const kept = await get(`${label}--${BASE}:3000`, '/_aura/host-probe?cookie=check', { cookie: 'aura_host_probe=1' });
      assert.equal(kept.status, 200);
      assert.match(String(kept.headers['content-security-policy']), /frame-ancestors http:\/\/desk\.example:3000$/);
      assert.match(kept.body, /parent\.postMessage\(\{"type":"aura\.hostprobe\.cookie","cookie":true\}, "http:\/\/desk\.example:3000"\)/);
      assert.match(String(kept.headers['set-cookie']![0]), /^aura_host_probe=; Path=\/; Max-Age=0;/);

      const dropped = await get(`${label}--${BASE}:3000`, '/_aura/host-probe?cookie=check', { cookie: 'aura_host_probe_x=1; other=2' });
      assert.match(dropped.body, /"cookie":false/);
      assert.equal(dropped.headers['set-cookie'], undefined);
    }
    assert.deepEqual(asked, []);
    assert.equal(seen.length, 0);
  } finally { registry.resolveLabel = original; }
});

test('the cookie probe behind a trusted HTTPS edge uses a __Host- Secure cookie and the https desktop', async () => {
  const edge = http.createServer((_q, s) => s.end('desktop'));
  createAppHostRouter({ appsList: async () => apps, services: async () => svc, auth, env: { AURA_TRUSTED_PROXIES: '127.0.0.1', AURA_DESKTOP_HOSTS: BASE } }).attach(edge);
  const edgePort = await listen(edge);
  const at = (path: string, headers: Record<string, string>) => new Promise<Reply>((resolve, reject) => {
    http.get({ port: edgePort, path, agent: false, headers: { host: `hostprobe--${BASE}`, 'x-forwarded-proto': 'https', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject);
  });
  try {
    const set = await at('/_aura/host-probe?cookie=set', {});
    assert.match(String(set.headers['set-cookie']![0]), /^__Host-aura_host_probe=1; Path=\/; Max-Age=60; HttpOnly; Secure; SameSite=Lax$/);
    const check = await at('/_aura/host-probe?cookie=check', { cookie: '__Host-aura_host_probe=1' });
    assert.match(check.body, /"cookie":true\}, "https:\/\/desk\.example"/);
  } finally { edge.closeAllConnections?.(); edge.close(); }
});

test('an app never receives the probe cookie', async () => {
  const good = await signIn();
  await get(HOST, '/', { cookie: `${good}; aura_host_probe=1; own=1` });
  assert.equal(seen.at(-1)!.headers.cookie, 'own=1');
});

// ── Host values the URL parser rejects ──────────────────────────────────────

/** A raw request, so no client refuses the Host first. The status line, or 'no answer'. */
function rawStatus(p: number, host: string, extra = '') {
  return new Promise<string>((resolve, reject) => {
    const sock = net.connect(p, '127.0.0.1');
    let buf = '';
    const done = (line: string) => { clearTimeout(timer); sock.destroy(); resolve(line); };
    const timer = setTimeout(() => done(buf.split('\r\n', 1)[0] || 'no answer'), 1500);
    sock.on('data', (d) => { buf += d; if (buf.includes('\r\n')) done(buf.split('\r\n', 1)[0]!); });
    sock.on('error', reject);
    const connection = /^connection:/im.test(extra) ? '' : 'Connection: close\r\n';
    sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\n${extra}${connection}\r\n`);
  });
}
const UPGRADE = 'Upgrade: websocket\r\nConnection: Upgrade\r\n';
const URL_REJECTS = ['foo.123', '1.2.3.999', 'x--1.2.3.4', 'label--10.100.0.2:3000', 'notes1234--1.2.3.999:3000'];

test('a Host the URL parser rejects is answered 400 under every policy, never passed on', async () => {
  for (const host of URL_REJECTS) assert.throws(() => new URL(`http://${host}/`), host);
  // Stands in for code that builds a URL from Host (the Vite dev server): it throws and never answers.
  const hanging = () => {
    const s = http.createServer((req) => { try { new URL(`http://${req.headers.host}/`); } catch { /* never answered */ } });
    s.on('upgrade', () => {});
    return s;
  };
  const strict = hanging();
  createAppHostRouter({
    appsList: async () => apps, services: async () => svc, auth,
    env: { AURA_HOST_POLICY: 'enforce', AURA_DESKTOP_HOSTS: 'desk.example', AURA_TRUSTED_PROXIES: '127.0.0.1' },
  }).attach(strict);
  const lax = hanging();
  createAppHostRouter({ appsList: async () => apps, services: async () => svc, auth, env: {} }).attach(lax);
  const [strictPort, laxPort] = await Promise.all([listen(strict), listen(lax)]);
  try {
    for (const host of [...URL_REJECTS, 'a@desk.example']) {
      for (const p of [port, strictPort, laxPort]) {
        assert.match(await rawStatus(p, host), /^HTTP\/1\.1 400/, `${p} ${host}`);
        assert.match(await rawStatus(p, host, UPGRADE), /^HTTP\/1\.1 400/, `upgrade ${p} ${host}`);
      }
    }
    // A trusted edge's X-Forwarded-Host is checked the same way.
    assert.match(await rawStatus(strictPort, BASE, 'X-Forwarded-Host: foo.123\r\n'), /^HTTP\/1\.1 400/);
    assert.equal(seen.length, 0);
  } finally { for (const s of [strict, lax]) { s.closeAllConnections?.(); s.close(); } }
  // Every address that works today still passes.
  for (const host of ['127.0.0.1:3000', '[::1]:3000', '10.0.0.2:3000', 'localhost:3000', 'os.aura.localhost:3000', '10-0-0-2.nip.io:3000',
    'notes1234--10-0-0-2.nip.io:3000', 'box.example.com', 'aura-shell:3000', 'bad_host', 'xn--bcher-kva.example']) {
    assert.equal(hostParses(host), true, host);
  }
  for (const host of [...URL_REJECTS, 'a@b', 'a/b', 'a\\b', 'a?b', 'a#b', 'a b']) assert.equal(hostParses(host), false, host);
  assert.equal(hostParses(undefined), true, 'no Host is left to the server');
});

// ── App Host names no app uses ──────────────────────────────────────────────

test('an App Host name no app uses is 404 under every policy, never the desktop or its API', async () => {
  const hosts = [
    `nosuchlabel1--${BASE}`, 'nosuchlabel1--10-100-0-2.nip.io:3000', 'nosuchlabel1--os.aura.localhost:3000',
    'label--localhost:3000', 'label--aura.localhost:3000',
  ];
  const desktop = () => {
    const s = http.createServer((_q, res) => res.end('desktop'));
    s.on('upgrade', (_q, socket) => socket.end('HTTP/1.1 418 Desktop\r\n\r\n'));
    return s;
  };
  const strict = desktop();
  createAppHostRouter({ appsList: async () => apps, services: async () => svc, auth, env: { AURA_HOST_POLICY: 'enforce', AURA_DESKTOP_HOSTS: BASE } }).attach(strict);
  const noRegistry = desktop();
  createAppHostRouter({ appsList: async () => apps, auth, env: { AURA_DESKTOP_HOSTS: BASE } }).attach(noRegistry);
  const [strictPort, noRegistryPort] = await Promise.all([strict, noRegistry].map(listen)) as [number, number];
  const ports = [port, strictPort];
  const answer = (p: number, host: string, path: string, method: string) => new Promise<string>((resolve, reject) => {
    const req = http.request({ port: p, path, method, agent: false, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(`${res.statusCode} ${body}`));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    for (const p of ports) {
      for (const host of hosts) {
        for (const [path, method] of [['/', 'GET'], ['/api/apps', 'GET'], ['/api/intents/start', 'POST']] as const) {
          const r = await answer(p, host, path, method);
          assert.match(r, /^404 /, `${p} ${host} ${method} ${path}`);
          assert.doesNotMatch(r, /desktop/);
        }
        assert.match(await rawStatus(p, host, UPGRADE), /^HTTP\/1\.1 404/, `upgrade ${p} ${host}`);
      }
    }
    // A retired label stays 410; the desktop and an active label are untouched.
    labels['gone1234'] = { status: 'retired' };
    assert.equal((await get(`gone1234--${BASE}`)).status, 410);
    assert.equal((await get(BASE)).body, 'desktop');
    assert.equal((await get(HOST)).status, 401);
    // Without a registry every App Host fails closed, never the desktop.
    for (const host of [...hosts, HOST]) {
      const r = await answer(noRegistryPort, host, '/', 'GET');
      assert.match(r, /^(503|404) /, host);
      assert.doesNotMatch(r, /desktop/);
    }
    assert.match(await answer(noRegistryPort, HOST, '/', 'GET'), /^503 /, 'a valid label fails closed');
  } finally { for (const s of [strict, noRegistry]) { s.closeAllConnections?.(); s.close(); } }
});

// ── the machine proxy (/api/proxy/*) ────────────────────────────────────────

test('a browser page, frame or worker load is a document request; a fetch, curl or MCP call is not', () => {
  const ask = (h: Record<string, string>, method = 'GET') => browserDocumentRequest(method, (n: string) => h[n]);
  for (const dest of ['document', 'iframe', 'frame', 'embed', 'object', 'worker', 'sharedworker', 'serviceworker']) {
    assert.equal(ask({ 'sec-fetch-dest': dest }), true, dest);
  }
  assert.equal(ask({ 'sec-fetch-mode': 'navigate' }), true);
  // Plain HTTP: no Sec-Fetch-*, but every navigation sends Upgrade-Insecure-Requests.
  assert.equal(ask({ 'upgrade-insecure-requests': '1', accept: 'text/html' }), true);
  for (const h of [
    {}, { accept: 'application/json, text/event-stream' }, { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' },
    { 'sec-fetch-dest': 'empty', 'upgrade-insecure-requests': '1' }, { 'user-agent': 'curl/8' },
  ] as Array<Record<string, string>>) assert.equal(ask(h), false, JSON.stringify(h));
  assert.equal(ask({ 'upgrade-insecure-requests': '1' }, 'POST'), false, 'a form post is not a load the proxy could render');
});

test('the machine proxy refuses a browser document and serves a machine call, stripped of the prefix and of cookies', async () => {
  const saved = G[MANAGER];
  G[MANAGER] = {
    getInstance: (id: string) => (id === 'io.acme.notes' ? { instanceId: 'io.acme.notes', appId: 'io.acme.notes', state: 'resumed', port: appPort, inPool: false } : undefined),
    getInstancesByApp: () => [],
    getManifest: (id: string) => ({ id, componentType: 'activity', provides: [] }),
    getUpstreamUrl: () => ({ host: '127.0.0.1', port: appPort }),
  };
  const call = (path: string, headers: Record<string, string> = {}, method = 'GET') => machineProxyRoute({
    params: { id: 'io.acme.notes', path: path.slice(1) },
    request: new Request(`http://${BASE}/api/proxy/io.acme.notes${path}`, { method, headers: { host: BASE, ...headers } }),
  } as never) as Promise<Response>;
  try {
    for (const headers of [
      { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
      { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' },
      { 'upgrade-insecure-requests': '1', accept: 'text/html' },
    ] as Array<Record<string, string>>) {
      const r = await call('/', headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.equal((await r.json() as { error: string }).error, 'browser-document-refused');
      assert.equal(r.headers.get('content-security-policy'), 'sandbox');
    }
    assert.equal(seen.length, 0, 'a refused document never reaches the app');

    // An agent's MCP call: no login, no Sec-Fetch-*, JSON.
    const r = await call('/mcp', { accept: 'application/json, text/event-stream', 'content-type': 'application/json', cookie: 'aura_session=S; app=1' });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'app');
    assert.equal(seen.at(-1)!.url, '/mcp', 'the prefix is stripped');
    assert.equal(seen.at(-1)!.headers.cookie, 'app=1', 'shell credentials never reach the app');
    assert.equal(r.headers.get('set-cookie'), null, 'an app cannot set cookies on the shell origin');
    assert.equal(r.headers.get('content-security-policy'), 'sandbox');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

    // Lifecycle routes are the kernel's: refused before any lookup, in any
    // spelling, and a caller's lifecycle header never reaches the app.
    const before = seen.length;
    for (const path of ['/api/lifecycle/onDestroy', '/api/lifecycle/health', '/API/lifecycle/onStop', '/api/%6cifecycle/onStop', '/x/../api/lifecycle/onStop']) {
      const refused = await call(path, { 'x-aura-lifecycle': 'guess' }, 'POST');
      assert.equal(refused.status, 403, path);
      assert.equal((await refused.json() as { error: string }).error, 'lifecycle-path-refused');
    }
    assert.equal(seen.length, before, 'a refused lifecycle call never reaches the app');
    const other = await call('/mcp', { 'x-aura-lifecycle': 'guess', accept: 'application/json' });
    assert.equal(other.status, 200);
    assert.equal(seen.at(-1)!.headers['x-aura-lifecycle'], undefined, 'the shell never forwards a lifecycle header');
  } finally { G[MANAGER] = saved; if (saved === undefined) delete G[MANAGER]; }
});
