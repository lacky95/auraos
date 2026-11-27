// D104 `apps.view`: the restricted view cookie on the App Host router (real
// sockets, a fake target app and registry, the view decisions injected) and
// the view handoff route (lib/appView.ts) with fakes.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as core from '@aura/core';
import { createAppHostRouter, viewRequestRefusal } from '../server/app-hosts.mjs';
import { createAppHostAuth } from '../server/app-host-auth.mjs';
import { appProtection, createAppView } from '../server/app-view.mjs';
import { requestAppView, type AppViewRouteDeps } from '../src/lib/appView.ts';

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

const BASE = 'desk.example';
// The route checks the desktop host against the listed custom domains.
process.env.AURA_DESKTOP_HOSTS = BASE;
const HOST = `sentinel1--${BASE}`;
const ORIGIN = `http://${HOST}`;
const OTHER = `notes1234--${BASE}`;
const T_INSTALL = '22222222-2222-4222-8222-222222222222';
const N_INSTALL = '33333333-3333-4333-8333-333333333333';
const C_INSTALL = '44444444-4444-4444-8444-444444444444';
const CONSUMER = 'io.lakner.marklayer';
const TARGET = 'com.aura.sentinel';

const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
let respondSlowly = false;
const upstream = http.createServer((req, res) => {
  seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
  res.setHeader('set-cookie', ['own=1; Path=/', 'aura_app_view=forged; Path=/']);
  if (respondSlowly) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: 1\n\n'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('target');
});
upstream.on('upgrade', (req, socket) => {
  seen.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers });
  socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
});
const appPort = await listen(upstream);

const scope = { kind: 'user', userId: 'default' } as const;
const slotOf = (slot: number, label: string, instanceId: string | null) => ({ slot, label, instanceId, assignedAt: instanceId ? 1 : null });
const rec = (appId: string, installationId: string, label: string) => ({
  installationId, appId, instanceScope: scope, baseName: label, state: 'active', slots: [slotOf(1, label, appId)], createdAt: 1,
});
const live = (instanceId: string) => ({ instanceId, port: appPort, state: 'resumed', inPool: false, sandbox: 'proot' });

const labels: Record<string, any> = {
  sentinel1: { status: 'active', record: rec(TARGET, T_INSTALL, 'sentinel1'), slot: slotOf(1, 'sentinel1', TARGET) },
  notes1234: { status: 'active', record: rec('io.acme.notes', N_INSTALL, 'notes1234'), slot: slotOf(1, 'notes1234', 'io.acme.notes') },
};
const apps = [
  { manifest: { id: TARGET, name: 'Sentinel', componentType: 'activity', hosts: [] }, instances: [live(TARGET)] },
  { manifest: { id: 'io.acme.notes', name: 'Notes', componentType: 'activity', hosts: [] }, instances: [live('io.acme.notes')] },
];
const svc = { registry: { resolveLabel: async (l: string) => labels[l] ?? { status: 'unknown' } }, sessionLive: async () => false };

// The live decisions over fakes: manifests, installations, the grant store.
let manifests: Record<string, any>;
let installations: Record<string, string | null>;
let grantRec: any;
let ownerOk: boolean;
const view = createAppView({
  access: { appAccessTargetRefusal: core.appAccessTargetRefusal, appAccessCounts: core.appAccessCounts },
  manifest: (id) => manifests[id],
  scope: (id) => (manifests[id] ? (manifests[id].scopeId ?? 'user') : undefined),
  trustedSystemCopy: (id) => manifests[id]?.scopeId === 'system',
  installation: async (id) => installations[id] ?? null,
  grant: async () => grantRec,
  ownerLive: async (u) => ownerOk && u === 'default',
});

let nowMs = 1_000_000;
const auth = createAppHostAuth({ secret: Buffer.alloc(32, 9), now: () => nowMs });
const env = { AURA_DESKTOP_HOSTS: BASE };
const router = createAppHostRouter({ appsList: async () => apps, services: async () => svc, auth, env, appView: view });
const front = http.createServer((_req, res) => res.end('desktop'));
front.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 418 Desktop\r\n\r\n'));
router.attach(front);
const port = await listen(front);
after(() => { for (const s of [upstream, front]) { s.closeAllConnections?.(); s.close(); } });

