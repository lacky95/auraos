// Phase 1 integration: the login surface on the REAL stores (a throwaway
// valkey-server and data dir), and proof that the report-only path is fail-open.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import { defaultRedis, kvServer } from '@aura/kv-store';
import { captureAccess, createAccessReporter } from '../src/lib/access/guard.ts';
import { createObserver, identifyRequest } from '../src/lib/access/observer.ts';
import type { ObserverDeps } from '../src/lib/access/observer.ts';
import { AccessReport } from '../src/lib/access/report.ts';
import type { ReportRedis } from '../src/lib/access/report.ts';
import type { RouteAccessManifest } from '../src/lib/access/types.ts';
import { publicInstance } from '../src/lib/appResponse.ts';
import { authenticate } from '../src/lib/auth.ts';
import type { AuthDeps } from '../src/lib/auth.ts';
import {
  authLogin, authLogout, authSession, authSetup, authStatus, authWhoami, clientRateKey, coreAuthServices, desktopSignIn,
} from '../src/lib/authSurface.ts';
import type { AuthContext, AuthNotice, AuthSurfaceDeps, AuthSurfaceServices } from '../src/lib/authSurface.ts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-auth-integration-'));
process.env['AURA_DATA_DIR'] = DATA_DIR;

const ORIGIN = 'http://aura.test:3000';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';
const ANONYMOUS = { kind: 'anonymous', verification: 'unverified' };

const notices: AuthNotice[] = [];
const noticeBodies: string[] = [];

function authDeps(): AuthDeps {
  const svc = core.getAuthServices();
  const mgr = {
    tokens: { verify: () => null, hasNonce: () => false },
    getInstance: () => undefined,
    getInstancesByApp: () => [],
  } as unknown as AuthDeps['mgr'];
  return { mgr, apiKeys: svc.apiKeys, admin: svc.admin };
}

function services(over: Partial<AuthSurfaceServices> = {}): AuthSurfaceServices {
  const real = coreAuthServices();
  assert.ok(real, 'core auth services');
  return {
    ...real,
    notify: async (notice) => {
      const created = await real.notify!(notice);
      notices.push(notice);
      noticeBodies.push(JSON.stringify(created));
      return created;
    },
    ...over,
  };
}

const on = (over: Partial<AuthSurfaceServices> = {}): AuthSurfaceDeps => ({
  env: {},
  services: () => services(over),
  authenticate: (request) => authenticate(request, authDeps()),
});

