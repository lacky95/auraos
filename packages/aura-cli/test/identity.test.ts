// Credential rules of the CLI against fake shells on loopback: origins, proxy
// paths, the fake-401 key leak, redirects, SSE and explicit credentials.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultAdminKeyFile } from '@aura/core';
import { api, subscribeEvents } from '../src/lib/client.js';
import { ADMIN_SESSION_FILE, adminLogin, forgetInProcessSession, obtainCredential, saveSession } from '../src/lib/admin-session.js';
import {
  holdsInstanceIdentity, isProxyPath, isRunnerShellUrl, isTrustedShellUrl, resetIdentityWarnings,
  resolveIdentity, runnerShellUrl, shellFetch,
} from '../src/lib/identity.js';
import { issueSetupCode, SetupCodeRefused } from '../src/lib/setup-ticket.js';
import { fetchWhoami, localHints } from '../src/commands/identity.js';
import { notifPermission, printAccessReport } from '../src/commands/admin.js';
import { eventKey, readAccessReport } from '../../shell/src/lib/access/report.ts';
import { osAuthHeaders } from '../../app-sdk/src/os-auth.ts';

const KEY = `aura_admin_${'k'.repeat(43)}`;
const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID',
  'AURA_ADMIN_SESSION', 'AURA_ADMIN_CREDENTIAL', 'APP_ID', 'AURA_APP_ID'];

interface Seen { method: string; url: string; auth?: string; body: string }
type Handler = (r: Seen, res: http.ServerResponse) => [number, unknown] | 'handled';
const servers: http.Server[] = [];

async function fakeShell(handler: Handler = () => [200, {}]): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rec: Seen = { method: req.method ?? '', url: req.url ?? '', body, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) };
    seen.push(rec);
    const out = handler(rec, res);
    if (out === 'handled') return;
    res.writeHead(out[0], { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out[1]));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const fake401: Handler = ({ method, url }) => (method === 'POST' && url === '/api/admin/session'
  ? [200, { token: 'fresh-session', expiresAt: Date.now() + 60_000 }]
  : [401, { error: 'admin-required' }]);

