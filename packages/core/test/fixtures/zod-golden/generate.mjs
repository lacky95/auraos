#!/usr/bin/env node
// Records the zod golden for core's boundary schemas (D62, zod 3 -> 4).
//
// Recorded once with zod 3.25.76 on main 0e995efc (before the upgrade). It
// stores the inputs (seeds + one mutation per case) and what zod 3 made of
// them: success, the parsed data (canonical JSON with `undefined` kept; a hash
// of it for the mutated cases), and the
// issues (code, path, message and the code's own fields; `unionErrors`
// dropped). test/zod-golden.test.mjs replays every case on the current zod
// and requires the same result: the manifest validation messages, the D105
// error bodies built from them and the parsed manifests stay what they were.
//
// Re-running it on zod 4 would record zod 4 as the truth: don't, unless an
// intended change is reviewed case by case. Usage (from packages/core, after
// `tsc`): node test/fixtures/zod-golden/generate.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../../dist/index.js';
import { applyMutation, canonical, dataHash, MUTATION_VALUES, objectPaths } from './cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../../..');
const zodVersion = JSON.parse(readFileSync(createRequire(join(HERE, '../../../package.json')).resolve('zod/package.json'), 'utf8')).version;

const SCHEMAS = {
  AppManifestSchema: core.AppManifestSchema,
  ProvidedInterfaceSchema: core.ProvidedInterfaceSchema,
  CustomInterfaceSchema: core.CustomInterfaceSchema,
  CreateInputSchema: core.CreateInputSchema,
  UpdatePatchSchema: core.UpdatePatchSchema,
  AnswerSchema: core.AnswerSchema,
  InteractionInputSchema: core.InteractionInputSchema,
  ListQuerySchema: core.ListQuerySchema,
  ClearFilterSchema: core.ClearFilterSchema,
  SeriesSchema: core.SeriesSchema,
};

