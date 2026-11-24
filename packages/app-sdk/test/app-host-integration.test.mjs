// What a page gets: the runtime loader, the theme route, and shell URLs. A page
// that is not on an App Host requests nothing.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AURA_RUNTIME_LOADER_JS, appHostAssetLocation } from '../dist/runtime/loader.js';
import { GET as assetRoute } from '../dist/runtime/shell-asset-route.js';
import { APP_HOST_ROUTE_HEADER } from '../dist/hostRules.js';
import { osUrl } from '../dist/os-auth.js';
import { AURA_CHANNEL_VERSION } from '../dist/auraChannel.js';

function runLoader({ hostname, readyState = 'loading', booted = false }) {
  const written = [];
  const appended = [];
  const sandbox = {
    location: { hostname },
    document: {
      readyState,
      write: (html) => written.push(html),
      createElement: () => ({}),
      head: { appendChild: (el) => appended.push(el.src) },
    },
  };
  sandbox.window = sandbox;
  if (booted) sandbox.AuraRuntimeBootstrap = {};
  vm.runInContext(AURA_RUNTIME_LOADER_JS, vm.createContext(sandbox));
  return { written, appended };
}

test('on an App Host the loader blocks the parser on the runtime', () => {
  const { written, appended } = runLoader({ hostname: 'notesabcd1234--desk.example' });
  assert.deepEqual(written, ['<script src="/_aura/runtime.js"><\/script>']);
  assert.deepEqual(appended, []);
});

test('after parsing it appends, because document.write would erase the page', () => {
  const { written, appended } = runLoader({ hostname: 'notesabcd1234--desk.example', readyState: 'complete' });
  assert.deepEqual(written, []);
  assert.deepEqual(appended, ['/_aura/runtime.js']);
});

test('a plain host, punycode, a reserved label and a loaded runtime request nothing', () => {
  for (const page of [
    { hostname: 'desk.example' },
    { hostname: 'localhost' },
    { hostname: 'xn--bcher-kva.example' },
    { hostname: 'aura--desk.example' },
    { hostname: 'notesabcd1234--desk.example', booted: true },
  ]) {
    const { written, appended } = runLoader(page);
    assert.deepEqual([written, appended], [[], []], JSON.stringify(page));
  }
});

test('the loader contains no closing script tag', () => {
  assert.equal(/<\/script/i.test(AURA_RUNTIME_LOADER_JS), false);
});

const assetRequest = (url, route) => new Request(url, { headers: route ? { [APP_HOST_ROUTE_HEADER]: route } : {} });

test('on an App Host the shell assets redirect to the gateway and keep their query', () => {
  for (const [path, want] of [
    ['/api/os/theme.css?t=42', '/_aura/os/api/os/theme.css?t=42'],
    ['/api/os/icons.svg', '/_aura/os/api/os/icons.svg'],
    ['/api/os/icons/chevron-down.svg', '/_aura/os/api/os/icons/chevron-down.svg'],
  ]) {
    const res = assetRoute({ request: assetRequest(`http://app:4001${path}`, 'host') });
    assert.equal(res.status, 307, path);
    assert.equal(res.headers.get('location'), want);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('off an App Host, or for any other path, there is no redirect', () => {
  for (const route of [undefined, 'proxy']) {
    assert.equal(assetRoute({ request: assetRequest('http://app:4001/api/os/theme.css', route) }).status, 404);
  }
  assert.equal(appHostAssetLocation(['host'], '/api/os/theme.css'), null);
  for (const path of ['/api/os/context', '/api/kv/os/theme', '/api/os/icons/a/b.svg', '/api/os/icons/%2e%2e.svg', '//evil.example/api/os/theme.css']) {
    assert.equal(appHostAssetLocation('host', path), null, path);
  }
});

const APP = 'http://notesabcd1234--desk.example:3000';
afterEach(() => { delete globalThis.window; });

test('osUrl is the gateway on an App Host, and the plain path outside AuraOS', () => {
  globalThis.window = { location: { origin: 'http://desk.example:3000' } };
  assert.equal(osUrl('/api/os/icons.svg'), '/api/os/icons.svg');
  globalThis.window = {
    location: { origin: APP },
    AuraRuntimeBootstrap: {
      channelVersion: AURA_CHANNEL_VERSION, appOrigin: APP, shellOrigin: 'http://desk.example:3000', gatewayBase: '/_aura/os/',
    },
  };
  assert.equal(osUrl('/api/os/icons.svg'), '/_aura/os/api/os/icons.svg');
});
