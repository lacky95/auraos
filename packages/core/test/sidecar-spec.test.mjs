// sidecar-spec: what an app may ask the OS to start. Pins the containment
// rules of OS-managed sidecars — templates only, a fixed override whitelist,
// privilege gated even when the template declares it, volumes in the app's
// own area (with the SDK's legacy-volume precedence), and a spec hash that is
// stable across key order.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpawnRequest, resolveSidecarSpec, specHash, SpecError } from '../dist/app-manager/sidecar-spec.js';

const services = [
  { name: 'box', image: 'alpine:3', command: ['sleep', 'infinity'], env: { A: '1' }, envInherit: ['K1'],
    volumes: [{ name: 'data', target: '/data' }, { name: 'cache', target: '/cache', shared: true }],
    inheritIdentity: true, inheritMounts: true, port: 8080 },
  { name: 'priv', image: 'x:1', privileged: true, command: [], env: {}, volumes: [] },
  { name: 'pub', image: 'x:1', publish: [{ host: 8080, container: 80 }], command: [], env: {}, volumes: [] },
  { name: 'sock', image: 'x:1', inheritDockerSocket: true, command: [], env: {}, volumes: [] },
  { name: 'escape', image: 'x:1', command: [], env: {}, volumes: [{ name: 'v', target: '/v', subpath: 'aura/secrets' }] },
];

const ctx = (over = {}) => ({
  appId: 'io.test.app',
  instanceId: 'io.test.app-2',
  manifest: { services, tools: [] },
  can: () => false,
  appDataSubpath: 'scopes/users/default/apps/io.test.app',
  appDataVolume: 'aura_aura-app-data',
  legacyVolumeExists: () => false,
  hasDockerTool: false,
  ...over,
});

const rejects = (fn, status, re) => assert.throws(fn, (e) => e instanceof SpecError && e.status === status && re.test(e.message));

test('template resolves with defaults; request env wins, envInherit merges', () => {
  const s = resolveSidecarSpec({ template: 'box', env: { A: '2', B: '3' }, envInherit: ['K2', 'K1'] }, ctx());
  assert.equal(s.name, 'box');
  assert.equal(s.image, 'alpine:3');
  assert.deepEqual(s.command, ['sleep', 'infinity']);
  assert.deepEqual(s.env, { A: '2', B: '3' });
  assert.deepEqual(s.envInherit, ['K1', 'K2']);
  assert.equal(s.restart, 'unless-stopped');
  assert.equal(s.port, 8080);
  assert.equal(s.inheritIdentity, true);
  assert.deepEqual(s.mounts, { own: false, inherit: true, exclude: [], forceRo: false }, 'inherit defaults to the template');
});

test('unknown template → 404 listing the templates', () => {
  rejects(() => resolveSidecarSpec({ template: 'nope' }, ctx()), 404, /templates: box, priv/);
});

test('names: default, suffix, explicit; invalid and conflicting', () => {
  assert.equal(resolveSidecarSpec({ template: 'box', suffix: 'a1' }, ctx()).name, 'box-a1');
  assert.equal(resolveSidecarSpec({ template: 'box', name: 'job-7' }, ctx()).name, 'job-7');
  rejects(() => resolveSidecarSpec({ template: 'box', name: 'Bad_Name' }, ctx()), 400, /must match/);
  rejects(() => resolveSidecarSpec({ template: 'box', name: 'x'.repeat(49) }, ctx()), 400, /must match/);
  rejects(() => resolveSidecarSpec({ template: 'box', name: 'a', suffix: 'b' }, ctx()), 400, /either name or suffix/);
});

test('override whitelist: anything but name/suffix/env/envInherit/command/mounts/image/… is refused', () => {
  for (const key of ['volumes', 'privileged', 'capabilities', 'devices', 'publish', 'inheritDockerSocket', 'user', 'restart']) {
    rejects(() => parseSpawnRequest({ template: 'box', [key]: true }), 400, new RegExp(`'${key}' cannot be set per request`));
  }
  rejects(() => parseSpawnRequest({}), 400, /template is required/);
  rejects(() => parseSpawnRequest({ template: 'box', env: { A: 1 } }), 400, /env must be an object of strings/);
  rejects(() => parseSpawnRequest({ template: 'box', mounts: { inherit: { mode: 'rw' } } }), 400, /can only be 'ro'/);
  assert.deepEqual(parseSpawnRequest({ template: 'box', suffix: 'x', mounts: { own: true } }), { template: 'box', suffix: 'x', mounts: { own: true } });
});

