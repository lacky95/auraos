// `aura dev validate`'s App Host contract checks (lib/apphost-lint.ts): each
// rule against a throwaway app with a stub SDK, plus the cases that must stay
// quiet (server-side machine calls, env vars, upgrade handlers with a path check).
//
//   pnpm --filter @aura/cli test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppManifestSchema } from '@aura/core';
import {
  browserLineRange, collectExports, findAppSdkDir, lintAppSources, lintManifestKeys, lintProxyPaths,
  lintRemovedGlobals, lintSdkImports, lintTrackedRuntimeData, lintUpgradeAndHmr, readSdkExports, strippedKeyPaths, type Finding,
} from '../src/lib/apphost-lint.js';
import { REMOVED_MANIFEST_KEYS } from '../src/commands/dev.js';

const root = mkdtempSync(join(tmpdir(), 'aura-apphost-lint-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(base: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), body);
  }
  return base;
}

/** A stub @aura/app-sdk: `osUrl` + a type in the root (through `export *` and a re-export), and a `./proxy` subpath. */
function stubSdk(dir: string, extra = ''): string {
  return write(dir, {
    'package.json': JSON.stringify({
      name: '@aura/app-sdk',
      exports: {
        '.': { import: './dist/index.js', types: './dist/index.d.ts' },
        './proxy': { import: './dist/proxy.js', types: './dist/proxy.d.ts' },
        './integration': { import: './dist/integration.mjs' },
      },
    }),
    'dist/index.d.ts': `export * from './os-auth.js';\nexport { OsClient as Client, type Theme } from './client.js';\n/* export declare function inComment(): void; */\n${extra}`,
    'dist/os-auth.d.ts': 'export declare function osUrl(p: string): string;\nexport declare function appHostRuntime(): unknown;\n',
    'dist/client.d.ts': 'export declare class OsClient {}\nexport interface Theme { id: string }\n',
    'dist/proxy.d.ts': 'export declare function proxyFetch(): void;\n',
    'dist/integration.mjs': 'export function auraAppIntegration() {}\nexport async function resolveAppPort() {}\n',
  });
}

const rules = (fs: Finding[]) => fs.map((f) => `${f.rule}:${f.severity}:${f.line}`);

test('collectExports follows export *, re-exports with renames, types, and ignores comments', () => {
  const sdk = stubSdk(join(root, 'sdk-a'));
  const names = collectExports(join(sdk, 'dist', 'index.d.ts'));
  assert.deepEqual([...names].sort(), ['Client', 'Theme', 'appHostRuntime', 'osUrl']);
  const exp = readSdkExports(sdk);
  assert.deepEqual([...exp.subpaths.keys()].sort(), ['.', './integration', './proxy']);
  assert.ok(exp.subpaths.get('./integration')!.has('auraAppIntegration'));
});

test('a removed SDK value import is an error with its line; a type-only one a warning', () => {
  const sdk = readSdkExports(stubSdk(join(root, 'sdk-b')));
  const src = [
    "import { osUrl, getAppBasePath } from '@aura/app-sdk';",
    'import {',
    '  Client,',
    '  type Gone,',
    "} from '@aura/app-sdk';",
    "import type { Theme, OldTheme } from '@aura/app-sdk';",
    "import { proxyFetch } from '@aura/app-sdk/proxy';",
    "import { x } from '@aura/app-sdk/nope';",
  ].join('\n');
  const f = lintSdkImports('/a.ts', src, sdk);
  assert.deepEqual(rules(f), ['sdk-import:error:8', 'sdk-import:error:1', 'sdk-import:warn:4', 'sdk-import:warn:6']);
  assert.match(f[1]!.message, /getAppBasePath.*drop the base path/);
  assert.match(f[0]!.message, /@aura\/app-sdk\/nope/);
});

