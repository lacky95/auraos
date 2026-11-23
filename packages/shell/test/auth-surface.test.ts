// The dark owner login surface: lib/authSurface.ts and the /api/auth routes.
// Fakes only, so nothing here touches Valkey or AppManager.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoginSession, LoginSessionInput, SetupTicket, UserAccount } from '@aura/core';
import {
  authLogin, authLogout, authPageGate, authSession, authSetup, authStatus, authWhoami,
  MAX_BODY_BYTES, requestScheme,
} from '../src/lib/authSurface.ts';
import type { AuthContext, AuthSurfaceDeps, AuthSurfaceServices } from '../src/lib/authSurface.ts';
import { GET as statusRoute } from '../src/pages/api/auth/status.ts';
import { POST as setupRoute } from '../src/pages/api/auth/setup.ts';
import { POST as loginRoute } from '../src/pages/api/auth/login.ts';
import { POST as logoutRoute } from '../src/pages/api/auth/logout.ts';
import { GET as sessionRoute } from '../src/pages/api/auth/session.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://aura.test:3000';
const PASSWORD = 'correct horse battery';

function fakes() {
  let owner: (UserAccount & { password: string }) | null = null;
  const sessions = new Map<string, LoginSession>();
  const tickets = new Map<string, SetupTicket>();
  const calls = { verify: 0, claim: 0, create: 0 };
  let seq = 0;
  let beforeIssue: (() => Promise<void>) | null = null;
  let epoch = 0;
  const audited: string[] = [];
  const publicUser = () => {
    if (!owner) return null;
    const { password: _password, ...user } = owner;
    return user;
  };
  const services: AuthSurfaceServices = {
    users: {
      hasOwner: async () => owner !== null,
      getOwner: async () => publicUser(),
      createOwner: async ({ username, password }) => {
        calls.create++;
        if (owner) return null;
        owner = { id: 'default', username, password, role: 'owner', createdAt: 1, disabled: false };
        return publicUser();
      },
      verifyPassword: async (username, password) => {
        calls.verify++;
        if (username === 'limited') return { ok: false, reason: 'rate-limited' };
        if (!owner || owner.disabled || owner.username !== username || owner.password !== password) return { ok: false, reason: 'invalid' };
        return { ok: true, user: publicUser()! };
      },
      credentialEpoch: () => epoch,
      recoverOwnerPassword: async (ticket, password) => {
        if (!ticket.username) return { ok: false, reason: 'invalid-ticket' };
        if (!owner) return { ok: false, reason: 'no-owner' };
        if (ticket.username !== owner.username) return { ok: false, reason: 'username-mismatch' };
        owner.password = password;
        epoch += 1;
        const sessionsRevoked = sessions.size;
        sessions.clear();
        audited.push('auth.owner-recovered');
        return { ok: true, user: publicUser()!, recordTrusted: true, sessionsRevoked };
      },
    },
    loginSessions: {
      issue: async (input: LoginSessionInput) => {
        await beforeIssue?.();
        const sessionId = `s${++seq}`;
        const session: LoginSession = {
          sessionId, method: input.method, userId: input.userId, expiresAt: Date.now() + (input.ttlMs ?? 0),
        };
        sessions.set(sessionId, session);
        return { token: `aura-sess1.${sessionId}.mac`, session };
      },
      verify: async (token) => sessions.get(/^aura-sess1\.(\w+)\.mac$/.exec(token ?? '')?.[1] ?? '') ?? null,
      revoke: async (id) => sessions.delete(id),
      revokeByUser: async (userId) => {
        let n = 0;
        for (const [id, s] of sessions) if (s.userId === userId) { sessions.delete(id); n++; }
        return n;
      },
      revokeByMethod: async () => 0,
    },
    setupTickets: {
      claim: async (code, purpose) => {
        calls.claim++;
        const t = tickets.get(code);
        if (!t || t.purpose !== purpose) return null;
        tickets.delete(code);
        return t;
      },
    },
    audit: { record: async (e) => { audited.push(e.action); } },
  };
  const addTicket = (code: string, purpose: 'setup' | 'reset', username?: string) =>
    void tickets.set(code, { sha256: code, purpose, expiresAt: Date.now() + 60_000, username });
  return {
    services, sessions, calls, audited, addTicket,
    disableOwner: () => { if (owner) owner.disabled = true; },
    setBeforeIssue: (fn: (() => Promise<void>) | null) => { beforeIssue = fn; },
    deps: (env: Record<string, string> = {}): AuthSurfaceDeps => ({
      env: { AURA_OWNER_LOGIN: 'on', ...env },
      services: () => services,
      authenticate: async () => ({ kind: 'anonymous', verification: 'unverified' }),
    }),
  };
}