let client = 0;
const post = (body: unknown, headers: Record<string, string> = {}): AuthContext => ({
  clientAddress: `10.1.0.${(client = (client % 200) + 1)}`,
  request: new Request('http://localhost/api/auth/x', {
    method: 'POST',
    headers: { host: 'aura.test:3000', origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  }),
});
const get = (headers: Record<string, string> = {}): AuthContext => ({
  clientAddress: '10.2.0.1',
  request: new Request('http://localhost/api/auth/x', { headers: { host: 'aura.test:3000', ...headers } }),
});
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;
const whoami = async (cookie: string) => (await authWhoami(get({ cookie }), on())).json();
const login = (password: string) => authLogin(post({ username: 'lukas', password }), on());
const code = (purpose: 'setup' | 'reset') =>
  core.createSetupTicket(DATA_DIR, { purpose, ...(purpose === 'reset' ? { username: 'lukas' } : {}) }).code;
const reset = (ticket: string, deps = on()) => authSetup(post({ purpose: 'reset', code: ticket, password: NEW_PASSWORD }), deps);
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const auditOf = async (action: string) =>
  (await core.getAuthServices().audit.list(200)).filter((e) => e.action === action);

before(async () => { await kvServer.start({ dataDir: join(DATA_DIR, 'kv') }); });
after(async () => {
  await settle();
  core.getNotificationService().stop?.();
  defaultRedis().disconnect();
  await kvServer.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ── real stores ─────────────────────────────────────────────────────────────

test('before setup: no owner, and the desktop sends the browser to setup', async () => {
  assert.equal(await core.getAuthServices().users.hasOwner(), false);
  assert.deepEqual(await (await authStatus(get(), on())).json(), { login: 'enabled', setup: 'required' });
  const gate = await desktopSignIn(get(), on());
  assert.equal(gate?.headers.get('location'), '/setup');
});


test('setup is once only, and a replayed code is refused', async () => {
  const ticket = code('setup');
  const body = { code: ticket, username: 'lukas', password: PASSWORD };
  assert.equal((await authSetup(post({ ...body, password: 'abc' }), on())).status, 400, 'core password policy');
  const res = await authSetup(post(body), on());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal((await authSetup(post(body), on())).status, 403);
  assert.equal((await core.getAuthServices().users.getOwner())?.username, 'lukas');
  const [entry] = await auditOf(core.IDENTITY_AUDIT_ACTIONS.setup);
  assert.equal(entry?.actor, 'operator');
  await settle();
  assert.deepEqual(notices, ['setup']);
});

test('login, labelled whoami, no authority from the cookie, logout', async () => {
  assert.equal((await login('the wrong password')).status, 401);
  const res = await login(PASSWORD);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie')!, /HttpOnly/);
  const cookie = cookieOf(res);

  assert.equal((await (await authSession(get({ cookie }), on())).json()).authenticated, true);
  assert.deepEqual(await whoami(cookie), {
    principal: ANONYMOUS,
    login: { state: 'signed-in', authority: false, userId: 'default', username: 'lukas', role: 'owner' },
  });
  const seen = await authenticate(new Request('http://localhost/api/x', { headers: { cookie } }), authDeps());
  assert.ok(!(seen instanceof Response));
  assert.equal(seen.kind, 'anonymous', 'a login cookie grants no authority');
  const token = cookie.split('=')[1]!;
  const bearer = await authenticate(new Request('http://localhost/api/x', { headers: { authorization: `Bearer ${token}` } }), authDeps());
  assert.ok(bearer instanceof Response && bearer.status === 401, 'nor does the session token as a bearer');

  const [audited] = await auditOf(core.IDENTITY_AUDIT_ACTIONS.login);
  assert.equal(audited?.actor, 'user:default');
  assert.ok(audited?.session);

  const out = await authLogout(post({}, { cookie }), on());
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await whoami(cookie)).login.state, 'signed-out');
  assert.equal((await auditOf(core.IDENTITY_AUDIT_ACTIONS.logout))[0]?.actor, 'user:default');
});

test('reset revokes sessions, audits once with the final outcome, and a replay fails', async () => {
  const before = cookieOf(await login(PASSWORD));
  const ticket = code('reset');
  const res = await reset(ticket);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal((await whoami(before)).login.state, 'signed-out', 'stale session');
  assert.equal((await login(PASSWORD)).status, 401);
  assert.equal((await login(NEW_PASSWORD)).status, 200);
  assert.equal((await reset(ticket)).status, 403, 'replayed code');

  const recovered = await auditOf(core.IDENTITY_AUDIT_ACTIONS.ownerRecovered);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.outcome, 'ok');
  assert.equal(recovered[0]!.actor, 'operator');
  await settle();
  assert.deepEqual(notices, ['setup', 'reset']);
  for (const body of noticeBodies) {
    assert.ok(!body.includes(ticket) && !body.includes(PASSWORD) && !body.includes(NEW_PASSWORD));
  }
});

