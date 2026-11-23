// AuraChannel: the registry's routes, and that it covers every message type
// the shell, SDK and first-party apps actually use.
//
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/aura-channel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AURA_CHANNEL_MESSAGES, isAuraChannelRouteAllowed, isAuraChannelType,
} from '../dist/app-hosts/auraChannel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.astro', '.next', '.source', 'test', 'content']);
const EXT = /\.(ts|tsx|astro|mjs|js)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const sources = () => [
  ...walk(join(ROOT, 'packages/shell/src')),
  ...walk(join(ROOT, 'packages/app-sdk/src')),
  ...readdirSync(join(ROOT, 'apps')).flatMap((a) => {
    const dirs = ['src', 'fumadocs-site/app'].map((d) => join(ROOT, 'apps', a, d));
    return dirs.flatMap((d) => { try { return walk(d); } catch { return []; } });
  }),
].filter((f) => !f.endsWith('/auraChannel.ts'));

const USES = [
  /\btype\s*:\s*['"`](aura\.[\w.-]+)['"`]/g,
  /\.type\s*[!=]==?\s*['"`](aura\.[\w.-]+)['"`]/g,
  /\b[dt]\s*[!=]==?\s*['"`](aura\.[\w.-]+)['"`]/g,
  /\bcase\s+['"`](aura\.[\w.-]+)['"`]/g,
  /\b(?:post|postToOs|notifyFrame)\(\s*(?:f,\s*)?['"`](aura\.[\w.-]+)['"`]/g,
];

test('every message type used in the code is registered', () => {
  const missing = new Map();
  let seen = 0;
  for (const file of sources()) {
    const src = readFileSync(file, 'latin1');
    for (const re of USES) {
      for (const m of src.matchAll(re)) {
        seen++;
        if (!isAuraChannelType(m[1])) missing.set(m[1], file.slice(ROOT.length + 1));
      }
    }
  }
  assert.ok(seen > 100, `scan looks broken: only ${seen} uses found`);
  assert.deepEqual([...missing], []);
});

test('every registered type has a route', () => {
  for (const [type, routes] of Object.entries(AURA_CHANNEL_MESSAGES)) {
    assert.ok(routes.length > 0, type);
  }
});

test('unknown and inherited names are not channel types', () => {
  for (const t of ['aura.nope', 'constructor', 'toString', '__proto__', 1, null, undefined]) {
    assert.equal(isAuraChannelType(t), false, String(t));
    assert.equal(isAuraChannelRouteAllowed(t, 'shell', 'app'), false, String(t));
  }
});

test('an app cannot send a shell-only message', () => {
  for (const t of ['aura.key.claim', 'aura.theme.changed', 'aura.viewport.changed', 'aura.shutdown', 'aura.flight.state', 'aura.surface.state']) {
    assert.equal(isAuraChannelRouteAllowed(t, 'shell', 'app'), true, t);
    assert.equal(isAuraChannelRouteAllowed(t, 'app', 'shell'), false, t);
  }
});

test('an embed host cannot inject keys (D29)', () => {
  assert.equal(isAuraChannelRouteAllowed('aura.key.synthetic', 'embed-host', 'embedded-app'), false);
  assert.equal(isAuraChannelRouteAllowed('aura.key.synthetic', 'shell', 'embedded-app'), true);
});

test('an embed host forwards only UI integration (5.16)', () => {
  const allowed = Object.keys(AURA_CHANNEL_MESSAGES)
    .filter((t) => isAuraChannelRouteAllowed(t, 'embed-host', 'embedded-app'));
  assert.deepEqual(allowed.sort(), ['aura.keymap.changed', 'aura.mode.changed', 'aura.theme.changed', 'aura.viewport.changed', 'aura.window.focus']);
});

test('terminal embed events go only to the embed host', () => {
  for (const t of ['aura.terminal.ready', 'aura.terminal.locked', 'aura.terminal.session-ended']) {
    assert.equal(isAuraChannelRouteAllowed(t, 'embedded-app', 'embed-host'), true, t);
    assert.equal(isAuraChannelRouteAllowed(t, 'embedded-app', 'shell'), false, t);
  }
});

test('the SDK copy of the channel is byte-identical', () => {
  assert.equal(
    readFileSync(join(ROOT, 'packages/app-sdk/src/auraChannel.ts'), 'utf-8'),
    readFileSync(join(ROOT, 'packages/core/src/app-hosts/auraChannel.ts'), 'utf-8'),
  );
});

test('the channel module has no imports', () => {
  const src = readFileSync(join(ROOT, 'packages/core/src/app-hosts/auraChannel.ts'), 'utf-8');
  assert.doesNotMatch(src, /^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/m);
});