// ── seeds ──────────────────────────────────────────────────────────────────
const MAX_MANIFEST = {
  id: 'com.example.max', originId: '5f9f7565-b9bc-433c-86be-ddae7317e7b2', componentType: 'activity',
  name: 'Max', version: '1.2.3', description: 'every field', icon: 'MX', entrypoint: 'run.sh', serverPort: 4100,
  ports: { exposes: [{ sourceApp: 'com.aura.a', sourcePort: 80, port: 8080 }], hostPublish: [{ port: 3000, hostPort: 3001 }] },
  runtime: 'raw', serve: 'auto', build: { ignore: ['data/**'] },
  proxy: { injectMeta: true, injectConsoleRelay: false, injectKeyForwarder: true, injectIdentityScript: true, injectInputCompat: false, injectEventSourceMux: true, exposeAllPaths: false },
  permissions: ['storage.read', 'data:com.aura.settings:read'], tools: ['git', 'node'], auraContract: 1, context: ['OPENAI_API_KEY'],
  rootfsMode: 'isolated', category: 'developer', instanceMode: 'multi', maxInstances: 3, warmPool: 1, activityMode: 'multi',
  maxActivitiesPerInstance: 4, autoStart: true, critical: false, useProot: false, sandbox: 'container', defaultLaunch: 'new-activity',
  backgroundService: true, viewConfig: { defaultWidth: 900, defaultHeight: 700, resizable: false },
  flight: { maxPerApp: 2, defaultMode: 'edge', modes: ['free', 'edge'], edgeSize: { length: 'full', depth: 300 }, defaultSize: { w: 400, h: 300 }, minSize: { w: 100, h: 80 } },
  lifecycleBasePath: '/api/lifecycle', preferredLayout: 'tiling',
  keymapActions: [{ id: 'open.thing', label: 'Open thing', description: 'opens', category: 'Nav', defaultCombo: 'Ctrl+K', scope: 'app' }],
  theme: { mode: 'custom', accentColor: '#ff0000' }, themeStrategy: 'themed',
  dataProvider: { authority: 'com.example.max', providers: [{ path: '/api/data/x', readPermission: 'p.read', writePermission: 'p.write' }] },
  intentFilters: [{ action: 'aura.intent.action.VIEW', category: ['aura.intent.category.DEFAULT'], dataMime: ['text/*'], dataScheme: ['https'], priority: 2 }],
  provides: [{ name: 'tools', kind: 'http/mcp', address: '/mcp', version: '2', description: 'd', schema: 'schema.json', permission: 'p' }],
  consumes: [{ name: 'docs', kind: 'mcp', appId: 'com.aura.docs', version: '0.1.0', required: false, description: 'd' }],
  hosts: [{ name: 'maxui', service: 'web', port: 8080, description: 'ui' }],
  repository: { url: 'gitlab.com/x/y', branch: 'main', commit: 'abcdef1' },
  source: { defaultMode: 'open' },
  publish: { repo: 'github.com/x/y', registry: 'ghcr.io/x/y', channels: ['beta'], ignore: ['node_modules'] },
  store: { publisher: 'Me', homepage: 'https://example.com', license: 'MIT', tags: ['a'], longDescription: 'long', screenshots: ['store/1.png', 'https://example.com/2.png'] },
  metadata: { anything: { nested: [1, 2] } },
  dependencies: [{ id: 'com.aura.docs', version: '^0.1.0' }],
  services: [{
    name: 'web', image: 'nginx:1', command: ['nginx'], prePull: true, port: 8080, proxyDashboard: true, env: { A: 'b' },
    volumes: [{ name: 'data', target: '/data', shared: true, volume: 'v', subpath: 's' }], envInherit: ['HOME'], inheritIdentity: true,
    inheritPermissions: true, inheritTools: false, tools: ['git'], inheritHome: true, inheritMounts: true, inheritDockerSocket: false,
    capabilities: ['NET_ADMIN'], devices: ['/dev/fuse'], privileged: false, publish: [{ host: 9000, container: 8080 }], user: '1000:1000',
    workdir: '/w', limits: { memory: '512m', cpus: 1.5 }, seed: { command: ['init'] }, dns: ['1.1.1.1'], restart: 'always',
    keepAcrossRestart: true, readiness: { path: '/health', timeoutMs: 5000 },
  }],
};
const MIN_MANIFEST = { id: 'com.example.min', name: 'Min', version: '0.0.1' };
const SPARSE_MANIFEST = {
  ...MIN_MANIFEST, viewConfig: {}, theme: {}, flight: {}, source: {}, publish: {}, store: {}, ports: {},
  services: [{ name: 'svc', image: 'img', readiness: {}, volumes: [{ name: 'v', target: '/t' }] }],
  keymapActions: [{ id: 'k', label: 'K' }], intentFilters: [{ action: 'a' }], provides: [{ name: 'p', kind: 'os/kv', address: 'app/x' }],
  consumes: [{ name: 'c', kind: 'rest' }], dataProvider: { authority: 'com.example.min' }, hosts: [{ name: 'minui' }],
};

const COMPONENTS = [
  { kind: 'input', id: 'in', label: 'In', placeholder: 'p', multiline: true, required: true },
  { kind: 'options', id: 'op', label: 'Op', multiple: false, display: 'radio', options: [{ id: 'a', label: 'A', description: 'd' }, { id: 'b', label: 'B' }] },
  { kind: 'select', id: 'se', label: 'Se', placeholder: 'p', required: false, default: 'x', options: [{ id: 'x', label: 'X' }] },
  { kind: 'combobox', id: 'co', label: 'Co', placeholder: 'p', required: true, allowCustom: true, default: 'free', options: [{ id: 'y', label: 'Y' }] },
  { kind: 'markdown', id: 'md', label: 'Md', text: '# hi', view: 'source', editable: true, required: false, maxHeight: 300 },
  { kind: 'button', role: 'submit', variant: 'primary', action: 'resolve' },
  { kind: 'button', id: 'go', label: 'Go', href: 'https://example.com', action: 'link' },
  { kind: 'progress', id: 'pr', value: 0.5, label: 'half' },
];
const CONTEXT = { kind: 'activity', id: 'act-1', appId: 'com.example.max', label: 'ctx' };
const SENDER = { name: 'Bot', icon: 'B', actor: { name: 'Agent' } };