const JSON_HEADERS = { host: 'aura.test:3000', origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

function post(body: unknown, headers: Record<string, string | null> = {}, clientAddress = '10.0.0.9'): AuthContext {
  const merged = Object.fromEntries(
    Object.entries({ ...JSON_HEADERS, ...headers }).filter((e): e is [string, string] => e[1] !== null),
  );
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return { clientAddress, request: new Request('http://localhost/api/auth/x', { method: 'POST', headers: merged, body: payload }) };
}

const get = (headers: Record<string, string> = {}, clientAddress = '10.0.0.9'): AuthContext => ({
  clientAddress,
  request: new Request('http://localhost/api/auth/x', { headers: { host: 'aura.test:3000', ...headers } }),
});

const setupBody = (over: Record<string, unknown> = {}) => ({ code: 'code-1', username: 'lukas', password: PASSWORD, ...over });
const tokenOf = (res: Response) => /=([^;]*);/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';

async function withOwner() {
  const f = fakes();
  await f.addTicket('code-1', 'setup');
  const res = await authSetup(post(setupBody()), f.deps());
  assert.equal(res.status, 200);
  return f;
}

// ── dark by default ─────────────────────────────────────────────────────────

const ROUTES = [
  ['setup', setupRoute, () => post(setupBody())],
  ['login', loginRoute, () => post({ username: 'lukas', password: PASSWORD })],
  ['logout', logoutRoute, () => post({})],
  ['session', sessionRoute, () => get()],
] as const;

for (const flag of [undefined, '', 'off', 'ON', '1', 'true']) {
  test(`flag ${JSON.stringify(flag)}: every route but status and whoami is 404, with no cookie`, async () => {
    const saved = process.env['AURA_OWNER_LOGIN'];
    if (flag === undefined) delete process.env['AURA_OWNER_LOGIN'];
    else process.env['AURA_OWNER_LOGIN'] = flag;
    try {
      for (const [name, route, ctx] of ROUTES) {
        const res = await (route as (c: AuthContext) => Promise<Response>)(ctx());
        assert.equal(res.status, 404, name);
        assert.equal(res.headers.get('set-cookie'), null, name);
        assert.equal(res.headers.get('cache-control'), 'no-store', name);
        assert.equal(await res.text(), '', name);
      }
      const status = await (statusRoute as (c: AuthContext) => Promise<Response>)(get());
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), { login: 'disabled' });
      assert.equal(status.headers.get('cache-control'), 'no-store');
      const gate = authPageGate();
      assert.equal(gate.enabled, false);
      if (!gate.enabled) assert.equal(gate.response.status, 404);
    } finally {
      if (saved === undefined) delete process.env['AURA_OWNER_LOGIN'];
      else process.env['AURA_OWNER_LOGIN'] = saved;
    }
  });
}

test('flag off: no service is touched and the body is not read', async () => {
  const deps: AuthSurfaceDeps = {
    env: {}, services: () => { throw new Error('touched'); },
    authenticate: async () => ({ kind: 'anonymous', verification: 'unverified' }),
  };
  const ctx = post(setupBody());
  assert.equal((await authSetup(ctx, deps)).status, 404);
  assert.equal(ctx.request.bodyUsed, false);
  assert.equal((await authLogin(post({}), deps)).status, 404);
  assert.equal((await authLogout(post({}), deps)).status, 404);
  assert.equal((await authSession(get(), deps)).status, 404);
  assert.deepEqual(await (await authWhoami(get({ cookie: 'aura_session=x' }), deps)).json(), {
    principal: { kind: 'anonymous', verification: 'unverified' },
    login: { state: 'disabled', cookie: 'present', authority: false },
  });
  assert.deepEqual(await (await authStatus(get(), deps)).json(), { login: 'disabled' });
});