test('a login that checked the old password cannot outlive a reset', async () => {
  const real = core.getAuthServices().loginSessions;
  const ticket = code('reset');
  let raced = false;
  const racing = Object.create(real) as typeof real;
  racing.issue = async (input) => {
    if (!raced) {
      raced = true;
      assert.equal((await reset(ticket)).status, 200);
    }
    return real.issue(input);
  };
  const res = await authLogin(post({ username: 'lukas', password: NEW_PASSWORD }), on({ loginSessions: racing }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal((await core.getAuthServices().audit.list(1))[0]?.outcome, 'ok');
});

test('a failed revoke is reported, in the audit and to the caller', async () => {
  const failing = new core.ValkeyUserStore({
    identityKeyFile: core.defaultIdentityKeyFile(DATA_DIR),
    redis: () => defaultRedis(),
    sessions: { revokeByMethod: async () => { throw new Error('valkey'); }, revokeByUser: async () => 0 },
    onOwnerRecovered: async (e) => {
      await core.getAuthServices().audit.record({
        by: core.operatorAttribution(), action: core.IDENTITY_AUDIT_ACTIONS.ownerRecovered,
        outcome: e.sessionsRevoked === null ? 'failed' : 'ok',
      });
    },
  });
  const res = await reset(code('reset'), on({ users: failing }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, sessionsRevoked: false });
  assert.equal((await auditOf(core.IDENTITY_AUDIT_ACTIONS.ownerRecovered))[0]!.outcome, 'failed');
  await settle();
  assert.equal(notices.at(-1), 'reset-sessions-kept');
});

test('rate-limit key: forwarded addresses count only from a configured proxy', () => {
  const ctx = (clientAddress: string, xff: string): AuthContext => ({
    clientAddress,
    request: new Request('http://localhost/', { headers: { 'x-forwarded-for': xff } }),
  });
  const env = { AURA_TRUSTED_PROXIES: '10.0.0.1' };
  assert.equal(clientRateKey(ctx('203.0.113.9', '1.2.3.4'), env), 'ip:203.0.113.9');
  assert.equal(clientRateKey(ctx('203.0.113.9', '1.2.3.4'), {}), 'ip:203.0.113.9');
  assert.equal(clientRateKey(ctx('10.0.0.1', '9.9.9.9, 1.2.3.4'), env), 'ip:1.2.3.4');
  assert.equal(clientRateKey(ctx('10.0.0.1', '1.2.3.4, 10.0.0.1'), env), 'ip:1.2.3.4');
  assert.equal(clientRateKey(ctx('10.0.0.1', 'not-an-ip'), env), 'ip:10.0.0.1');
});

// ── fail-open ───────────────────────────────────────────────────────────────

async function served(reporter: ReturnType<typeof createAccessReporter>) {
  const request = new Request('http://localhost/api/apps?x=1', {
    headers: { authorization: 'Bearer aura_k1_bad', cookie: 'aura_session=x', referer: 'http://localhost/api/proxy/a/' },
  });
  const snapshot = captureAccess({ request, url: new URL(request.url), routePattern: '/api/apps', params: {} });
  assert.ok(snapshot);
  const res = new Response('{"apps":[]}', { status: 207, headers: { 'content-type': 'application/json', 'x-handler': 'yes' } });
  reporter(snapshot, res.status);
  await settle();
  return { status: res.status, headers: [...res.headers], body: await res.text() };
}

const throwing = (): never => { throw new Error('down'); };
const brokenDeps = {
  authorizer: { authorize: async () => throwing() },
  mgr: throwing, services: throwing, redisReady: throwing, internalSecret: throwing,
} as unknown as ObserverDeps;
const deadRedis = (): ReportRedis => ({
  pipeline: throwing, xadd: async () => throwing(), expire: async () => throwing(),
});

test('fail-open: a throwing observer, unavailable Valkey or bad manifest cannot change a response', async () => {
  const baseline = await served(createAccessReporter(async () => ({ observeRequest: () => undefined })));
  const cases: Record<string, Parameters<typeof createAccessReporter>[0]> = {
    'observer module fails to load': async () => throwing(),
    'observer throws': async () => ({ observeRequest: throwing }),
    'observer rejects': async () => ({ observeRequest: async () => throwing() }),
    'every dependency throws': async () => createObserver({ deps: brokenDeps, report: new AccessReport({ redis: () => null }) }),
    'Valkey unavailable': async () => {
      const report = new AccessReport({ redis: deadRedis });
      return {
        observeRequest: async (s: Parameters<ReturnType<typeof createObserver>['observeRequest']>[0]) => {
          await createObserver({ deps: brokenDeps, report }).observeRequest(s);
          await report.flush().catch(() => undefined);
        },
      };
    },
    'bad manifest': async () => createObserver({
      deps: brokenDeps,
      report: new AccessReport({ redis: () => null }),
      manifest: { routes: null, groups: null } as unknown as RouteAccessManifest,
    }),
  };
  for (const [name, load] of Object.entries(cases)) {
    assert.deepEqual(await served(createAccessReporter(load)), baseline, name);
  }
});

test('fail-open: the real observer records an error instead of throwing on a bad manifest', async () => {
  const report = new AccessReport({ redis: () => null });
  const observer = createObserver({
    deps: brokenDeps, report, manifest: { routes: null, groups: null } as unknown as RouteAccessManifest,
  });
  const request = new Request('http://localhost/api/apps');
  const snapshot = captureAccess({ request, url: new URL(request.url), routePattern: '/api/apps', params: {} })!;
  snapshot.status = 200;
  await assert.doesNotReject(observer.observeRequest(snapshot));
  assert.ok(report.pending().meta['errors']! >= 1);
});

test('a Valkey blip on an admin session is a service error, never a 401', async () => {
  const deps = {
    ...authDeps(),
    admin: { verifySession: async () => { throw new Error('valkey down'); } },
  } as AuthDeps;
  const request = new Request('http://localhost/api/admin/x', { headers: { authorization: 'Bearer aura-admin1.a.b' } });
  await assert.rejects(authenticate(request, deps), /valkey down/);
  const who = await authWhoami(get({ authorization: 'Bearer aura-admin1.a.b' }), {
    env: {}, services: () => null, authenticate: (r) => authenticate(r, deps),
  });
  assert.equal(who.status, 503);
});

test('fail-open: a Valkey failure in peek is counted and never reaches a response', async () => {
  const report = new AccessReport({ redis: () => null });
  const deps: ObserverDeps = {
    ...brokenDeps,
    mgr: () => null,
    redisReady: () => true,
    internalSecret: () => null,
    services: () => ({
      admin: { peekSession: async () => { throw new Error('valkey down'); } },
      apiKeys: { peek: async () => { throw new Error('valkey down'); } },
    }),
  };
  const observer = createObserver({ report, deps });
  for (const authorization of ['Bearer aura-admin1.a.b', `Bearer aura_k1_${'0'.repeat(16)}_${'a'.repeat(43)}`]) {
    const request = new Request('http://localhost/api/apps', { headers: { authorization } });
    const snapshot = captureAccess({ request, url: new URL(request.url), routePattern: '/api/apps', params: {} })!;
    snapshot.identity.verified = identifyRequest(request, deps);
    snapshot.status = 200;
    await assert.doesNotReject(observer.observeRequest(snapshot));
  }
  assert.equal(report.pending().meta['errors'], 2);
});

test('an instance in an API response carries no owner', () => {
  const inst = { instanceId: 'a-1', appId: 'a', owner: 'default', state: 'resumed' } as unknown as Parameters<typeof publicInstance>[0];
  const shown = publicInstance(inst);
  assert.equal('owner' in shown, false);
  assert.equal(shown.instanceId, 'a-1');
  assert.equal(inst.owner, 'default', 'the record itself is unchanged');
  for (const file of ['../src/pages/api/apps/index.ts', '../src/pages/api/apps/[id]/instances.ts', '../src/lib/appResponse.ts']) {
    assert.ok(readFileSync(new URL(file, import.meta.url), 'utf-8').includes('publicInstance('), file);
  }
});

test('the surface reads no credential file content into a response', () => {
  assert.ok(!readFileSync(new URL('../src/lib/authSurface.ts', import.meta.url), 'utf-8').includes('readFileSync'));
});