const SEEDS = {
  AppManifestSchema: { max: MAX_MANIFEST, min: MIN_MANIFEST, sparse: SPARSE_MANIFEST },
  ProvidedInterfaceSchema: { http: MAX_MANIFEST.provides[0], os: { name: 'events', kind: 'event', address: 'x:*' } },
  CustomInterfaceSchema: { mcp: { name: 'remote-mcp', kind: 'http/mcp', address: 'https://example.com/mcp', version: '1', description: 'd', schema: 's' }, ws: { name: 'ws', kind: 'ws', address: 'wss://h:1/x' } },
  CreateInputSchema: {
    dialogue: {
      type: 'dialogue', title: 'T', text: 'body', icon: 'i', image: 'img', priority: 'high', visibility: 'secret', publicTitle: 'pt', publicText: 'px',
      timeoutMs: 60000, pinned: true, popupDurationMs: -5, popup: true, blocking: true, scope: 'desktop', maximized: true,
      components: COMPONENTS, context: CONTEXT, sender: SENDER,
    },
    simple: { title: 'Hello' },
  },
  UpdatePatchSchema: {
    full: {
      title: 'T', text: 'x', icon: null, image: 'img', priority: 'low', visibility: 'public', publicTitle: null, publicText: 'p', timeoutMs: null,
      pinned: false, popupDurationMs: 100, popup: false, blocking: false, scope: 'system', maximized: false, components: COMPONENTS.slice(0, 3), context: null, sender: SENDER,
    },
    empty: {},
  },
  AnswerSchema: { submitted: { outcome: 'submitted', buttonId: 'submit', values: { in: 'text', op: ['a'] } }, plain: 'yes' },
  InteractionInputSchema: { full: { componentId: 'op', value: 'a', values: { in: 'x', op: ['a', 'b'] } } },
  ListQuerySchema: { full: { state: 'all', sender: 'app:com.example.max', priority: 'urgent', limit: '20', cursor: 'c1' }, empty: {} },
  ClearFilterSchema: { full: { sender: 'app:x', priority: 'low' } },
  SeriesSchema: { full: { app: 'com.example.max', base: { repository: 'https://gitlab.com/x/y.git', commit: 'abcdef1', path: 'apps/x' }, patches: [{ file: 'patches/0001-x.patch', subject: 'x' }] } },
};

for (const f of execFileSync('git', ['-C', REPO, 'ls-files', '*app.manifest.json']).toString().trim().split('\n')) {
  if (f.includes('/templates/')) continue; // placeholders, not JSON
  SEEDS.AppManifestSchema[`repo:${f}`] = JSON.parse(readFileSync(join(REPO, f), 'utf8'));
}