test('both pages stop at the gate before rendering anything', () => {
  for (const page of ['setup', 'login']) {
    const src = fs.readFileSync(path.join(root, `src/pages/${page}.astro`), 'utf8');
    const front = src.split('---')[1]!;
    assert.ok(front.indexOf('if (!gate.enabled) return gate.response;') > front.indexOf('authPageGate()'), page);
    assert.ok(!src.includes('OSLayout'), page);
    assert.ok(!/(?:src|href)="https?:/.test(src), `${page}: no third-party asset`);
  }
  assert.ok(!/(?:src|href)="https?:/.test(fs.readFileSync(path.join(root, 'src/layouts/AuthLayout.astro'), 'utf8')));
});

test('nothing outside the surface links to it', () => {
  for (const file of ['src/layouts/OSLayout.astro', 'src/pages/index.astro', 'src/middleware.ts']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/['"`]\/(login|setup)['"`]/.test(src), file);
    assert.ok(!src.includes('/api/auth/'), file);
  }
});

test('the page gate sets the frame, opener and cache headers', () => {
  const gate = authPageGate({ AURA_OWNER_LOGIN: 'on' });
  assert.ok(gate.enabled);
  if (!gate.enabled) return;
  const csp = gate.headers['Content-Security-Policy']!;
  assert.ok(csp.includes(`frame-ancestors 'none'`));
  assert.ok(csp.includes(`script-src 'nonce-${gate.nonce}'`));
  assert.ok(csp.includes(`form-action 'none'`));
  assert.ok(!csp.includes('unsafe-inline'));
  assert.equal(gate.headers['X-Frame-Options'], 'DENY');
  assert.equal(gate.headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(gate.headers['Cache-Control'], 'no-store');
});

// ── status ──────────────────────────────────────────────────────────────────

test('status names no owner and survives missing services', async () => {
  const f = await withOwner();
  const text = await (await authStatus(get(), f.deps())).text();
  assert.deepEqual(JSON.parse(text), { login: 'enabled', setup: 'complete' });
  assert.ok(!text.includes('lukas'));
  const missing: AuthSurfaceDeps = { env: { AURA_OWNER_LOGIN: 'on' }, services: () => null };
  assert.deepEqual(await (await authStatus(get(), missing)).json(), { login: 'unavailable' });
  assert.equal((await authLogin(post({ username: 'lukas', password: PASSWORD }), missing)).status, 503);
});

// ── setup ───────────────────────────────────────────────────────────────────

test('setup with a valid code creates the owner `default`, once', async () => {
  const f = fakes();
  await f.addTicket('code-1', 'setup');
  const res = await authSetup(post(setupBody({ username: ' Lukas ' })), f.deps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null, 'setup does not sign in');
  const owner = await f.services.users.getOwner();
  assert.equal(owner?.id, 'default');
  assert.equal(owner?.username, 'lukas');
  assert.ok(f.audited.includes('auth.setup'));
});

test('a wrong code creates nothing', async () => {
  const f = fakes();
  await f.addTicket('code-1', 'setup');
  const res = await authSetup(post(setupBody({ code: 'wrong' })), f.deps());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'setup-rejected' });
  assert.equal(await f.services.users.hasOwner(), false);
});

test('a reset code is not a setup code', async () => {
  const f = fakes();
  await f.addTicket('code-1', 'reset', 'lukas');
  assert.equal((await authSetup(post(setupBody()), f.deps())).status, 403);
  assert.equal(await f.services.users.hasOwner(), false);
});

test('a replayed code is refused and cannot overwrite the owner', async () => {
  const f = await withOwner();
  const res = await authSetup(post(setupBody({ username: 'mallory', password: 'another long password' })), f.deps());
  assert.equal(res.status, 403);
  assert.equal((await f.services.users.getOwner())?.username, 'lukas');
});

test('after setup a fresh valid code neither replaces the owner nor burns', async () => {
  const f = await withOwner();
  await f.addTicket('code-2', 'setup');
  const before = f.calls.claim;
  const res = await authSetup(post(setupBody({ code: 'code-2', username: 'mallory' })), f.deps());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'setup-rejected' });
  assert.equal(f.calls.claim, before);
  assert.equal((await f.services.users.getOwner())?.username, 'lukas');
  const login = await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps());
  assert.equal(login.status, 200);
});

