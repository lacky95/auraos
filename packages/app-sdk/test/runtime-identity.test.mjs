// One browser path and one server path: interface URLs and identity for each,
// and the runtime bootstrap as the page's only source of identity and theme.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { OsClient } from '../dist/OsClient.js';
import { AURA_CHANNEL_VERSION } from '../dist/auraChannel.js';

const APP = 'http://notesabcd1234--desk.example:3000';
const SHELL = 'http://desk.example:3000';
const bootstrap = {
  channelVersion: AURA_CHANNEL_VERSION, appId: 'com.acme.notes', instanceId: 'com.acme.notes-2',
  activityId: 'com.acme.notes-2#a1', label: 'notesabcd1234', slot: 1, shellOrigin: SHELL, appOrigin: APP,
  gatewayBase: '/_aura/os/',
  theme: {
    themeId: 'night', themeIdDark: 'night', themeIdLight: 'day', colorMode: 'dark', resolvedMode: 'dark',
    strategy: 'themed', framework: { id: 'scificn', version: '2' },
  },
  keymap: { claims: [], bindings: { 'app.com.acme.notes.save': 'Ctrl+KeyS' } },
  consoleRelay: true,
};
const MCP = { id: 'com.acme.api/mcp', appId: 'com.acme.api', name: 'mcp', kind: 'http/mcp', version: '1',
  address: '/mcp', source: 'manifest', status: 'live', url: '/api/proxy/com.acme.api/mcp' };

const KEYS = ['OS_API_BASE', 'AURA_INSTANCE_TOKEN', 'APP_ID', 'APP_INSTANCE_ID', 'APP_ACTIVITY_ID'];
let saved;
let realFetch;
let calls;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  realFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers ?? {}) } });
    return new Response(JSON.stringify({ interfaces: [], interface: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.window;
  delete globalThis.document;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function page(b, metas = {}) {
  globalThis.window = {
    location: { origin: APP }, top: {}, addEventListener() {}, removeEventListener() {},
    ...(b ? { AuraRuntimeBootstrap: b } : {}),
  };
  // The tags the proxy used to write: nothing may read them any more.
  globalThis.document = {
    querySelector: (sel) => {
      const name = /meta\[name="([^"]+)"\]/.exec(sel)?.[1];
      return name && name in metas ? { getAttribute: () => metas[name] } : null;
    },
  };
}

test('urlFor: a page on an App Host gets the gateway, the server gets OS_API_BASE', () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  page(bootstrap);
  assert.equal(new OsClient().interfaces.urlFor(MCP), '/_aura/os/api/proxy/com.acme.api/mcp');

  delete globalThis.window;
  delete globalThis.document;
  assert.equal(new OsClient().interfaces.urlFor(MCP), 'http://aura-shell:3000/api/proxy/com.acme.api/mcp');
});

test('urlFor: a custom entry is its own address, and nothing live has no URL', () => {
  const os = new OsClient();
  const custom = { ...MCP, appId: 'custom', source: 'custom', status: 'external', url: 'https://api.example.com/mcp' };
  assert.equal(os.interfaces.urlFor(custom), 'https://api.example.com/mcp');
  assert.equal(os.interfaces.urlFor({ ...MCP, status: 'catalog', url: undefined }), null);
});

test('interfaces: the server proves itself with its instance token, never self-set ids', async () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  process.env.AURA_INSTANCE_TOKEN = 'aura1.tok';
  process.env.APP_ID = 'com.acme.notes';
  process.env.APP_INSTANCE_ID = 'com.acme.notes-2';
  const os = new OsClient();
  await os.interfaces.register({ name: 'mcp', kind: 'http/mcp', address: '/mcp' });
  await os.interfaces.unregister('mcp');
  await os.interfaces.list();
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.match(c.url, /^http:\/\/aura-shell:3000\/api\/interfaces/);
    assert.equal(c.headers.Authorization, 'Bearer aura1.tok');
    assert.equal(c.headers['X-Aura-App-Id'], undefined);
    assert.equal(c.headers['X-Aura-Instance-Id'], undefined);
  }
});

test('interfaces: a page sends no credential and no id, through the gateway', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'aura1.tok';
  page(bootstrap);
  await new OsClient().interfaces.register({ name: 'mcp', kind: 'http/mcp', address: '/mcp' });
  assert.equal(calls[0].url, '/_aura/os/api/interfaces');
  assert.deepEqual(Object.keys(calls[0].headers).sort(), ['Content-Type']);
});

test('activity, theme and keymap come from the bootstrap', async () => {
  page(bootstrap);
  const os = new OsClient();
  assert.equal(os.activity.getActivityId(), 'com.acme.notes-2#a1');
  assert.equal(os.getActiveThemeId(), 'night');
  assert.equal(os.getThemeStrategy(), 'themed');
  assert.deepEqual(await os.getDesignFramework(), { id: 'scificn', name: 'scificn', source: 'https://www.scificn.dev', version: '2' });
  assert.equal(os.keymap.getBinding('save'), 'Ctrl+KeyS');
  assert.deepEqual(calls, [], 'no fetch for what the bootstrap holds');
});

test('meta tags are not a source: without the bootstrap a page has no identity or theme', () => {
  page(null, {
    'aura-activity-id': 'com.acme.notes-2#forged', 'aura-theme-id': 'forged',
    'aura-theme-strategy': 'override', 'aura-keymap-bindings': '{"app.unknown.save":"Ctrl+KeyX"}',
    'aura-app-id': 'com.acme.notes',
  });
  const os = new OsClient();
  assert.equal(os.activity.getActivityId(), null);
  assert.equal(os.getActiveThemeId(), null);
  assert.equal(os.getThemeStrategy(), 'inherit');
  assert.equal(os.keymap.getBinding('save'), null);
});

test('the server reads its activity from APP_ACTIVITY_ID', () => {
  process.env.APP_ACTIVITY_ID = 'com.acme.notes-2#a9';
  assert.equal(new OsClient().activity.getActivityId(), 'com.acme.notes-2#a9');
});
