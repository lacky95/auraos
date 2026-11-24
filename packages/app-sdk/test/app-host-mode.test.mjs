// How the SDK picks its transport: the gateway and exact-origin AuraChannel on
// an App Host. Without the runtime bootstrap there is no shell to reach.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { appHostRuntime, bodylessMutationHeaders, osBase } from '../dist/os-auth.js';
import { isFromShell, postToShell } from '../dist/channel.js';
import { AURA_CHANNEL_VERSION, isAuraChannelRouteAllowed } from '../dist/auraChannel.js';

const APP = 'http://notesabcd1234--desk.example:3000';
const SHELL = 'http://desk.example:3000';
const bootstrap = (over = {}) => ({
  channelVersion: AURA_CHANNEL_VERSION, appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', activityId: null,
  label: 'notesabcd1234', slot: 1, shellOrigin: SHELL, appOrigin: APP, gatewayBase: '/_aura/os/', ...over,
});

function browser(b) {
  const posts = { top: [], parent: [] };
  const top = { postMessage: (m, o) => posts.top.push([m, o]) };
  const parent = { postMessage: (m, o) => posts.parent.push([m, o]) };
  globalThis.window = {
    location: { origin: APP }, addEventListener() {}, removeEventListener() {}, top, parent,
    ...(b ? { AuraRuntimeBootstrap: b } : {}),
  };
  return { posts, top, parent };
}
afterEach(() => { delete globalThis.window; });

test('with a valid bootstrap the SDK uses the same-origin gateway', () => {
  browser(bootstrap());
  assert.equal(appHostRuntime()?.appId, 'com.acme.notes');
  assert.equal(osBase(), '/_aura/os');
  assert.equal(osBase({ mode: 'origin' }), `${APP}/_aura/os`);
  assert.deepEqual(bodylessMutationHeaders(), { 'Content-Type': 'application/json' });
});

test('without one, or with one for another origin or version, it is not on an App Host', () => {
  for (const b of [null, bootstrap({ appOrigin: 'http://evil.example' }), bootstrap({ channelVersion: 99 }), bootstrap({ gatewayBase: '//evil.example/' }), bootstrap({ shellOrigin: '' })]) {
    browser(b);
    assert.equal(appHostRuntime(), null);
    assert.equal(osBase(), '');
    assert.equal(osBase({ mode: 'origin' }), APP);
    assert.deepEqual(bodylessMutationHeaders(), {});
  }
});

test('on an App Host, messages go only to the Shell at its exact origin', () => {
  const { posts } = browser(bootstrap());
  postToShell({ type: 'aura.system.openLauncher' });
  assert.deepEqual(posts.top, [[{ type: 'aura.system.openLauncher' }, SHELL]]);
  assert.deepEqual(posts.parent, []);
});

test('without a bootstrap nothing is posted, and nothing counts as from the Shell', () => {
  const { posts, top, parent } = browser(null);
  postToShell({ type: 'aura.system.openLauncher' });
  assert.deepEqual(posts, { top: [], parent: [] });
  assert.equal(isFromShell({ origin: SHELL, source: top }), false);
  assert.equal(isFromShell({ origin: SHELL, source: parent }), false);
});

test('a message counts as from the Shell only with its exact origin and window', () => {
  const { top, parent } = browser(bootstrap());
  assert.equal(isFromShell({ origin: SHELL, source: top }), true);
  assert.equal(isFromShell({ origin: SHELL, source: parent }), false);
  assert.equal(isFromShell({ origin: 'http://evil.example', source: top }), false);
  // A native-host message: `source: 'host'` is a field any frame can set.
  assert.equal(isFromShell({ origin: APP, source: parent, data: { type: 'aura.host.needsTopLevel', source: 'host' } }), false);
});

test('the channel gives no embedding parent a key route', () => {
  assert.equal(isAuraChannelRouteAllowed('aura.key.synthetic', 'embed-host', 'embedded-app'), false);
  assert.equal(isAuraChannelRouteAllowed('aura.key.synthetic', 'shell', 'app-subframe'), true);
  assert.equal(isAuraChannelRouteAllowed('aura.keyboard.field', 'app-subframe', 'shell'), true);
});
