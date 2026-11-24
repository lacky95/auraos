// Docs URL building on both frame routes (Phase 2): the base path, the search
// endpoint, which build a request reaches, and the runtime loader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  FRAME_ROUTE_HEADER, docsBasePath, docsInstanceId, docsSearchApi, frameRouteOf, requestRoute,
} from '../fumadocs-site/lib/base-path.mjs';
import { APP_HOST_ROUTE_HEADER, AURA_RESERVED_PATHS } from '../../../packages/app-sdk/dist/hostRules.js';
import { AURA_RUNTIME_LOADER_JS } from '../../../packages/app-sdk/dist/runtime/loader.js';

test('the route header is the one the App Host router sets', () => {
  assert.equal(FRAME_ROUTE_HEADER, APP_HOST_ROUTE_HEADER);
});

test('proxy route: basePath and search carry the instance prefix', () => {
  const base = docsBasePath('proxy', 'com.aura.docs');
  assert.equal(base, '/api/proxy/com.aura.docs');
  assert.equal(docsSearchApi(base), '/api/proxy/com.aura.docs/api/search');
  assert.equal(docsBasePath('proxy', 'com.aura.docs-2'), '/api/proxy/com.aura.docs-2');
});

test('App Host route: served from /', () => {
  const base = docsBasePath('host', 'com.aura.docs');
  assert.equal(base, '');
  assert.equal(docsSearchApi(base), '/api/search');
});

test('anything but `host` is the proxy route', () => {
  for (const v of [undefined, null, '', 'HOST', 'proxy', 'host ', ['proxy']]) assert.equal(frameRouteOf(v), 'proxy');
  assert.equal(frameRouteOf('host'), 'host');
});

test('a request picks its build by the router header only', () => {
  assert.equal(requestRoute({ [FRAME_ROUTE_HEADER]: 'host' }), 'host');
  assert.equal(requestRoute({ [FRAME_ROUTE_HEADER]: ['host', 'proxy'] }), 'host');
  assert.equal(requestRoute({}), 'proxy');
  assert.equal(requestRoute(undefined), 'proxy');
  // The agents' MCP and the lifecycle calls arrive through the shell proxy,
  // which never carries the header: they reach the prefixed build.
  assert.equal(requestRoute({ host: 'aura-com.aura.docs:4101' }), 'proxy');
});

test('instance id: APP_INSTANCE_ID, then APP_ID, then the app id', () => {
  assert.equal(docsInstanceId({ APP_INSTANCE_ID: 'com.aura.docs-3', APP_ID: 'x' }), 'com.aura.docs-3');
  assert.equal(docsInstanceId({ APP_ID: 'com.aura.docs' }), 'com.aura.docs');
  assert.equal(docsInstanceId({}), 'com.aura.docs');
});

/** Runs the loader as app/layout.tsx emits it, and returns what it wrote. */
function runLoader(hostname, pathname) {
  const written = [];
  const document = { readyState: 'loading', write: (s) => written.push(s), head: { appendChild() {} } };
  vm.runInNewContext(AURA_RUNTIME_LOADER_JS, { window: {}, location: { hostname, pathname }, document });
  return written.join('');
}

test('runtime loader: nothing on the proxy route', () => {
  assert.equal(runLoader('192.168.1.5.nip.io', '/api/proxy/com.aura.docs/docs/introduction'), '');
  assert.equal(runLoader('os.aura.localhost', '/api/proxy/com.aura.docs/'), '');
});

test('runtime loader: loads /_aura/runtime.js on an App Host', () => {
  const out = runLoader('docs5f9f7565--os.aura.localhost', '/docs/introduction');
  assert.match(out, new RegExp(`src="${AURA_RESERVED_PATHS.runtime.replace(/[.]/g, '\\.')}"`));
});