function writeKey(): void {
  const f = defaultAdminKeyFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${KEY}\n`, { mode: 0o600 });
}

async function stderrOf(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stderr.write;
  let out = '';
  process.stderr.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stderr.write;
  try { await fn(); } finally { process.stderr.write = original; }
  return out;
}

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  forgetInProcessSession();
  resetIdentityWarnings();
  rmSync(ADMIN_SESSION_FILE, { force: true });
  rmSync(defaultAdminKeyFile(), { force: true });
});

afterEach(() => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); }
});

test('origin rules: runner origin, loopback default, look-alikes', () => {
  assert.equal(isTrustedShellUrl('http://127.0.0.1:3000/api/x'), true, 'default shell with no runner env');
  assert.equal(isRunnerShellUrl('http://127.0.0.1:3000/api/x'), false, 'an instance token needs a runner origin');
  process.env['OS_API_BASE'] = 'http://aura-shell:3000';
  assert.equal(isTrustedShellUrl('http://aura-shell:3000/api/x'), true);
  assert.equal(isRunnerShellUrl('http://aura-shell:3000/api/x'), true);
  for (const bad of ['http://127.0.0.1:3000', 'https://aura-shell:3000', 'http://aura-shell:3001',
    'http://aura-shell:3000@evil.test', 'http://aura-shell:3000.evil.test', 'not a url']) {
    assert.equal(isTrustedShellUrl(bad), false, bad);
    assert.equal(isRunnerShellUrl(bad), false, bad);
  }
  delete process.env['OS_API_BASE'];
  process.env['AURA_OS_URL'] = 'http://aura-shell:3000';
  assert.equal(isRunnerShellUrl('http://aura-shell:3000'), true, 'AURA_OS_URL counts');
});

test('the sandbox base ignores AURA_SHELL_URL', () => {
  process.env['AURA_SHELL_URL'] = 'http://evil.test';
  assert.equal(runnerShellUrl(), 'http://127.0.0.1:3000');
  process.env['OS_API_BASE'] = 'http://aura-shell:3000';
  assert.equal(runnerShellUrl(), 'http://aura-shell:3000');
});

test('proxy paths in any spelling get no credential', async () => {
  for (const p of ['/api/proxy/a/b', '/api/proxy', '//api/proxy/a', '/API/Proxy/a', '/api/admin/../proxy/a',
    '/api/%70roxy/a', '/api/%2570roxy/a', '/api/admin/%2e%2e/proxy/a', '/api\\proxy\\a', '/%zz']) {
    assert.equal(isProxyPath(p), true, p);
  }
  assert.equal(isProxyPath('/api/proxyish'), false);
  assert.equal(isProxyPath('/api/admin/grants'), false);

  const shell = await fakeShell();
  process.env['OS_API_BASE'] = shell.base;
  process.env['AURA_INSTANCE_TOKEN'] = 'inst-token';
  process.env['APP_INSTANCE_ID'] = 'a.b';
  process.env['AURA_ADMIN_SESSION'] = 'pinned';
  await shellFetch('/api/proxy/a/b', { intent: 'admin' });
  await shellFetch('/api/admin/../proxy/a', { intent: 'admin' });
  await shellFetch('/api/proxy/a', { intent: 'instance', instanceId: 'a.b' });
  await shellFetch('/api/proxy/a', { intent: 'whoami' });
  assert.equal(shell.seen.length, 4);
  assert.ok(shell.seen.every((r) => r.auth === undefined));
});

test('instance token: only to the runner origin, only for its own instance', async () => {
  const runner = await fakeShell();
  const other = await fakeShell();
  process.env['OS_API_BASE'] = runner.base;
  process.env['AURA_INSTANCE_TOKEN'] = 'inst-token';
  process.env['APP_INSTANCE_ID'] = 'a.b';

  assert.equal(holdsInstanceIdentity('a.b'), true);
  assert.equal(holdsInstanceIdentity('c.d'), false);
  await shellFetch('/api/instances/a.b/sidecars', { intent: 'instance', instanceId: 'a.b' });
  await shellFetch('/api/instances/c.d/sidecars', { intent: 'instance', instanceId: 'c.d' });
  assert.equal(runner.seen[0]!.auth, 'Bearer inst-token');
  assert.equal(runner.seen[1]!.auth, undefined);

  process.env['AURA_SHELL_URL'] = other.base;
  assert.equal(holdsInstanceIdentity('a.b'), false);
  await shellFetch('/api/instances/a.b/sidecars', { intent: 'instance', instanceId: 'a.b' });
  assert.equal(other.seen[0]!.auth, undefined);
});

test('every shell call and event stream carries the instance token, never an admin session (5.8)', async () => {
  const shell = await fakeShell(({ url }, res) => {
    if (url !== '/api/apps/events') return [200, []];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"x"}\n\n');
    return 'handled';
  });
  process.env['OS_API_BASE'] = shell.base;
  process.env['AURA_INSTANCE_TOKEN'] = 'inst-token';
  process.env['APP_INSTANCE_ID'] = 'a.b';
  process.env['AURA_ADMIN_SESSION'] = 'pinned';
  await api.get('/api/apps');
  await api.post('/api/notifications', { title: 't' });
  await shellFetch('/api/kv/os/theme');
  const event = await new Promise((resolve, reject) => {
    const stop = subscribeEvents('/api/apps/events', (e) => { stop(); resolve(e); }, reject);
  });
  assert.deepEqual(event, { type: 'x' });
  assert.equal(shell.seen.length, 4);
  assert.ok(shell.seen.every((r) => r.auth === 'Bearer inst-token'), JSON.stringify(shell.seen));
  // An admin route takes the admin session when there is one, else the token.
  await api.get('/api/admin/grants');
  assert.equal(shell.seen.at(-1)!.auth, 'Bearer pinned');
  delete process.env['AURA_ADMIN_SESSION'];
  await shellFetch('/api/admin/grants', { intent: 'admin' });
  assert.equal(shell.seen.at(-1)!.auth, 'Bearer inst-token');
});

test('the instance token never goes to a foreign URL or through the proxy (D28: MCP stays tokenless)', async () => {
  const runner = await fakeShell(({ url }, res) => {
    if (url !== '/api/apps/events') return [200, []];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"y"}\n\n');
    return 'handled';
  });
  const foreign = await fakeShell(({ url }, res) => {
    if (url !== '/api/apps/events') return [200, []];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"x"}\n\n');
    return 'handled';
  });
  process.env['OS_API_BASE'] = runner.base;
  process.env['AURA_INSTANCE_TOKEN'] = 'inst-token';
  process.env['APP_INSTANCE_ID'] = 'a.b';
  await shellFetch('/api/proxy/com.aura.docs/mcp', { method: 'POST' });
  await api.post('/api/proxy/com.aura.docs/mcp', {});
  assert.ok(runner.seen.every((r) => r.auth === undefined), 'proxied calls carry no token');
  process.env['AURA_SHELL_URL'] = foreign.base;
  await api.get('/api/apps');
  await new Promise((resolve, reject) => {
    const stop = subscribeEvents('/api/apps/events', (e) => { stop(); resolve(e); }, reject);
  });
  assert.equal(foreign.seen.length, 2);
  assert.ok(foreign.seen.every((r) => r.auth === undefined), 'nothing for a URL the runner did not inject');
});

test('fake 401 from a non-shell URL: no key read, nothing sent, saved session kept', async () => {
  writeKey();
  saveSession({ token: 'saved-session', expiresAt: Date.now() + 60_000 });
  const evil = await fakeShell(fake401);
  process.env['OS_API_BASE'] = 'http://127.0.0.1:1';
  process.env['AURA_SHELL_URL'] = evil.base;

  await assert.rejects(api.get('/api/admin/grants'), (e: Error & { status?: number }) => e.status === 401 && /not this system's shell/.test(e.message));
  assert.equal(evil.seen.length, 1, 'no login attempt followed the 401');
  assert.equal(evil.seen[0]!.auth, undefined);
  assert.ok(!evil.seen[0]!.body.includes(KEY));
  assert.equal(existsSync(ADMIN_SESSION_FILE), true, 'a fake 401 cannot delete the saved session');
});

test('the same applies with no runner env and a custom --shell-url', async () => {
  writeKey();
  const evil = await fakeShell(fake401);
  process.env['AURA_SHELL_URL'] = evil.base;
  await assert.rejects(api.get('/api/admin/grants'));
  assert.equal(evil.seen.length, 1);
  assert.ok(evil.seen.every((r) => r.auth === undefined && !r.body.includes(KEY)));
});

test('a real 401 from the trusted shell still recovers with the master key', async () => {
  writeKey();
  const shell = await fakeShell(({ method, url, auth }) => {
    if (method === 'POST' && url === '/api/admin/session') return [200, { token: 'fresh-session', expiresAt: Date.now() + 60_000 }];
    return auth === 'Bearer fresh-session' ? [200, { ok: true }] : [401, { error: 'admin-required' }];
  });
  process.env['OS_API_BASE'] = shell.base;
  assert.deepEqual(await api.get('/api/admin/grants'), { ok: true });
  assert.equal(JSON.parse(shell.seen[1]!.body).credential, KEY);
  assert.equal(shell.seen[2]!.auth, 'Bearer fresh-session');
});

test('credentialed requests never follow a redirect; anonymous ones still do', async () => {
  const sink = await fakeShell();
  const shell = await fakeShell((_r, res) => {
    res.writeHead(307, { Location: `${sink.base}/stolen` });
    res.end();
    return 'handled';
  });
  process.env['OS_API_BASE'] = shell.base;
  process.env['AURA_INSTANCE_TOKEN'] = 'inst-token';
  process.env['APP_INSTANCE_ID'] = 'a.b';
  process.env['AURA_ADMIN_SESSION'] = 'pinned';

  await assert.rejects(shellFetch('/api/admin/grants', { intent: 'admin' }));
  await assert.rejects(shellFetch('/api/instances/a.b/sidecars', { intent: 'instance', instanceId: 'a.b' }));
  await assert.rejects(adminLogin(KEY));
  assert.equal(sink.seen.length, 0, 'nothing reached the redirect target');

  await assert.rejects(shellFetch('/api/apps'), undefined, 'an ordinary call carries the token now');
  const res = await shellFetch('/api/apps', { intent: 'anonymous' });
  assert.equal(res.status, 200);
  assert.equal(sink.seen.length, 1);
  assert.equal(sink.seen[0]!.auth, undefined);
});

test('explicit AURA_ADMIN_* is never sent to another URL, even after a 401', async () => {
  const other = await fakeShell(fake401);
  process.env['AURA_SHELL_URL'] = other.base;
  const refused = (e: Error & { status?: number }) => e.status === 401 && /not this system's shell/.test(e.message) && /AURA_ADMIN_/.test(e.message);

  process.env['AURA_ADMIN_SESSION'] = 'pinned-value';
  const first = await stderrOf(() => assert.rejects(api.get('/api/admin/grants'), refused));
  assert.match(first, /AURA_ADMIN_/);
  assert.doesNotMatch(first, /pinned-value/);
  assert.equal(resolveIdentity({ url: other.base, path: '/api/admin/x', intent: 'whoami' }).kind, 'none');

  delete process.env['AURA_ADMIN_SESSION'];
  process.env['AURA_ADMIN_CREDENTIAL'] = KEY;
  await assert.rejects(api.get('/api/admin/grants'), refused);
  await assert.rejects(obtainCredential('login'), /not this system's shell/);
  assert.equal(await obtainCredential('recover'), null);
  await assert.rejects(adminLogin(KEY), /not this system's shell/);

  assert.ok(other.seen.every((r) => r.auth === undefined && !r.body.includes(KEY) && !r.body.includes('pinned-value')));
  assert.ok(other.seen.every((r) => r.method === 'GET'), 'no credential exchange was attempted');
});

test('explicit AURA_ADMIN_* still works on the trusted shell', async () => {
  const shell = await fakeShell(({ method, url, auth }) => {
    if (method === 'POST' && url === '/api/admin/session') return [200, { token: 'env-session', expiresAt: Date.now() + 60_000 }];
    return auth ? [200, { ok: true }] : [401, { error: 'admin-required' }];
  });
  process.env['OS_API_BASE'] = shell.base;
  process.env['AURA_ADMIN_SESSION'] = 'pinned-value';
  assert.deepEqual(await api.get('/api/admin/grants'), { ok: true });
  assert.equal(shell.seen[0]!.auth, 'Bearer pinned-value');
  delete process.env['AURA_ADMIN_SESSION'];
  process.env['AURA_ADMIN_CREDENTIAL'] = KEY;
  assert.deepEqual(await api.get('/api/admin/grants'), { ok: true });
  assert.equal(shell.seen.at(-1)!.auth, 'Bearer env-session');
});

test('an in-process session is bound to the origin that issued it', async () => {
  const a = await fakeShell(({ method }) => (method === 'POST' ? [200, { token: 'a-session', expiresAt: Date.now() + 60_000 }] : [200, {}]));
  const b = await fakeShell();
  process.env['OS_API_BASE'] = a.base;
  await stderrOf(() => adminLogin(KEY));
  assert.equal(resolveIdentity({ url: a.base, path: '/api/admin/x', intent: 'admin' }).kind, 'admin');
  assert.equal(resolveIdentity({ url: b.base, path: '/api/admin/x', intent: 'admin' }).kind, 'none');
});

test('whoami: verified, dark, rejected, unreachable; no secret in the output', async () => {
  let reply: [number, unknown] = [200, { principal: { kind: 'instance', appId: 'a.b', token: 'must-not-show', secretKey: 'x' } }];
  const shell = await fakeShell(() => reply);
  process.env['OS_API_BASE'] = shell.base;
  process.env['AURA_INSTANCE_TOKEN'] = 'inst-token';
  process.env['APP_INSTANCE_ID'] = 'a.b';
  assert.deepEqual(await fetchWhoami(), { state: 'verified', identity: { kind: 'instance', appId: 'a.b' } });
  assert.equal(shell.seen[0]!.auth, 'Bearer inst-token');
  assert.ok(!JSON.stringify(localHints()).includes('inst-token'));

  reply = [404, {}];
  assert.deepEqual(await fetchWhoami(), { state: 'unavailable', status: 404 });
  reply = [401, { error: 'invalid' }];
  assert.equal((await fetchWhoami()).state, 'rejected');
  process.env['OS_API_BASE'] = 'http://127.0.0.1:1';
  assert.equal((await fetchWhoami()).state, 'unreachable');
});

test('setup codes: refused in a sandbox', async () => {
  const calls: unknown[][] = [];
  const create = (dir: string, input: { purpose: string }) => { calls.push([dir, input]); return { code: 'c', expiresAt: 1 }; };
  process.env['APP_INSTANCE_ID'] = 'a.b';
  await assert.rejects(issueSetupCode({ purpose: 'setup' }, create), SetupCodeRefused);
  delete process.env['APP_INSTANCE_ID'];
  assert.equal(calls.length, 0);
  assert.deepEqual(await issueSetupCode({ purpose: 'reset', username: 'owner' }, create), { code: 'c', expiresAt: 1 });
  assert.deepEqual(calls[0]![1], { purpose: 'reset', username: 'owner' });
});

test('setup-code: the real path writes one private ticket and opens no connection', async () => {
  const connect = net.Socket.prototype.connect;
  let connections = 0;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    connections += 1;
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  try {
    const dir = join(process.env['AURA_DATA_DIR']!, 'aura', 'secrets', 'setup-tickets');
    // Earlier calls here left the host operator's request tickets (lib/identity.ts).
    const earlier = new Set(existsSync(dir) ? readdirSync(dir) : []);
    const { code } = await issueSetupCode({ purpose: 'reset', username: 'owner' });
    assert.equal(connections, 0);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !earlier.has(f));
    assert.equal(files.length, 1);
    assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
    const stored = readFileSync(join(dir, files[0]!), 'utf-8');
    assert.equal(JSON.parse(stored).username, 'owner');
    assert.ok(!stored.includes(code) && !stored.includes(code.replace(/-/g, '')));
  } finally {
    net.Socket.prototype.connect = connect;
  }
});

test('access-report: prints the shape the real report reader returns', async () => {
  const key = eventKey({
    surface: 'api', subject: '/api/apps', method: 'GET', variant: null, principal: 'anonymous', appId: null,
    decision: 'deny', reason: 'unauthenticated', status: '2xx', via: 'none',
  } as Parameters<typeof eventKey>[0]);
  const read = await readAccessReport({
    hgetall: async () => ({ [key]: '3', '#dropped': '2' }),
    xrevrange: async () => [['1-0', ['subject', '/api/apps', 'decision', 'deny']]],
  } as unknown as Parameters<typeof readAccessReport>[0], 1, Date.UTC(2026, 10, 23));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try { printAccessReport({ ...read, pending: { keys: 1, events: 4, meta: {} } }); }
  finally { console.log = log; }
  const out = lines.join('\n');
  for (const want of ['2026-11-23', '/api/apps', 'unauthenticated', 'dropped=2', 'would-deny samples', 'pending flush: 4 event(s)']) {
    assert.ok(out.includes(want), want);
  }
  assert.ok(!out.includes('[object Object]') && !out.includes('{"'));
});

test('the CLI and the SDK agree on what is a proxy path', () => {
  const cases = [
    '/api/proxy', '/api/proxy/', '/api/proxy/a/b', '/API/PROXY/a', '/api//proxy/a', '//api/proxy/a', '/api/./proxy/a',
    '/api/x/../proxy/a', '/api/%70roxy/a', '/api/%2570roxy/a', '/api\\proxy/a', '/api/proxy?x=1', '/api/proxy#x',
    'http://shell:3000/api/proxy/a', 'http://shell:3000/api/%70roxy/a', '/api/%zz', 'not a url',
    '/api/proxyish', '/api/admin/grants', '/api/apps', 'http://shell:3000/api/apps', '/api/apps?u=/api/proxy/a',
  ];
  for (const c of cases) {
    const sdkProxied = Object.keys(osAuthHeaders(c, { token: 't' })).length === 0;
    assert.equal(sdkProxied, isProxyPath(c), c);
  }
  assert.equal(isProxyPath('/api/proxy/a'), true);
  assert.equal(isProxyPath('/api/apps'), false);
});

test('the owner\'s Terminal grants pass by their full name, terminal.screen.read included', () => {
  for (const p of ['terminal.embed', 'terminal.sessions.list', 'terminal.screen.read']) assert.equal(notifPermission(p), p);
});