test('a free image needs sidecars.anyImage (the template image itself is always fine)', () => {
  rejects(() => resolveSidecarSpec({ template: 'box', image: 'evil:latest' }, ctx()), 403, /sidecars\.anyImage/);
  assert.equal(resolveSidecarSpec({ template: 'box', image: 'alpine:3' }, ctx()).image, 'alpine:3');
  const can = (p) => p === 'sidecars.anyImage';
  assert.equal(resolveSidecarSpec({ template: 'box', image: 'other:1' }, ctx({ can })).image, 'other:1');
});

test('privileged / publish need sidecars.privileged even when the template declares them', () => {
  rejects(() => resolveSidecarSpec({ template: 'priv' }, ctx()), 403, /sidecars\.privileged/);
  rejects(() => resolveSidecarSpec({ template: 'pub' }, ctx()), 403, /sidecars\.privileged/);
  const can = (p) => p === 'sidecars.privileged';
  assert.equal(resolveSidecarSpec({ template: 'priv' }, ctx({ can })).privileged, true);
  assert.deepEqual(resolveSidecarSpec({ template: 'pub' }, ctx({ can })).publish, [{ host: 8080, container: 80 }]);
});

test('the docker socket only if the app itself holds the docker tool', () => {
  rejects(() => resolveSidecarSpec({ template: 'sock' }, ctx()), 403, /does not grant docker/);
  assert.equal(resolveSidecarSpec({ template: 'sock' }, ctx({ hasDockerTool: true })).inheritDockerSocket, true);
});

test('volumes: per sidecar by default, per template when shared, legacy per-app volume wins; overrides refused', () => {
  const base = 'scopes/users/default/apps/io.test.app/.sidecars';
  const a = resolveSidecarSpec({ template: 'box', suffix: 'a1' }, ctx());
  assert.deepEqual(a.volumes, [
    { name: 'data', target: '/data', source: 'aura_aura-app-data', subpath: `${base}/box-a1/data` },
    { name: 'cache', target: '/cache', source: 'aura_aura-app-data', subpath: `${base}/box/cache` },
  ]);
  const legacy = resolveSidecarSpec({ template: 'box' }, ctx({ legacyVolumeExists: (n) => n === 'aura-io.test.app-data' }));
  assert.deepEqual(legacy.volumes[0], { name: 'data', target: '/data', source: 'aura-io.test.app-data' });
  const notForSuffixed = resolveSidecarSpec({ template: 'box', suffix: 'z' }, ctx({ legacyVolumeExists: () => true }));
  assert.ok(notForSuffixed.volumes[0].subpath, 'only the template-named sidecar takes over the legacy volume');
  rejects(() => resolveSidecarSpec({ template: 'escape' }, ctx()), 400, /only the SDK docker path/);
});

test('mounts: own, inherit off, exclude + read-only cap', () => {
  assert.deepEqual(resolveSidecarSpec({ template: 'box', mounts: { own: true, inherit: false } }, ctx()).mounts,
    { own: true, inherit: false, exclude: [], forceRo: false });
  assert.deepEqual(resolveSidecarSpec({ template: 'box', mounts: { inherit: { exclude: ['b.b', 'a.a'], mode: 'ro' } } }, ctx()).mounts,
    { own: false, inherit: true, exclude: ['a.a', 'b.b'], forceRo: true });
  assert.equal(resolveSidecarSpec({ template: 'priv', mounts: {} }, ctx({ can: () => true })).mounts.inherit, false);
});

test('specHash: stable across key order, changes with the spec', () => {
  const h1 = specHash(resolveSidecarSpec({ template: 'box', env: { X: '1', Y: '2' } }, ctx()));
  const h2 = specHash(resolveSidecarSpec({ env: { Y: '2', X: '1' }, template: 'box' }, ctx()));
  const h3 = specHash(resolveSidecarSpec({ template: 'box', env: { X: '1', Y: '3' } }, ctx()));
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{16}$/);
});

test('readiness passes through with defaults; wait is validated', () => {
  const svc = [{ name: 'web', image: 'nginx', port: 80, readiness: { path: '/health', timeoutMs: 5000 }, command: [], env: {}, volumes: [] },
    { name: 'raw', image: 'nginx', port: 80, command: [], env: {}, volumes: [] }];
  const c = ctx({ manifest: { services: svc, tools: [] } });
  assert.deepEqual(resolveSidecarSpec({ template: 'web' }, c).readiness, { path: '/health', timeoutMs: 5000 });
  assert.equal(resolveSidecarSpec({ template: 'raw' }, c).readiness, undefined);
  assert.deepEqual(parseSpawnRequest({ template: 'web', wait: { ready: true, timeoutMs: 100 } }).wait, { ready: true, timeoutMs: 100 });
  rejects(() => parseSpawnRequest({ template: 'web', wait: { ready: 'yes' } }), 400, /wait\.ready must be a boolean/);
  rejects(() => parseSpawnRequest({ template: 'web', wait: { timeoutMs: -1 } }), 400, /positive number/);
});