// Targeted cases: semantics zod 4 changed (defaults, formats, unions), each as
// a seed + mutation like the generated ones.
const TARGETED = [
  ['AppManifestSchema', 'min', ['originId'], '12345678-1234-1234-1234-123456789012'],
  ['AppManifestSchema', 'min', ['originId'], '00000000-0000-0000-0000-000000000000'],
  ['AppManifestSchema', 'min', ['originId'], 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'],
  ['AppManifestSchema', 'min', ['originId'], 'not-a-uuid'],
  ['AppManifestSchema', 'max', ['store', 'homepage'], 'http://localhost:3000'],
  ['AppManifestSchema', 'max', ['store', 'homepage'], 'mailto:a@b.c'],
  ['AppManifestSchema', 'max', ['store', 'homepage'], 'example.com'],
  ['AppManifestSchema', 'max', ['store', 'homepage'], 'https://'],
  ['AppManifestSchema', 'max', ['store', 'homepage'], 'https:/x'],
  ['AppManifestSchema', 'max', ['store', 'homepage'], 'javascript:alert(1)'],
  ['AppManifestSchema', 'max', ['flight', 'edgeSize', 'length'], 100],
  ['AppManifestSchema', 'max', ['flight', 'edgeSize', 'length'], 'half'],
  ['AppManifestSchema', 'max', ['componentType'], 'service'],
  ['AppManifestSchema', 'max', ['provides', 1], { name: 'tools', kind: 'http/mcp', address: '/x' }],
  ['AppManifestSchema', 'max', ['hosts', 0, 'name'], 'tools'],
  ['AppManifestSchema', 'max', ['hosts', 0, 'service'], 'nope'],
  ['AppManifestSchema', 'max', ['hosts', 0, 'name'], 'app'],
  ['AppManifestSchema', 'max', ['provides', 0, 'kind'], 'http/host'],
  ['AppManifestSchema', 'max', ['provides', 0, 'kind'], 'mcp'],
  ['AppManifestSchema', 'max', ['provides', 0, 'kind'], 'os/kv'],
  ['AppManifestSchema', 'max', ['intentFilters', 0, 'priority'], 1.5],
  ['AppManifestSchema', 'max', ['warmPool'], 9],
  ['AppManifestSchema', 'max', ['maxInstances'], Number.MAX_SAFE_INTEGER + 2],
  ['AppManifestSchema', 'max', ['services', 0, 'limits', 'cpus'], 0],
  ['AppManifestSchema', 'max', ['services', 0, 'readiness'], {}],
  ['AppManifestSchema', 'max', ['services', 0, 'restart'], 'sometimes'],
  ['AppManifestSchema', 'max', ['store', 'tags'], Array.from({ length: 17 }, (_, i) => `t${i}`)],
  ['AppManifestSchema', 'max', ['store', 'screenshots', 0], '../x.png'],
  ['AppManifestSchema', 'max', ['name'], 'N'.repeat(65)],
  ['AppManifestSchema', 'max', ['version'], '1.2'],
  ['AppManifestSchema', 'max', ['id'], 'Com.Example'],
  ['AppManifestSchema', 'max', ['context', 0], 'lower'],
  ['AppManifestSchema', 'max', ['metadata'], { b: null, c: [] }],
  ['AppManifestSchema', 'min', ['viewConfig'], undefined],
  ['AppManifestSchema', 'min', ['keymapActions'], [{ id: 'k', label: 'K', defaultCombo: undefined }]],
  ['AppManifestSchema', 'min', ['services'], [{ name: 'Bad Name', image: '' }]],
  ['AppManifestSchema', 'min', ['activityMode'], 'multi'],
  ['AppManifestSchema', 'min', ['id'], undefined],
  ['CustomInterfaceSchema', 'mcp', ['address'], 'localhost:3000'],
  ['CustomInterfaceSchema', 'mcp', ['address'], 'ws://h:1/x'],
  ['CustomInterfaceSchema', 'mcp', ['kind'], 'os/kv'],
  ['CustomInterfaceSchema', 'mcp', ['address'], 'http://[::1]:3000/mcp'],
  ['CreateInputSchema', 'dialogue', ['components', 4], { kind: 'markdown', id: 'md', text: 'x' }],
  ['CreateInputSchema', 'dialogue', ['components', 1, 'display'], 'checkbox'],
  ['CreateInputSchema', 'dialogue', ['components', 1, 'multiple'], true],
  ['CreateInputSchema', 'dialogue', ['components', 2, 'default'], 'nope'],
  ['CreateInputSchema', 'dialogue', ['components', 3, 'allowCustom'], false],
  ['CreateInputSchema', 'dialogue', ['components', 6], { kind: 'button' }],
  ['CreateInputSchema', 'dialogue', ['components', 6], { kind: 'button', role: 'submit' }],
  ['CreateInputSchema', 'dialogue', ['components', 0, 'kind'], 'slider'],
  ['CreateInputSchema', 'dialogue', ['components', 4, 'maxHeight'], 50],
  ['CreateInputSchema', 'dialogue', ['components', 4, 'maxHeight'], 'tall'],
  ['CreateInputSchema', 'dialogue', ['popupDurationMs'], 0],
  ['CreateInputSchema', 'dialogue', ['popupDurationMs'], 24 * 3600 * 1000 + 1],
  ['CreateInputSchema', 'dialogue', ['timeoutMs'], 0],
  ['CreateInputSchema', 'dialogue', ['scope'], 'auto'],
  ['CreateInputSchema', 'simple', ['components'], Array.from({ length: 9 }, (_, i) => ({ kind: 'input', id: `i${i}` }))],
  ['CreateInputSchema', 'simple', ['components'], [{ kind: 'options', id: 'o', options: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: 'x' })) }]],
  ['CreateInputSchema', 'simple', ['components'], [{ kind: 'input', id: 'bad id' }]],
  ['CreateInputSchema', 'simple', ['caller'], 'forged'],
  ['AnswerSchema', 'submitted', ['outcome'], 'maybe'],
  ['AnswerSchema', 'submitted', ['big'], 'x'.repeat(2 * 65_536 + 16_384)],
  ['InteractionInputSchema', 'full', ['values'], Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']))],
  ['InteractionInputSchema', 'full', ['values', 'bad key'], 'v'],
  ['ListQuerySchema', 'full', ['limit'], 'abc'],
  ['ListQuerySchema', 'full', ['limit'], '0'],
  ['ListQuerySchema', 'full', ['limit'], 201],
  ['ListQuerySchema', 'full', ['limit'], ''],
  ['ListQuerySchema', 'full', ['limit'], null],
  ['ListQuerySchema', 'full', ['limit'], true],
  ['ListQuerySchema', 'full', ['state'], 'gone'],
  ['SeriesSchema', 'full', ['base', 'path'], '/abs'],
  ['SeriesSchema', 'full', ['base', 'path'], 'a/../b'],
  ['SeriesSchema', 'full', ['base', 'commit'], 'HEAD'],
  ['SeriesSchema', 'full', ['patches', 0, 'file'], 'x.patch'],
];

