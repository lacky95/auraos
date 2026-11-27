// D94 IC-1 routes (lib/infraAdmin.ts): reads at session, every change at fresh bound to the exact
// config digest, an invalid config refused before any approval, audits with digests and names
// only, the access manifest keeps them owner routes (apps never), the doctor is a read (GET).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as core from '@aura/core';
import { deleteCredential, getInfra, postValidate, putCredential, putInfra, INFRA_AUDIT, type InfraAdminDeps } from '../src/lib/infraAdmin.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';

type Req = { action: string; level?: string; payload?: Record<string, unknown> };
function harness(over: Partial<InfraAdminDeps> = {}) {
  const asked: Req[] = [];
  const audits: Array<{ action: string; opts: { target?: string; detail?: Record<string, unknown> } }> = [];
  const validation: core.InfraValidation = { ok: true, configDigest: 'sha256:' + 'c'.repeat(64), warnings: [], diff: ['+ x'], changed: true };
  const deps: InfraAdminDeps = {
    ownerAction: async (_ctx, req) => { asked.push(req as Req); return { by: { kind: 'operator' }, detail: {} } as never; },
    audit: async (_a, action, opts) => { audits.push({ action, opts: opts as never }); },
    show: async () => ({ configured: false, text: null, configDigest: null, renderDigest: null, warnings: [], credentials: [] }),
    validate: async () => validation,
    apply: async () => ({ changed: true, configDigest: validation.configDigest, renderDigest: 'sha256:' + 'r'.repeat(64), restartRequired: false, issues: [], diff: ['+ x'] }),
    setCredential: async () => ({ key: 'INFRA_PROXY', hosts: ['proxy.corp.example'] }),
    removeCredential: async () => true,
    ...over,
  };
  return { deps, asked, audits };
}
const ctx = (body?: unknown, method = 'PUT') => ({ request: new Request('http://shell.test/api/admin/infra', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }) as never;

test('GET and validate are owner reads at session; apply is fresh and bound to the config digest, audited without values', async () => {
  const h = harness();
  assert.equal((await getInfra(ctx(undefined, 'GET'), h.deps)).status, 200);
  assert.equal((await postValidate(ctx({ config: 'version: 1\n' }, 'POST'), h.deps)).status, 200);
  assert.deepEqual(h.asked.map((r) => [r.action, r.level]), [['admin.read', 'session'], ['admin.read', 'session']]);
  const res = await putInfra(ctx({ config: 'version: 1\n' }), h.deps);
  assert.equal(res.status, 200);
  assert.deepEqual([h.asked[2]!.action, h.asked[2]!.level, h.asked[2]!.payload], ['admin.change', 'fresh', { op: 'infra.apply', configDigest: 'sha256:' + 'c'.repeat(64) }]);
  assert.equal(h.audits[0]!.action, INFRA_AUDIT.applied);
  assert.doesNotMatch(JSON.stringify(h.audits), /version: 1/);
});

test('an invalid config is refused before any approval; a config changed between check and apply is a conflict', async () => {
  const bad = Object.assign(new Error('the infrastructure config is invalid'), { code: 'invalid-config', errors: [{ path: 'network.proxy.https', message: 'no user:password in URLs' }] });
  const h = harness({ validate: async () => { throw bad; } });
  const res = await putInfra(ctx({ config: 'x' }), h.deps);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors[0].path, 'network.proxy.https');
  assert.equal(h.asked.length, 0, 'no approval asked for a config that is refused anyway');
  const h2 = harness({ apply: async () => ({ changed: true, configDigest: 'sha256:other', renderDigest: null, restartRequired: false, issues: [], diff: [] }) });
  assert.equal((await putInfra(ctx({ config: 'version: 1\n' }), h2.deps)).status, 409);
});

test('credentials: set and remove at fresh; the audit names the credential, never its value', async () => {
  const h = harness();
  const res = await putCredential(ctx({ kind: 'basic', user: 'svc', password: 'Pr0xy-CANARY-pass' }), 'proxy', h.deps);
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /CANARY/);
  assert.equal(h.asked[0]!.level, 'fresh');
  assert.doesNotMatch(JSON.stringify([h.asked, h.audits]), /CANARY/);
  assert.equal((await deleteCredential(ctx(undefined, 'DELETE'), 'proxy', h.deps)).status, 200);
  assert.equal(h.audits[1]!.action, INFRA_AUDIT.credentialRemoved);
});

test('access manifest: every infra route is an owner route; the doctor is a GET', () => {
  const r = ROUTE_ACCESS_MANIFEST.routes;
  for (const [path, methods] of [['/api/admin/infra', ['GET', 'PUT']], ['/api/admin/infra/validate', ['POST']], ['/api/admin/infra/credentials/[name]', ['PUT', 'DELETE']], ['/api/admin/infra/doctor', ['GET']]] as const) {
    for (const m of methods) assert.deepEqual((r[path]?.methods as Record<string, { allow: string[] }>)?.[m]?.allow, ['own-instance', 'owner'], `${m} ${path}`);
  }
  assert.equal((r['/api/admin/infra/doctor']?.methods as Record<string, unknown>)['POST'], undefined);
});
