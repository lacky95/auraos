// `frameRoute: host` on the App Host router, against real sockets: a fake app,
// a fake shell API, and a fake registry. Covers the handoff, the app cookie,
// the Host and Origin checks, and slot routing.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { activityHeaders, classifyHost, createAppHostRouter } from '../server/app-hosts.mjs';
import { createAppHostAuth, safeReturnPath } from '../server/app-host-auth.mjs';
import { POST as handoffRoute } from '../src/pages/api/app-hosts/handoff.ts';

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
const live = (instanceId: string, extra = {}) => ({ instanceId, port: appPort, state: 'resumed', inPool: false, sandbox: 'proot', ...extra });

let labels: Record<string, any>;
let frameRoutes: Record<string, string>;
let apps: any[];
let liveSessions: Set<string>;
let registryDown = false;

const registry = {
  resolveLabel: async (label: string) => {
    if (registryDown) throw new Error('kv down');
    return labels[label] ?? { status: 'unknown' };
  },
};
const svc = { registry, frameRoute: async (appId: string) => frameRoutes[appId] ?? 'proxy', sessionLive: async (sid: string) => liveSessions.has(sid) };

let nowMs = 1_000_000;
const auth = createAppHostAuth({ secret: Buffer.alloc(32, 7), now: () => nowMs });
const embedCalls: unknown[] = [];
let embedOrigins: string[] = [];
const env = { AURA_TRUSTED_PROXIES: '10.9.9.9' };
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
  frameRoutes = { 'io.acme.notes': 'host' };
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
    appsList: async () => apps, services: async () => svc, auth, env: { AURA_TRUSTED_PROXIES: '127.0.0.1' },
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

test('embedding adds granted origins only on an embed document', async () => {
  const good = await signIn();
  embedOrigins = ['http://terminalx1--desk.example', 'javascript:alert(1)'];
  assert.equal((await get(HOST, '/', { cookie: good })).headers['content-security-policy'], `frame-ancestors 'self' http://${BASE}`);
  assert.equal(embedCalls.length, 0);
  const r = await get(HOST, '/?embed=1', { cookie: good });
  assert.equal(r.headers['content-security-policy'], `frame-ancestors 'self' http://${BASE} http://terminalx1--desk.example`);
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
  assert.equal((await get(`notes1234--evil.example`, '/', { cookie: good })).status, 401);
});

test('an unknown Host keeps working in report mode and is refused in enforce mode', async () => {
  assert.equal((await get('zzz--desk.example')).body, 'desktop');
  assert.equal((await get('bad_host')).body, 'desktop');
  const strict = createAppHostRouter({
    appsList: async () => apps, services: async () => svc, auth, env: { AURA_HOST_POLICY: 'enforce' },
  });
  const server = http.createServer((_q, s) => s.end('desktop'));
  strict.attach(server);
  const strictPort = await listen(server);
  const at = (host: string) => new Promise<number>((resolve, reject) => {
    http.get({ port: strictPort, agent: false, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
  try {
    assert.equal(await at('zzz--desk.example'), 404);
    assert.equal(await at('bad_host'), 400);
    assert.equal(await at('10.0.0.2:3000'), 200);
    assert.equal(await at('aura-shell:3000'), 200);
  } finally { server.closeAllConnections?.(); server.close(); }
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

test('a service-only app gets no UI host', async () => {
  const good = await signIn();
  apps[0].manifest.componentType = 'service';
  assert.equal((await get(HOST, '/', { cookie: good })).status, 404);
  assert.equal(seen.length, 0);
});

// ── the proxy path and failure ──────────────────────────────────────────────

test('a proxy-route app keeps the open manifest-host path', async () => {
  frameRoutes = {};
  labels = {};
  apps = [{ manifest: { id: 'io.acme.legacy', name: 'Legacy', hosts: [{ name: 'legacy' }] }, instances: [live('io.acme.legacy')] }];
  await router.resolve('legacy');
  const r = await get(`legacy--${BASE}`, '/x', { cookie: 'aura_app=stays; aura_session=S' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(seen.at(-1)!.headers.cookie, 'aura_app=stays');
});

test('a host-route app cannot be reached through a manifest host', async () => {
  labels = {};
  apps = [{ manifest: { id: 'io.acme.notes', name: 'Notes', componentType: 'activity', hosts: [{ name: 'named' }] }, instances: [live('io.acme.notes')] }];
  await router.resolve('named');
  assert.equal((await get(`named--${BASE}`)).status, 403);
  assert.match(await upgrade(`named--${BASE}`, '/ws', { Origin: `http://named--${BASE}` }), /^HTTP\/1\.1 403/);
  assert.equal(seen.length, 0);
});

test('a registry failure fails closed', async () => {
  const good = await signIn();
  registryDown = true;
  assert.equal((await get(HOST, '/', { cookie: good })).status, 503);
  assert.equal(seen.length, 0);
});

// ── POST /api/app-hosts/handoff ─────────────────────────────────────────────

const callRoute = (headers: Record<string, string>, body: unknown) => handoffRoute({
  request: new Request(`http://${BASE}/api/app-hosts/handoff`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: BASE, ...headers }, body: JSON.stringify(body),
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

async function withRouteWorld(run: () => Promise<void>) {
  const saved = [G[SERVICES], G[AUTH], G[MANAGER]];
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
    [G[SERVICES], G[AUTH], G[MANAGER]] = saved;
    if (saved[0] === undefined) delete G[SERVICES];
    if (saved[1] === undefined) delete G[AUTH];
    if (saved[2] === undefined) delete G[MANAGER];
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

test('the handoff route answers {code, origin, slot}, and the code signs in', async () => {
  await withRouteWorld(async () => {
    const r = await callRoute({ origin: SHELL }, routeBody());
    assert.equal(r.status, 200);
    const out = await r.json() as { code: string; origin: string; slot: number };
    assert.deepEqual(Object.keys(out).sort(), ['code', 'origin', 'slot']);
    assert.equal(out.origin, ORIGIN);
    assert.equal(out.slot, 1);
    liveSessions.add('login-dark');
    const signed = await get(HOST, `/_aura/handoff?code=${out.code}`);
    assert.equal(signed.status, 303);
    assert.equal(signed.headers.location, '/page?_aura_activity=x');
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
