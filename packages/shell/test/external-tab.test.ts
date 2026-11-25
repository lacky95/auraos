/**
 * "Open site in external browser" (Aura Browser): the app asks, the desktop
 * opens the tab with no opener and no referrer, http(s) only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openExternalTab } from '../src/lib/externalTab.ts';
import { isAuraChannelRouteAllowed } from '@aura/core/aura-channel';

test('the desktop opens http(s) addresses only, without opener or referrer', () => {
  const opened: unknown[][] = [];
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  g.window = { open: (...args: unknown[]) => { opened.push(args); return null; } };
  try {
    assert.equal(openExternalTab('https://pay.example/checkout?x=1'), true);
    assert.deepEqual(opened, [['https://pay.example/checkout?x=1', '_blank', 'noopener,noreferrer']]);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'about:blank', '/relative', '', null, 42]) {
      assert.equal(openExternalTab(bad), false, String(bad));
    }
    assert.equal(opened.length, 1);
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
});

test('only an app frame may ask, and the desktop routes it to the one helper', () => {
  assert.equal(isAuraChannelRouteAllowed('aura.system.openExternal', 'app', 'shell'), true);
  for (const from of ['app-subframe', 'embedded-app', 'native-host'] as const) {
    assert.equal(isAuraChannelRouteAllowed('aura.system.openExternal', from, 'shell'), false, from);
  }
  const desk = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(desk, /type === 'aura\.system\.openExternal'\) openExternalTab\(/);
  const card = readFileSync(new URL('../src/components/shell/notifications/NotificationCard.ts', import.meta.url), 'utf8');
  assert.ok(!card.includes('window.open('), 'notification links use the same helper');
});
