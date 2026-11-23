// Credential rules of the CLI against fake shells on loopback: origins, proxy
// paths, the fake-401 key leak, redirects, SSE and explicit credentials.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultAdminKeyFile } from '@aura/core';
import { api, subscribeEvents } from '../src/lib/client.js';
import { ADMIN_SESSION_FILE, adminLogin, forgetInProcessSession, saveSession } from '../src/lib/admin-session.js';
import {
  holdsInstanceIdentity, isProxyPath, isRunnerShellUrl, isTrustedShellUrl, resetIdentityWarnings,
  resolveIdentity, runnerShellUrl, shellFetch,
} from '../src/lib/identity.js';
import { issueSetupCode, SetupCodeRefused } from '../src/lib/setup-ticket.js';
import { fetchWhoami, localHints } from '../src/commands/identity.js';

const KEY = `aura_admin_${'k'.repeat(43)}`;
const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID',
  'AURA_ADMIN_SESSION', 'AURA_ADMIN_CREDENTIAL', 'AURA_OWNER_LOGIN', 'APP_ID', 'AURA_APP_ID'];

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

test('ordinary API calls and event streams stay anonymous even with a token', async () => {
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
  const event = await new Promise((resolve, reject) => {
    const stop = subscribeEvents('/api/apps/events', (e) => { stop(); resolve(e); }, reject);
  });
  assert.deepEqual(event, { type: 'x' });
  assert.equal(shell.seen.length, 3);
  assert.ok(shell.seen.every((r) => r.auth === undefined));
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

  const res = await shellFetch('/api/apps');
  assert.equal(res.status, 200);
  assert.equal(sink.seen.length, 1);
  assert.equal(sink.seen[0]!.auth, undefined);
});

test('explicit AURA_ADMIN_* keeps working on another URL, with a warning and no value printed', async () => {
  const other = await fakeShell(({ method, url, auth }) => {
    if (method === 'POST' && url === '/api/admin/session') return [200, { token: 'other-session', expiresAt: Date.now() + 60_000 }];
    return auth ? [200, { ok: true }] : [401, { error: 'admin-required' }];
  });
  process.env['AURA_SHELL_URL'] = other.base;
  process.env['AURA_ADMIN_SESSION'] = 'pinned-value';
  const first = await stderrOf(() => api.get('/api/admin/grants'));
  assert.equal(other.seen[0]!.auth, 'Bearer pinned-value');
  assert.match(first, /AURA_ADMIN_SESSION/);
  assert.doesNotMatch(first, /pinned-value/);

  delete process.env['AURA_ADMIN_SESSION'];
  process.env['AURA_ADMIN_CREDENTIAL'] = KEY;
  const second = await stderrOf(() => api.get('/api/admin/grants'));
  assert.match(second, /AURA_ADMIN_CREDENTIAL/);
  assert.ok(!second.includes(KEY));
  assert.equal(other.seen.at(-1)!.auth, 'Bearer other-session');
});

test('an in-process session is bound to the origin that issued it', async () => {
  const a = await fakeShell(({ method }) => (method === 'POST' ? [200, { token: 'a-session', expiresAt: Date.now() + 60_000 }] : [200, {}]));
  const b = await fakeShell();
  process.env['AURA_SHELL_URL'] = a.base;
  process.env['AURA_ADMIN_CREDENTIAL'] = KEY;
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

test('setup codes: refused unless owner login is on, refused in a sandbox', async () => {
  const calls: unknown[][] = [];
  const create = (dir: string, input: { purpose: string }) => { calls.push([dir, input]); return { code: 'c', expiresAt: 1 }; };
  await assert.rejects(issueSetupCode({ purpose: 'setup' }, create), SetupCodeRefused);
  process.env['AURA_OWNER_LOGIN'] = 'on';
  process.env['APP_INSTANCE_ID'] = 'a.b';
  await assert.rejects(issueSetupCode({ purpose: 'setup' }, create), SetupCodeRefused);
  delete process.env['APP_INSTANCE_ID'];
  await assert.rejects(issueSetupCode({ purpose: 'setup' }, null), /no setup ticket support/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await issueSetupCode({ purpose: 'reset', username: 'owner' }, create), { code: 'c', expiresAt: 1 });
  assert.deepEqual(calls[0]![1], { purpose: 'reset', username: 'owner' });
});