const GRANTED_AT = 1_700_000_000_000;
beforeEach(() => {
  manifests = {
    [CONSUMER]: { id: CONSUMER, name: 'MarkLayer', permissions: ['apps.view'], scopeId: 'global' },
    [TARGET]: { id: TARGET, name: 'Sentinel', permissions: [], scopeId: 'user' },
    'io.acme.notes': { id: 'io.acme.notes', name: 'Notes', permissions: [] },
  };
  installations = { [CONSUMER]: C_INSTALL, [TARGET]: T_INSTALL, 'io.acme.notes': N_INSTALL };
  grantRec = {
    subject: { kind: 'app', id: CONSUMER }, permission: 'apps.view', scope: core.appTargetScope(TARGET, T_INSTALL),
    installationId: C_INSTALL, appScope: 'global', grantedAt: GRANTED_AT,
  };
  ownerOk = true;
  respondSlowly = false;
  seen.length = 0;
});

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };
function req(host: string, path = '/', headers: Record<string, string> = {}, method = 'GET', body?: string) {
  return new Promise<Reply>((resolve, reject) => {
    const r = http.request({ port, path, method, agent: false, headers: { host, ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    r.end(body);
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

const issueView = (over: Record<string, unknown> = {}) => auth.issueCode({
  aud: ORIGIN, label: 'sentinel1', installationId: T_INSTALL, appId: TARGET, slot: 1, userId: 'default', sid: 'view:x',
  returnPath: '/', sessionExpiresAt: nowMs + core.APP_VIEW_CREDENTIAL_TTL_MS,
  view: { by: CONSUMER, byInstallation: C_INSTALL, grantedAt: GRANTED_AT }, ...over,
} as never).code;

async function viewCookie(): Promise<string> {
  const r = await req(HOST, `/_aura/handoff?code=${issueView()}`);
  assert.equal(r.status, 303);
  const c = String(r.headers['set-cookie']![0]);
  assert.match(c, /^aura_app_view=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
  return c.split(';')[0]!;
}

const json = (r: Reply) => JSON.parse(r.body);

// ── the router ─────────────────────────────────────────────────────────────

test('a view code redeems to a restricted cookie that reads with GET and HEAD, marked for the target', async () => {
  const cookie = await viewCookie();
  const r = await req(HOST, '/api/findings?x=1', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'target');
  const h = seen.at(-1)!.headers;
  assert.equal(h['x-aura-access'], 'view');
  assert.equal(h['x-aura-access-by'], CONSUMER);
  assert.equal(h.cookie, undefined, 'the view cookie never reaches the target');
  assert.equal(h['x-aura-owner-ssr'], undefined);
  assert.equal((await req(HOST, '/', { cookie }, 'HEAD')).status, 200);
  // The target may not set Aura's cookie names.
  assert.ok(!String(r.headers['set-cookie'] ?? '').includes('aura_app_view'));
});

test('a client cannot forge the delegation mark', async () => {
  const cookie = await viewCookie();
  await req(HOST, '/', { cookie, 'x-aura-access': 'interact', 'x-aura-access-by': 'com.evil' });
  assert.equal(seen.at(-1)!.headers['x-aura-access'], 'view');
  assert.equal(seen.at(-1)!.headers['x-aura-access-by'], CONSUMER);
});

test('a view cookie refuses every write, with the hint', async () => {
  const cookie = await viewCookie();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const r = await req(HOST, '/api/findings', { cookie, 'content-type': 'application/json', 'content-length': '2' }, method, '{}');
    assert.equal(r.status, 403, method);
    const b = json(r);
    assert.equal(b.error, 'access-denied');
    assert.equal(b.permission, 'apps.view');
    assert.equal(b.target, TARGET);
    assert.match(b.hint, /GET or HEAD/);
  }
  assert.equal(seen.length, 0);
});

test('a view cookie opens no WebSocket, gateway mux or event stream', async () => {
  const cookie = await viewCookie();
  assert.match(await upgrade(HOST, '/ws', { Cookie: cookie, Origin: ORIGIN }), /^HTTP\/1\.1 403/);
  assert.match(await upgrade(HOST, '/_aura/os/sse-mux', { Cookie: cookie, Origin: ORIGIN }), /^HTTP\/1\.1 403/);
  const sse = await req(HOST, '/events', { cookie, accept: 'text/event-stream' });
  assert.equal(sse.status, 403);
  assert.equal(seen.length, 0);
});

test('a view cookie reaches no AuraOS API through the target (owner routes)', async () => {
  const cookie = await viewCookie();
  for (const path of ['/_aura/os/api/apps', '/_aura/os/api/admin/grants', '/_aura/os/api/notifications', '/_aura/os/api/kv/os/theme']) {
    const r = await req(HOST, path, { cookie });
    assert.equal(r.status, 403, path);
    assert.equal(json(r).details.refusal, 'not-through-target');
  }
  assert.equal(seen.length, 0);
  assert.equal(viewRequestRefusal({ method: 'GET', headers: {} }, '/_aura/os/api/os/theme.css', '/_aura/os/api/os/theme.css'), null);
});

test('a view cookie is good on its own target only', async () => {
  const cookie = await viewCookie();
  const r = await req(OTHER, '/', { cookie });
  assert.equal(r.status, 401);
  assert.equal(seen.length, 0);
});

test('a view code or cookie in a browser is refused', async () => {
  const code = issueView();
  const r = await req(HOST, `/_aura/handoff?code=${code}`, { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' });
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined, 'no view cookie in a browser response');
  const cookie = await viewCookie();
  const page = await req(HOST, '/', { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'iframe' });
  assert.equal(page.status, 403);
  assert.equal(json(page).details.refusal, 'server-only');
  assert.equal(seen.length, 0);
});

test('revoking ends the cookie on the next request, with the hint', async () => {
  const cookie = await viewCookie();
  assert.equal((await req(HOST, '/', { cookie })).status, 200);
  grantRec = null;   // revoked
  const r = await req(HOST, '/', { cookie });
  assert.equal(r.status, 403);
  const b = json(r);
  assert.equal(b.details.refusal, 'revoked');
  assert.match(b.hint, /aura grant perms io\.lakner\.marklayer apps\.view --target com\.aura\.sentinel/);
});

test('a new grant, a reinstall, a dropped manifest permission or an opt-out end the cookie', async () => {
  const cookie = await viewCookie();
  const cases: Array<() => void> = [
    () => { grantRec = { ...grantRec, grantedAt: GRANTED_AT + 1 }; },
    () => { installations[CONSUMER] = 'another-installation'; },
    () => { grantRec = { ...grantRec, scope: core.appTargetScope(TARGET, 'old-target') }; },
    () => { manifests[CONSUMER] = { ...manifests[CONSUMER], permissions: [] }; },
    () => { manifests[TARGET] = { ...manifests[TARGET], composition: { view: 'deny' } }; },
    () => { ownerOk = false; },
  ];
  for (const [i, change] of cases.entries()) {
    beforeEachReset();
    assert.equal((await req(HOST, '/', { cookie })).status, 200, `case ${i} before`);
    change();
    assert.equal((await req(HOST, '/', { cookie })).status, 403, `case ${i} after`);
  }
});
function beforeEachReset() {
  manifests[CONSUMER] = { id: CONSUMER, name: 'MarkLayer', permissions: ['apps.view'], scopeId: 'global' };
  manifests[TARGET] = { id: TARGET, name: 'Sentinel', permissions: [], scopeId: 'user' };
  installations[CONSUMER] = C_INSTALL;
  grantRec = { subject: { kind: 'app', id: CONSUMER }, permission: 'apps.view', scope: core.appTargetScope(TARGET, T_INSTALL), installationId: C_INSTALL, appScope: 'global', grantedAt: GRANTED_AT };
  ownerOk = true;
}

test('a revoked grant redeems no code', async () => {
  const code = issueView();
  grantRec = null;
  const r = await req(HOST, `/_aura/handoff?code=${code}`);
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('a view cookie never reads as a full or embed sign-in, nor the reverse', async () => {
  const cookie = await viewCookie();
  const value = cookie.split('=').slice(1).join('=');
  const asFull = await req(HOST, '/', { cookie: `aura_app=${value}` });
  assert.equal(asFull.status, 401);
  const asEmbed = await req(HOST, '/', { cookie: `aura_app_embed=${value}` });
  assert.equal(asEmbed.status, 401);
});

test('a delegated read that streams past the limit is cut', async () => {
  // The cap itself is 60 s; here: the stream is refused up front (event-stream), and a GET is bounded by the cap.
  const cookie = await viewCookie();
  assert.equal(core.APP_VIEW_RESPONSE_MAX_MS, 60_000);
  respondSlowly = true;
  const r = await req(HOST, '/events', { cookie, accept: 'text/event-stream' });
  assert.equal(r.status, 403);
});

test('protected targets by id', () => {
  assert.match(appProtection('com.aura.settings') ?? '', /trusted system UI/);
  assert.match(appProtection('com.aura.terminal') ?? '', /trusted system UI|owner agent/);
  assert.match(appProtection('com.aura.aurashelld') ?? '', /owner agent/);
  assert.equal(appProtection('com.aura.sentinel'), null);
});

// ── the handoff route ──────────────────────────────────────────────────────

function routeDeps(over: Partial<AppViewRouteDeps> = {}, principal: any = { kind: 'instance', appId: CONSUMER, instanceId: `${CONSUMER}`, userId: 'default', verification: 'verified' }, via = 'instance-token') {
  const created: any[] = [];
  const granted: any[] = [];
  const consumed: any[] = [];
  const issued: any[] = [];
  let approved = false;
  const deps: AppViewRouteDeps = {
    store: {
      create: async (input: any) => { created.push(input); return { ok: true, record: { id: 'appr_1', expiresAt: 1, display: input.display, ...input } }; },
      consume: async (...args: any[]) => { consumed.push(args); return approved ? { ok: true, record: { id: 'appr_1', decidedBy: { kind: 'user', userId: 'default', sessionId: 's', fresh: false } } } : { ok: false, reason: 'wrong-state' }; },
    } as any,
    appName: (id) => manifests[id]?.name ?? null,
    audit: async () => undefined,
    tickets: { peek: async () => null, claim: async () => null },
    resolve: async () => ({ principal, via } as any),
    view,
    grants: {
      get: async () => grantRec,
      grant: async (subject, permission, opts) => { granted.push({ subject, permission, opts }); grantRec = { subject, permission, scope: opts.scope, installationId: opts.installationId, appScope: opts.appScope, grantedAt: 5 }; return { record: grantRec }; },
    },
    registry: {
      listForApp: async (id) => Object.values(labels).map((l: any) => l.record).filter((r: any) => r.appId === id),
      resolveLabel: async (l) => labels[l] ?? { status: 'unknown' },
    },
    issueCode: (input) => { issued.push(input); return { code: 'c'.repeat(43), expiresAt: 2 }; },
    now: () => 1000,
    ...over,
  };
  return { deps, created, granted, consumed, issued, approve: () => { approved = true; } };
}
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('http://aura-shell:3000/api/app-hosts/view', {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'aura-shell:3000', ...headers }, body: JSON.stringify(body),
});
const ask = { appId: TARGET, desktop: BASE };

test('route: granted → a one-time handoff for the target\'s App Host, bound to the grant', async () => {
  const t = routeDeps();
  const r = await requestAppView(post(ask), t.deps);
  assert.equal(r.status, 200);
  const b = await r.json() as any;
  assert.equal(b.host, HOST);
  assert.equal(b.appId, TARGET);
  assert.equal(b.origin, ORIGIN);
  assert.match(b.url, /^http:\/\/sentinel1--desk\.example\/_aura\/handoff\?code=c{43}$/);
  assert.deepEqual(t.issued[0].view, { by: CONSUMER, byInstallation: C_INSTALL, grantedAt: GRANTED_AT });
  assert.equal(t.issued[0].installationId, T_INSTALL);
  assert.equal(r.headers.get('set-cookie'), null);
  // The App Host address works as the target name too.
  const byHost = await requestAppView(post({ host: HOST }), routeDeps().deps);
  assert.equal(byHost.status, 200);
});

test('route: ungranted → 202 needs-approval (click, apps.view) with the hint; approving grants it pinned to both installations', async () => {
  grantRec = null;
  const t = routeDeps();
  const r = await requestAppView(post(ask), t.deps);
  assert.equal(r.status, 202);
  const b = await r.json() as any;
  assert.equal(b.error, 'needs-approval');
  assert.equal(b.action, 'apps.view');
  assert.equal(b.level, 'session');
  assert.equal(b.approvalId, 'appr_1');
  assert.equal(b.permission, 'apps.view');
  assert.equal(b.holder, 'owner-grant');
  assert.equal(b.target, TARGET);
  assert.match(b.hint, /aura grant perms io\.lakner\.marklayer apps\.view --target com\.aura\.sentinel/);
  assert.match(t.created[0].display.title, /Let MarkLayer read Sentinel/);
  // The dialog states the limit of read-only honestly (D104 owner clarification).
  assert.ok(t.created[0].display.details.some((d: string) => /only reads through \(GET and HEAD/.test(d) && /changes data by itself/.test(d)));
  assert.equal(t.issued.length, 0);

  t.approve();
  const again = await requestAppView(post(ask, { 'x-aura-approval': `apr_${'a'.repeat(22)}` }), t.deps);
  assert.equal(again.status, 200);
  assert.equal(t.consumed.length, 1);
  assert.equal(t.granted.length, 1);
  assert.equal(t.granted[0].permission, 'apps.view');
  assert.deepEqual(t.granted[0].opts.scope, { kind: 'app', id: TARGET, installationId: T_INSTALL });
  assert.equal(t.granted[0].opts.installationId, C_INSTALL);
  assert.deepEqual(t.granted[0].opts.by, { kind: 'user', userId: 'default', session: 's' });
  assert.equal(t.issued[0].view.grantedAt, 5);
});

test('route: not declared → 403 naming the manifest field and the grant command', async () => {
  manifests[CONSUMER] = { ...manifests[CONSUMER], permissions: [] };
  const r = await requestAppView(post(ask), routeDeps().deps);
  assert.equal(r.status, 403);
  const b = await r.json() as any;
  assert.equal(b.error, 'access-denied');
  assert.equal(b.reason, 'missing-permission');
  assert.equal(b.manifestField, 'permissions[]');
  assert.equal(b.holder, 'caller');
  assert.match(b.message, /MarkLayer lacks permission 'apps\.view' for com\.aura\.sentinel/);
  assert.match(b.hint, /Add "apps\.view" to permissions\[\]/);
  assert.match(b.docs, /app-composition/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('route: system, owner-UI, owner-agent and Terminal-session targets are refused, without a grant command', async () => {
  manifests['com.aura.settings'] = { id: 'com.aura.settings', name: 'Settings', permissions: [], scopeId: 'system' };
  manifests['com.aura.terminal'] = { id: 'com.aura.terminal', name: 'Terminal', permissions: [], scopeId: 'user' };   // a same-id copy
  manifests['io.lakner.terminalx'] = { id: 'io.lakner.terminalx', name: 'TerminalX', permissions: ['terminal.embed'], scopeId: 'user' };
  manifests['com.example.syscopy'] = { id: 'com.example.syscopy', name: 'X', permissions: [], scopeId: 'system' };
  for (const target of ['com.aura.settings', 'com.aura.terminal', 'io.lakner.terminalx', 'com.example.syscopy', 'com.aura.aurashelld']) {
    manifests['com.aura.aurashelld'] = { id: 'com.aura.aurashelld', name: 'D', permissions: [], scopeId: 'user' };
    const t = routeDeps();
    const r = await requestAppView(post({ appId: target, desktop: BASE }), t.deps);
    assert.equal(r.status, 403, target);
    const b = await r.json() as any;
    assert.equal(b.reason, 'wrong-target', target);
    assert.doesNotMatch(b.hint, /aura grant/, target);
    assert.equal(t.created.length, 0, `${target}: no approval is asked for`);
  }
});

test('route: a page, the gateway or the owner never gets a view handoff', async () => {
  for (const [principal, via] of [
    [{ kind: 'instance', appId: CONSUMER, instanceId: CONSUMER, userId: 'default', verification: 'verified' }, 'gateway'],
    [{ kind: 'user', userId: 'default', verification: 'verified' }, 'login-session'],
    [{ kind: 'user', userId: 'default', verification: 'verified', through: { appId: CONSUMER } }, 'app-host'],
  ] as const) {
    const r = await requestAppView(post(ask), routeDeps({}, principal, via).deps);
    assert.equal(r.status, 403, via);
    assert.equal((await r.json() as any).details.refusal, 'server-only');
  }
});

test('route: opted-out, unknown and malformed targets, and levels not built yet', async () => {
  manifests[TARGET] = { ...manifests[TARGET], composition: { view: 'deny' } };
  let b = await (await requestAppView(post(ask), routeDeps().deps)).json() as any;
  assert.equal(b.manifestField, 'composition.view');
  manifests[TARGET] = { ...manifests[TARGET], composition: undefined };
  const unknown = await requestAppView(post({ appId: 'com.example.none', desktop: BASE }), routeDeps().deps);
  assert.equal(unknown.status, 404);
  const bad = await requestAppView(post({ appId: TARGET, desktop: 'aura-shell:3000' }), routeDeps().deps);
  assert.equal(bad.status, 400);
  b = await (await requestAppView(post({ ...ask, level: 'interact' }), routeDeps().deps)).json() as any;
  assert.equal(b.details.refusal, 'level-not-available');
});

test('route: a grant to an earlier installation does not count and is asked for again', async () => {
  installations[TARGET] = 'reinstalled';
  labels.sentinel1.record = { ...labels.sentinel1.record, installationId: 'reinstalled' };
  try {
    const r = await requestAppView(post(ask), routeDeps().deps);
    assert.equal(r.status, 202);
    assert.match((await r.json() as any).message, /earlier installation/);
  } finally {
    labels.sentinel1.record = { ...labels.sentinel1.record, installationId: T_INSTALL };
  }
});
