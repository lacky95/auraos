// The Browser app's engine frame shows any website. It must stay a sandbox:
// scripts without this frame's origin, popups that stay sandboxed, and no
// Referer that would tell visited sites the App Host's URL (Phase 3 must close).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../../apps/com.aura.browser/src/pages/index.astro', import.meta.url), 'utf8');
const engine = page.slice(page.indexOf('<iframe\n        id="engine"'), page.indexOf('></iframe>', page.indexOf('id="engine"')));

test('the Browser engine frame never pairs scripts with its own origin, and leaks no Referer', () => {
  assert.ok(engine.includes('id="engine"'), 'the engine iframe is found');
  const sandbox = /sandbox="([^"]*)"/.exec(engine)?.[1]?.split(/\s+/) ?? null;
  assert.ok(sandbox, 'the engine is sandboxed');
  assert.ok(sandbox.includes('allow-scripts'), 'pages still run scripts');
  assert.ok(!sandbox.includes('allow-same-origin'), 'no allow-same-origin next to allow-scripts');
  assert.ok(!sandbox.includes('allow-popups-to-escape-sandbox'), 'popups stay sandboxed');
  assert.ok(!sandbox.includes('allow-top-navigation'), 'a page never navigates the desktop');
  const referrer = /referrerpolicy="([^"]*)"/.exec(engine)?.[1];
  assert.ok(referrer === 'no-referrer' || referrer === 'strict-origin', `referrer policy is strict (got ${referrer})`);
});