/** The recorded result of one parse: data on success, the issues otherwise. */
function record(schema, input, full = false) {
  const r = schema.safeParse(input);
  if (r.success) return full ? { success: true, data: canonical(r.data) } : { success: true, dataHash: dataHash(r.data) };
  return {
    success: false,
    issues: r.error.issues.map((i) => {
      const { unionErrors: _u, ...rest } = i;
      return JSON.parse(JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
    }),
  };
}

const cases = [];
for (const [name, seeds] of Object.entries(SEEDS)) {
  const schema = SCHEMAS[name];
  const seen = new Set();
  for (const [seed, value] of Object.entries(seeds)) {
    cases.push({ schema: name, seed, mutation: null, expect: record(schema, value, true) });
    for (const path of objectPaths(value)) {
      const sig = path.map((p) => (typeof p === 'number' ? '#' : p)).join('.');
      for (const [label, v] of Object.entries(MUTATION_VALUES)) {
        const key = `${sig}=${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mutation = { path, value: label };
        cases.push({ schema: name, seed, mutation, expect: record(schema, applyMutation(value, mutation)) });
      }
    }
  }
}
for (const [name, seed, path, value] of TARGETED) {
  const mutation = { path, literal: value === undefined ? { $undefined: true } : value };
  cases.push({ schema: name, seed, mutation, expect: record(SCHEMAS[name], applyMutation(SEEDS[name][seed], mutation)) });
}
// Non-object roots.
for (const name of Object.keys(SCHEMAS)) {
  for (const label of ['null', 'string', 'array', 'number', 'undefined']) {
    cases.push({ schema: name, seed: null, mutation: { path: [], value: label }, expect: record(SCHEMAS[name], MUTATION_VALUES[label]) });
  }
}

const out = { recordedWith: { zod: zodVersion, commit: execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).toString().trim() }, seeds: SEEDS, cases };
// One case per line: small diffs when a case is reviewed.
writeFileSync(join(HERE, 'golden.json'), `{"recordedWith":${JSON.stringify(out.recordedWith)},\n"seeds":${JSON.stringify(out.seeds)},\n"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`);
const fails = cases.filter((c) => !c.expect.success).length;
console.log(`zod ${zodVersion}: ${cases.length} cases (${fails} refused) -> golden.json`);
for (const [name, seeds] of Object.entries(SEEDS)) {
  for (const [seed, value] of Object.entries(seeds)) {
    if (!seed.startsWith('repo:') && !SCHEMAS[name].safeParse(value).success) console.log(`WARN seed ${name}/${seed} does not parse`);
  }
}
