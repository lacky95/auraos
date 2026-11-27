// D108 P4: GET /api/setup/self, the app's own setup values by its instance
// token (SDK osClient.setup.config()). The caller comes from the verified
// principal only; the access manifest admits nothing but an instance token;
// 503 `unavailable` until the engine is wired; a D105 refusal keeps its body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessPrincipal, InstancePrincipal, SetupConfigView } from '@aura/core';
import { readSetupSelf, liveSetupSelfDeps, SETUP_SELF_UNAVAILABLE, type SetupSelfDeps } from '../src/lib/setupSelf.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { createDecide } from '../src/lib/access/decide.ts';
import type { AccessLabel, AccessVia, DecideInput } from '../src/lib/access/types.ts';
import type { ResolvedPrincipal } from '../src/lib/access/identify.ts';

const APP = 'com.example.mailer';
const inst = (appId = APP, extra: Partial<InstancePrincipal> = {}): InstancePrincipal =>
  ({ kind: 'instance', appId, instanceId: `${appId}-1`, verification: 'verified', userId: 'default', ...extra }) as InstancePrincipal;
const owner: AccessPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's', verification: 'verified' } as AccessPrincipal;

const view = (appId: string): SetupConfigView => ({
  appId, installationId: 'i-1', profile: null, values: { host: 'mail.example' }, secrets: { password: 'cred_' + 'A'.repeat(22) },
  degraded: [], configDigest: 'sha256:c',
});

function deps(principal: AccessPrincipal, via: AccessVia, engine: SetupSelfDeps['service'] = () => null, asked: unknown[] = []): SetupSelfDeps {
  return {
    resolve: async () => ({ principal, via } as unknown as ResolvedPrincipal),
    service: () => {
      const s = engine();
      return s ? { selfConfig: async (q) => { asked.push(q); return s.selfConfig(q); } } : null;
    },
  };
}
const call = async (d: SetupSelfDeps) => {
  const res = await readSetupSelf(new Request('http://os/api/setup/self'), d);
  return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control') };
};
const engine = (answer: (q: { appId: string }) => SetupConfigView | Promise<SetupConfigView>) => () => ({ selfConfig: async (q: { appId: string }) => answer(q) });

test('503 unavailable (D105 shape) while no engine is wired; the live deps have none yet', async () => {
  const r = await call(deps(inst(), 'instance-token'));
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { ...SETUP_SELF_UNAVAILABLE });
  assert.equal(liveSetupSelfDeps().service(), null);
});

test('the engine is asked for the verified caller\'s own app, instance and user only', async () => {
  const asked: unknown[] = [];
  const r = await call(deps(inst(), 'instance-token', engine((q) => view(q.appId)), asked));
  assert.equal(r.status, 200);
  assert.equal(r.cache, 'no-store');
  assert.deepEqual(r.body, view(APP));
  assert.deepEqual(asked, [{ appId: APP, instanceId: `${APP}-1`, userId: 'default' }]);
});

test('never a page, a session, an API key, a sidecar or a rejected token; an answer for another app is withheld', async () => {
  const e = engine((q) => view(q.appId));
  assert.equal((await call(deps(owner, 'login-session', e))).status, 403);
  assert.equal((await call(deps(inst(), 'login-session' as AccessVia, e))).status, 403);
  assert.equal((await call(deps({ kind: 'anonymous', verification: 'unverified' } as AccessPrincipal, 'none', e))).status, 401);
  assert.equal((await call(deps(inst(APP, { sidecar: 'worker' }), 'instance-token', e))).status, 403);
  assert.equal((await call({ ...deps(inst(), 'instance-token', e), resolve: async () => ({ principal: { kind: 'anonymous', verification: 'unverified' }, via: 'none', rejected: { reason: 'invalid' } } as unknown as ResolvedPrincipal) })).status, 401);
  const leak = await call(deps(inst(), 'instance-token', engine(() => view('com.other.app'))));
  assert.equal(leak.status, 500);
  assert.ok(!JSON.stringify(leak.body).includes('mail.example'));
});

test('a setup refusal keeps its D105 body; any other failure says nothing', async () => {
  const refuse = engine(() => { throw Object.assign(new Error('x'), { code: 'setup-required', body: { error: 'setup-required', category: 'needs-setup', message: 'complete the setup first', state: 'setup-required' } }); });
  const r = await call(deps(inst(), 'instance-token', refuse));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'setup-required');
  const boom = await call(deps(inst(), 'instance-token', engine(() => { throw new Error('kv down at 10.0.0.3'); })));
  assert.equal(boom.status, 500);
  assert.ok(!JSON.stringify(boom.body).includes('10.0.0.3'));
});

test('access manifest: only the app instance itself, by its instance token', async () => {
  const rule = ROUTE_ACCESS_MANIFEST.routes['/api/setup/self']?.methods?.GET;
  assert.ok(rule);
  assert.deepEqual(rule.allow, ['own-instance']);
  assert.deepEqual(rule.credentials, ['instance-token']);
  const decide = createDecide({ authorizer: { authorize: async () => ({ allow: true, reason: 'test' }) } } as never);
  const input = (principal: AccessPrincipal, via: AccessVia): DecideInput => ({
    principal, action: { surface: 'api', subject: '/api/setup/self' as AccessLabel, method: 'GET', variant: null, rule },
    resource: { target: 'system' }, transport: 'http', auth: { fresh: false, via }, strict: true,
    accessProfile: 'open', systemMode: 'normal', deployment: 'private',
  });
  assert.equal((await decide(input(inst(), 'instance-token'))).outcome, 'allow');
  assert.equal((await decide(input(owner, 'login-session'))).outcome, 'deny', 'the owner\'s session is not an app');
  assert.equal((await decide(input({ kind: 'anonymous', verification: 'unverified' } as AccessPrincipal, 'none'))).outcome, 'deny');
});