test('a name only the app\'s own SDK copy still has warns that the next update breaks it', () => {
  const own = readSdkExports(stubSdk(join(root, 'sdk-own'), 'export declare function getAppBasePath(): string;\n'));
  const current = readSdkExports(stubSdk(join(root, 'sdk-current')));
  const f = lintSdkImports('/a.ts', "import { getAppBasePath, osUrl } from '@aura/app-sdk';", own, current);
  assert.deepEqual(rules(f), ['sdk-import:warn:1']);
  assert.match(f[0]!.message, /next SDK update/);
});

test('the app\'s SDK is the nearest node_modules copy', () => {
  const app = join(root, 'nested', 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  stubSdk(join(root, 'nested', 'node_modules', '@aura', 'app-sdk'));
  assert.equal(findAppSdkDir(join(app, 'src')), join(root, 'nested', 'node_modules', '@aura', 'app-sdk'));
});

test('removed globals and aura-* meta reads are flagged; env vars and comments are not', () => {
  const src = [
    'const base = window.AURA_APP_BASE_PATH;',
    "const id = globalThis['AURA_INSTANCE_ID'];",
    "const mode = document.querySelector('meta[name=\"aura-resolved-mode\"]')?.content;",
    'const env = process.env.AURA_APP_ID;',
    'const { AURA_INSTANCE_ID } = process.env;',
    '// window.AURA_APP_ID used to be set by the proxy',
  ].join('\n');
  const f = lintRemovedGlobals('/a.ts', src);
  assert.deepEqual(rules(f), ['removed-global:warn:1', 'removed-global:warn:2', 'removed-global:warn:3']);
  assert.match(f[2]!.message, /aura-resolved-mode.*appHostRuntime/);
});

test('/api/proxy is flagged only in code the browser runs', () => {
  const astro = "---\nconst r = await fetch(`${base}/api/proxy/com.x/mcp`);\n---\n<a href=\"/api/proxy/com.x/\">x</a>\n";
  assert.deepEqual(browserLineRange('src/pages/index.astro', astro), { from: 4 });
  assert.deepEqual(rules(lintProxyPaths('/i.astro', 'src/pages/index.astro', astro)), ['proxy-path:warn:4']);

  const fetchProxy = "fetch('/api/proxy/com.x/api/items');\n";
  assert.equal(lintProxyPaths('/c.tsx', 'src/components/List.tsx', fetchProxy).length, 1);
  assert.equal(lintProxyPaths('/p.js', 'public/app.js', fetchProxy).length, 1);
  assert.equal(lintProxyPaths('/u.ts', 'app/page.ts', `'use client';\n${fetchProxy}`).length, 1);
  // Server code: endpoints, server modules, plain lib files.
  assert.equal(lintProxyPaths('/e.ts', 'src/pages/api/items.ts', fetchProxy).length, 0);
  assert.equal(lintProxyPaths('/s.ts', 'src/server/bridge.ts', fetchProxy).length, 0);
  assert.equal(lintProxyPaths('/l.ts', 'src/lib/agents.ts', fetchProxy).length, 0);
  // An address shown to agents, and comments.
  assert.equal(lintProxyPaths('/c.tsx', 'src/components/S.tsx', 'const a = `${OS_API_BASE}/api/proxy/com.x`;\n// was /api/proxy/com.x/\n').length, 0);
});

test('upgrade handlers without a path check are notes; with one, or on a client request, nothing', () => {
  const bad = "server.httpServer?.on('upgrade', (req, socket, head) => {\n  wss.handleUpgrade(req, socket, head, () => {});\n});\n";
  assert.deepEqual(rules(lintUpgradeAndHmr('/x/astro.config.mjs', bad)), ['upgrade-catch-all:info:1']);
  const good = "server.on('upgrade', (req, socket, head) => {\n  if (new URL(req.url, 'http://h').pathname !== '/ws') return;\n});\n";
  assert.equal(lintUpgradeAndHmr('/x/server.mjs', good).length, 0);
  const named = "function onUp(req, socket) { if (req.url !== '/ws') return; }\nsrv.on('upgrade', onUp);\n";
  assert.equal(lintUpgradeAndHmr('/x/server.mjs', named).length, 0);
  assert.equal(lintUpgradeAndHmr('/x/proxy.mjs', "upstreamReq.on('upgrade', (res, sock) => sock.pipe(x));\n").length, 0);
  assert.equal(lintUpgradeAndHmr('/x/test/stub.test.mjs', bad).length, 0);
  assert.deepEqual(rules(lintUpgradeAndHmr('/x/astro.config.mjs', 'vite: { server: { hmr: false } },\n')), ['hmr-off:info:1']);
  assert.equal(lintUpgradeAndHmr('/x/src/a.ts', 'const o = { hmr: false };\n').length, 0);
});

test('stripped manifest keys: removed ones say why, unknown ones are named, with lines', () => {
  const text = JSON.stringify({
    id: 'com.example.lint', name: 'Lint', version: '0.1.0',
    proxy: { rewriteHtml: 'astro', injectMeta: false },
    viewConfg: { defaultWidth: 900 },
    services: [{ name: 'db', image: 'redis:7', bogus: 1 }],
  }, null, 2);
  const raw = JSON.parse(text) as unknown;
  const parsed = AppManifestSchema.safeParse(raw);
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  assert.deepEqual(strippedKeyPaths(raw, parsed.data).map((p) => p.join('.')).sort(), ['proxy.rewriteHtml', 'services.0.bogus', 'viewConfg']);
  const f = lintManifestKeys('/m.json', text, raw, parsed.data, REMOVED_MANIFEST_KEYS);
  const byKey = Object.fromEntries(f.map((x) => [x.message.match(/"([^"]+)"/)![1], x]));
  assert.match(byKey['proxy.rewriteHtml']!.message, /removed in the App Host cutover/);
  assert.equal(byKey['proxy.rewriteHtml']!.line, text.split('\n').findIndex((l) => l.includes('rewriteHtml')) + 1);
  assert.match(byKey['viewConfg']!.message, /unknown manifest key/);
  assert.equal(byKey['services.0.bogus']!.line, text.split('\n').findIndex((l) => l.includes('bogus')) + 1);
});

test('lintAppSources walks the app, skipping node_modules, dist, .astro and .next', () => {
  const app = write(join(root, 'app-walk'), {
    'src/pages/index.astro': "---\nimport { getAppBasePath } from '@aura/app-sdk';\n---\n<p>hi</p>\n",
    'node_modules/x/index.js': "fetch('/api/proxy/a/'); window.AURA_APP_ID;\n",
    'dist/client/a.js': "fetch('/api/proxy/a/');\n",
    '.astro/x.ts': 'window.AURA_APP_ID;\n',
    '.next/static/x.js': 'window.AURA_APP_ID;\n',
  });
  stubSdk(join(app, 'node_modules', '@aura', 'app-sdk'));
  const f = lintAppSources(app, { upcomingSdk: null });
  assert.deepEqual(f.map((x) => `${x.file.slice(app.length + 1)}:${x.line}:${x.severity}`), ['src/pages/index.astro:2:error']);
});

test('validate warns about runtime data and secrets the app\'s git repo tracks', () => {
  const app = write(join(root, 'tracked-data'), {
    'app.manifest.json': '{}', 'src/a.ts': '', 'io.x.app/secrets.json': '{}', '.sidecars/webui/data/webui.db': 'x',
  });
  const git = (...args: string[]) => execFileSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  const f = lintTrackedRuntimeData(app, 'io.x.app');
  assert.deepEqual(f.map((x) => `${x.file.slice(app.length + 1)}:${x.severity}:${x.rule}`),
    ['.sidecars/webui/data/webui.db:warn:runtime-data', 'io.x.app/secrets.json:warn:runtime-data']);
  assert.match(f[0]!.message, /git rm --cached/);
  git('rm', '-rq', '--cached', 'io.x.app', '.sidecars');
  assert.deepEqual(lintTrackedRuntimeData(app, 'io.x.app'), [], 'untracked: quiet');
});
