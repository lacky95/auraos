// Docs is one build served from `/` (Phase 2): the window opens on its App
// Host, and the shell proxy strips `/api/proxy/<id>` from the machine paths,
// so the agents' MCP and the lifecycle calls arrive at the root too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AURA_RESERVED_PATHS } from '../../../packages/app-sdk/dist/hostRules.js';
import { AURA_RUNTIME_LOADER_JS } from '../../../packages/app-sdk/dist/runtime/loader.js';

const site = (p) => new URL(`../fumadocs-site/${p}`, import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../app.manifest.json', import.meta.url), 'utf8'));

test('the build has no basePath: it is served at /', () => {
  const config = readFileSync(site('next.config.mjs'), 'utf8');
  assert.doesNotMatch(config, /\bbasePath\s*:/);
});

test('the MCP the manifest advertises is the /mcp route', () => {
  const mcp = manifest.provides.find((p) => p.kind === 'http/mcp');
  assert.equal(mcp.address, '/mcp');
  assert.ok(existsSync(site('app/mcp/route.ts')));
  assert.ok(existsSync(site('app/api/lifecycle/health/route.ts')));
});

test('the manifest keeps only the runtime flags of its proxy block', () => {
  assert.deepEqual(Object.keys(manifest.proxy).sort(), ['injectConsoleRelay', 'injectKeyForwarder', 'injectMeta']);
});

/** Runs the loader as app/layout.tsx emits it, and returns what it wrote. */
function runLoader(hostname, pathname) {
  const written = [];
  const document = { readyState: 'loading', write: (s) => written.push(s), head: { appendChild() {} } };
  vm.runInNewContext(AURA_RUNTIME_LOADER_JS, { window: {}, location: { hostname, pathname }, document });
  return written.join('');
}

test('runtime loader: loads /_aura/runtime.js on an App Host', () => {
  const out = runLoader('docs5f9f7565--os.aura.localhost', '/docs/introduction');
  assert.match(out, new RegExp(`src="${AURA_RESERVED_PATHS.runtime.replace(/[.]/g, '\\.')}"`));
});

test('runtime loader: nothing off an App Host', () => {
  assert.equal(runLoader('localhost', '/docs/introduction'), '');
});
