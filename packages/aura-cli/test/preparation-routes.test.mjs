import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const repo = resolve('../..');
const temp = mkdtempSync(join(tmpdir(), 'aura-routes-'));
process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
async function bundled(entry, name, mockCore = false) {
  const output = join(temp, name + '.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: output,
    plugins: mockCore ? [{ name: 'test-manager', setup(b) {
      b.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
      b.onResolve({ filter: /^@aura\/core$/ }, () => ({ path: 'core', namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export {AppManifestSchema,AURA_NPMRC,needsNpmrc,portPackageJsonForScope,portToolsForScope} from ${JSON.stringify(pathToFileURL(join(repo,'packages/core/dist/index.js')).href)};export const getAppManager=()=>globalThis.__preparationTestManager;` }));
    } }] : [] });
  return import(pathToFileURL(output));
}
const { POST } = await bundled(join(repo, 'packages/shell/src/pages/api/admin/clone-app.ts'), 'clone-route', true);
const { withPreparationProgress } = await bundled(join(repo, 'packages/shell/src/lib/preparationProgress.ts'), 'progress');
const { preparationPost } = await bundled(resolve('src/lib/client.ts'), 'client');

function cloneFixture(t, fail = false) {
  const dir = mkdtempSync(join(temp, 'clone-')); const sourceId = 'test.source'; const targetId = 'test.copy';
  const apps = join(dir, 'apps'); mkdirSync(join(apps, sourceId), { recursive: true });
  writeFileSync(join(apps, sourceId, 'app.manifest.json'), JSON.stringify({ id: sourceId, name: 'Source', icon: 'S', version: '1.0.0' }));
  writeFileSync(join(apps, sourceId, 'package.json'), JSON.stringify({ name: sourceId, dependencies: { astro: '^6' } }));
  mkdirSync(join(apps, sourceId, 'node_modules')); writeFileSync(join(apps, sourceId, 'node_modules/not-copied'), 'x');
  let calls = 0;
  globalThis.__preparationTestManager = {
    registry: { getById: () => ({ scopeId: 'user' }), getAppDir: () => join(apps, sourceId) },
    getScopeDefinitions: () => [{ id: 'user', appsDir: apps, dataDir: dir, immutable: false, priority: 1 }],
    getInstancesByApp: () => [], reloadManifest: () => {},
    prepareApp: async (id, onLine, scope) => {
      calls++; assert.equal(id, targetId); assert.equal(scope, 'user');
      assert.ok(existsSync(join(apps, targetId, 'package.json')));
      assert.ok(!existsSync(join(apps, targetId, 'node_modules')));
      onLine('checking native dependencies');
      if (fail) throw new Error('native dependency unavailable');
      return { status: 'ready', action: 'verified' };
    },
  };
  return { dest: join(apps, targetId), calls: () => calls, request: extra => new Request('http://localhost/api/admin/clone-app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceAppId: sourceId, targetAppId: targetId, ...extra }) }) };
}

test('clone success waits for dependency verification', async t => {
  const f = cloneFixture(t); const response = await POST({ request: f.request() });
  assert.equal(response.status, 200); assert.equal((await response.json()).preparation.status, 'ready'); assert.equal(f.calls(), 1);
});
test('clone preparation failure preserves files and returns an explicit retry', async t => {
  const f = cloneFixture(t, true); const response = await POST({ request: f.request() }); const body = await response.json();
  assert.equal(response.status, 500); assert.equal(body.filesCopied, true); assert.match(body.retry, /aura app prepare/); assert.ok(existsSync(f.dest));
});
test('clone dry run never prepares or lands source', async t => {
  const f = cloneFixture(t); const response = await POST({ request: f.request({ dryRun: true }) });
  assert.equal(response.status, 200); assert.equal(f.calls(), 0); assert.ok(!existsSync(f.dest));
});

test('SSE progress client preserves final status and errors', async t => {
  let failing = false;
  const server = createServer(async (req, res) => {
    const response = withPreparationProgress(new Request('http://localhost/', { headers: { Accept: 'text/event-stream' } }), async onLine => {
      onLine('checking'); return new Response(JSON.stringify(failing ? { ok: false, error: 'registry unavailable' } : { ok: true }), { status: failing ? 500 : 200 });
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    for await (const chunk of response.body) res.write(chunk); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.AURA_SHELL_URL;
  process.env.AURA_SHELL_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); if (previous === undefined) delete process.env.AURA_SHELL_URL; else process.env.AURA_SHELL_URL = previous; });
  const lines = []; assert.deepEqual(await preparationPost('/', {}, line => lines.push(line)), { ok: true }); assert.ok(lines.includes('checking'));
  failing = true;
  await assert.rejects(preparationPost('/', {}), error => error.status === 500 && JSON.parse(error.body).error === 'registry unavailable');
});