test('losing the create race answers like any refused setup', async () => {
  const f = fakes();
  await f.addTicket('code-1', 'setup');
  await f.addTicket('code-2', 'setup');
  const results = await Promise.all([
    authSetup(post(setupBody()), f.deps()),
    authSetup(post(setupBody({ code: 'code-2', username: 'second' })), f.deps()),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
});

test('invalid input is refused before a code is claimed', async () => {
  const f = fakes();
  await f.addTicket('code-1', 'setup');
  for (const [over, error] of [
    [{ username: 'x' }, 'invalid-username'],
    [{ username: 'has space' }, 'invalid-username'],
    [{ password: 'short' }, 'invalid-password'],
    [{ password: 'p'.repeat(513) }, 'invalid-password'],
    [{ username: 'longusername12', password: 'LongUsername12' }, 'invalid-password'],
    [{ code: 7 }, 'invalid-request'],
    [{ purpose: 'other' }, 'invalid-request'],
  ] as const) {
    const res = await authSetup(post(setupBody(over)), f.deps());
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal((await res.json()).error, error);
  }
  assert.equal(f.calls.claim, 0);
});

// ── login ───────────────────────────────────────────────────────────────────

test('login failures are identical for a wrong password, an unknown user and a disabled account', async () => {
  const f = await withOwner();
  const answers: string[] = [];
  const attempt = async (username: unknown, password: unknown) => {
    const res = await authLogin(post({ username, password }), f.deps());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    answers.push(await res.text());
  };
  await attempt('lukas', 'wrong password here');
  await attempt('nobody', PASSWORD);
  await attempt('x', PASSWORD);
  await attempt(7, PASSWORD);
  await attempt('lukas', 'p'.repeat(600));
  f.disableOwner();
  await attempt('lukas', PASSWORD);
  assert.equal(new Set(answers).size, 1);
});

test('a rate-limited login is 429 and sets no cookie', async () => {
  const f = await withOwner();
  const res = await authLogin(post({ username: 'limited', password: PASSWORD }), f.deps());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('session and whoami report only the verified principal', async () => {
  const f = await withOwner();
  const login = await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps());
  const token = tokenOf(login);
  const cookie = { cookie: `other=1; aura_session=${token}` };
  const session = await (await authSession(get(cookie), f.deps())).json();
  assert.equal(session.authenticated, true);
  assert.equal(typeof session.expiresAt, 'number');
  const whoRes = await authWhoami(get(cookie), f.deps());
  const whoText = await whoRes.text();
  assert.deepEqual(JSON.parse(whoText), {
    principal: { kind: 'anonymous', verification: 'unverified' },
    login: { state: 'signed-in', authority: false, userId: 'default', username: 'lukas', role: 'owner' },
  });
  assert.ok(!whoText.includes(token));
  assert.ok(!whoText.includes(PASSWORD));
  assert.equal(whoRes.headers.get('cache-control'), 'no-store');

  for (const bad of ['', 'aura_session=aura-sess1.forged.mac', `aura_session=${token}; aura_session=${token}`]) {
    assert.equal((await (await authWhoami(get({ cookie: bad }), f.deps())).json()).login.state, 'signed-out', bad);
  }
  assert.equal((await (await authWhoami(get({ 'x-aura-user': 'default' }), f.deps())).json()).login.state, 'signed-out');
});

test('a session of another kind or a disabled owner is not a principal', async () => {
  const f = await withOwner();
  const { token } = await f.services.loginSessions.issue({ method: 'shared-key', keyFingerprint: 'abc', userId: 'default' });
  assert.equal((await (await authWhoami(get({ cookie: `aura_session=${token}` }), f.deps())).json()).login.state, 'signed-out');
  const login = await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps());
  f.disableOwner();
  assert.deepEqual(await (await authSession(get({ cookie: `aura_session=${tokenOf(login)}` }), f.deps())).json(), { authenticated: false });
});

test('a new login replaces the browser\'s previous session', async () => {
  const f = await withOwner();
  const first = tokenOf(await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps()));
  const second = await authLogin(post({ username: 'lukas', password: PASSWORD }, { cookie: `aura_session=${first}` }), f.deps());
  assert.equal(second.status, 200);
  assert.equal(await f.services.loginSessions.verify(first), null);
  assert.ok(await f.services.loginSessions.verify(tokenOf(second)));
});

test('logout revokes the session and clears the cookie', async () => {
  const f = await withOwner();
  const token = tokenOf(await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps()));
  const res = await authLogout(post({}, { cookie: `aura_session=${token}` }), f.deps());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie')!, /^aura_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax$/);
  assert.equal(await f.services.loginSessions.verify(token), null);
  assert.equal((await authLogout(post({}), f.deps())).status, 200, 'idempotent');
});

// ── reset ───────────────────────────────────────────────────────────────────

const NEW_PASSWORD = 'a brand new passphrase';

test('reset changes the password and revokes every session of that user', async () => {
  const f = await withOwner();
  const a = tokenOf(await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps()));
  const b = tokenOf(await authLogin(post({ username: 'lukas', password: PASSWORD, staySignedIn: true }), f.deps()));
  await f.addTicket('reset-1', 'reset', 'lukas');
  const res = await authSetup(post({ purpose: 'reset', code: 'reset-1', password: NEW_PASSWORD }), f.deps());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(await f.services.loginSessions.verify(a), null);
  assert.equal(await f.services.loginSessions.verify(b), null);
  assert.equal((await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps())).status, 401);
  assert.equal((await authLogin(post({ username: 'lukas', password: NEW_PASSWORD }), f.deps())).status, 200);
  assert.deepEqual(f.audited.filter((a) => a.includes('reset') || a.includes('recovered')), ['auth.owner-recovered']);
});

test('reset is refused without a reset ticket for the owner, and on replay', async () => {
  const f = await withOwner();
  const reset = (code: string) => authSetup(post({ purpose: 'reset', code, password: NEW_PASSWORD }), f.deps());
  await f.addTicket('setup-kind', 'setup');
  await f.addTicket('other-user', 'reset', 'someone');
  await f.addTicket('no-user', 'reset');
  for (const code of ['wrong', 'setup-kind', 'other-user', 'no-user']) {
    const res = await reset(code);
    assert.equal(res.status, 403, code);
    assert.deepEqual(await res.json(), { error: 'setup-rejected' });
  }
  assert.equal((await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps())).status, 200);
  await f.addTicket('reset-1', 'reset', 'lukas');
  assert.equal((await reset('reset-1')).status, 200);
  assert.equal((await reset('reset-1')).status, 403);
});

test('a login that checked the old password cannot outlive a reset', async () => {
  const f = await withOwner();
  await f.addTicket('reset-1', 'reset', 'lukas');
  f.setBeforeIssue(async () => {
    f.setBeforeIssue(null);
    const res = await authSetup(post({ purpose: 'reset', code: 'reset-1', password: NEW_PASSWORD }), f.deps());
    assert.equal(res.status, 200);
  });
  const res = await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps());
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(f.sessions.size, 0);
});

// ── request checks ──────────────────────────────────────────────────────────

test('mutations refuse a wrong, missing or look-alike Origin and cross-site fetches', async () => {
  const f = await withOwner();
  const bad: Record<string, string | null>[] = [
    { origin: null },
    { origin: 'null' },
    { origin: 'http://evil.test' },
    { origin: 'https://aura.test:3000' },
    { origin: 'http://aura.test:3001' },
    { origin: 'http://aura.test:3000.evil.test' },
    { origin: `${ORIGIN}/` },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'none' },
    { host: 'aura.test:3000/path' },
  ];
  for (const handler of [authLogin, authLogout, authSetup]) {
    for (const headers of bad) {
      const res = await handler(post({ username: 'lukas', password: PASSWORD }, headers), f.deps());
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(res.headers.get('set-cookie'), null);
    }
  }
  const noFetchMeta = await authLogin(post({ username: 'lukas', password: PASSWORD }, { 'sec-fetch-site': null }), f.deps());
  assert.equal(noFetchMeta.status, 200, 'Sec-Fetch-Site is checked only when present');
});

test('mutations accept JSON only', async () => {
  const f = await withOwner();
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp']) {
    const res = await authLogin(post({ username: 'lukas', password: PASSWORD }, { 'content-type': type }), f.deps());
    assert.equal(res.status, 415, type);
  }
  for (const body of ['{not json', '[1]', 'null', '"x"']) {
    assert.equal((await authLogin(post(body), f.deps())).status, 400, body);
  }
  const ok = await authLogin(post({ username: 'lukas', password: PASSWORD }, { 'content-type': 'application/json; charset=utf-8' }), f.deps());
  assert.equal(ok.status, 200);
});

test('the body cap holds with and without a Content-Length', async () => {
  const f = await withOwner();
  const big = JSON.stringify({ username: 'lukas', password: 'x'.repeat(MAX_BODY_BYTES) });
  assert.equal((await authLogin(post(big), f.deps())).status, 413);
  const stream = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); },
  });
  const request = new Request('http://localhost/api/auth/login', {
    method: 'POST', headers: JSON_HEADERS, body: stream, duplex: 'half',
  } as RequestInit);
  assert.equal(request.headers.get('content-length'), null);
  assert.equal((await authLogin({ request, clientAddress: '10.0.0.9' }, f.deps())).status, 413);
  assert.equal(f.calls.verify, 0);
});

// ── cookie and transport ────────────────────────────────────────────────────

const PROXY = '10.0.0.2';
const HTTPS_HEADERS = { origin: 'https://aura.test:3000', 'x-forwarded-proto': 'https' };

test('HTTP cookie attributes, 12 hours by default', async () => {
  const f = await withOwner();
  const res = await authLogin(post({ username: 'lukas', password: PASSWORD }), f.deps());
  assert.match(res.headers.get('set-cookie')!, /^aura_session=aura-sess1\.\w+\.mac; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/);
});

test('HTTPS cookie attributes behind a trusted proxy, 30 days when asked', async () => {
  const f = await withOwner();
  const deps = f.deps({ AURA_TRUSTED_PROXIES: `10.9.9.9, ${PROXY}` });
  const res = await authLogin(post({ username: 'lukas', password: PASSWORD, staySignedIn: true }, HTTPS_HEADERS, `::ffff:${PROXY}`), deps);
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-aura_session=aura-sess1\.\w+\.mac; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(!/domain/i.test(cookie));
  // Only `true` means stay signed in.
  const truthy = await authLogin(post({ username: 'lukas', password: PASSWORD, staySignedIn: 'yes' }, HTTPS_HEADERS, PROXY), deps);
  assert.match(truthy.headers.get('set-cookie')!, /Max-Age=43200/);
});

test('a forged X-Forwarded-Proto from an untrusted peer changes nothing', async () => {
  const f = await withOwner();
  for (const env of [{}, { AURA_TRUSTED_PROXIES: PROXY }] as Record<string, string>[]) {
    const deps = f.deps(env);
    const forged = await authLogin(post({ username: 'lukas', password: PASSWORD }, HTTPS_HEADERS), deps);
    assert.equal(forged.status, 403, 'the https Origin no longer matches');
    const res = await authLogin(post({ username: 'lukas', password: PASSWORD }, { 'x-forwarded-proto': 'https', 'x-forwarded-for': PROXY }), deps);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie')!, /^aura_session=/);
  }
});

test('requestScheme: an empty list trusts nobody, and the proxy\'s own value counts', () => {
  const ctx = (proto: string, clientAddress?: string): AuthContext => ({
    clientAddress, request: new Request('http://localhost/', { headers: { 'x-forwarded-proto': proto } }),
  });
  const env = { AURA_TRUSTED_PROXIES: PROXY };
  assert.equal(requestScheme(ctx('https', PROXY), {}), 'http');
  assert.equal(requestScheme(ctx('https', PROXY), { AURA_TRUSTED_PROXIES: ' , ' }), 'http');
  assert.equal(requestScheme(ctx('https'), env), 'http');
  assert.equal(requestScheme(ctx('https', PROXY), env), 'https');
  assert.equal(requestScheme(ctx('https, http', PROXY), env), 'http', 'a client-sent https before the proxy value');
  assert.equal(requestScheme(ctx('http, https', PROXY), env), 'https');
  assert.equal(requestScheme(ctx('gopher', PROXY), env), 'http');
  const throwing = { request: ctx('https').request, get clientAddress(): string { throw new Error('no address'); } };
  assert.equal(requestScheme(throwing, env), 'http');
});

test('the HTTPS and HTTP cookies are never read across transports', async () => {
  const f = await withOwner();
  const deps = f.deps({ AURA_TRUSTED_PROXIES: PROXY });
  const token = tokenOf(await authLogin(post({ username: 'lukas', password: PASSWORD }), deps));
  const overHttps = get({ cookie: `aura_session=${token}`, 'x-forwarded-proto': 'https' }, PROXY);
  assert.deepEqual(await (await authSession(overHttps, deps)).json(), { authenticated: false });
});

test('clientAddress stays the socket peer: astro.config sets no allowedDomains', () => {
  const config = fs.readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');
  assert.ok(!config.includes('allowedDomains'), 'with allowedDomains, Astro takes clientAddress from X-Forwarded-For');
});
