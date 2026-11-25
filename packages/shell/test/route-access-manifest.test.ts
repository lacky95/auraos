// The access manifest (src/lib/access) against the routes that really exist,
// and synthetic fixtures proving each way the audit has to fail.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { SURFACE_MANIFEST } from '../src/lib/access/surfaceManifest.ts';
import { dispatchedMethods, effectiveRule } from '../src/lib/access/resolve.ts';
import { ROUTE_METHODS } from '../src/lib/access/types.ts';
import type { AccessRule, AccessSurface, RouteAccessManifest } from '../src/lib/access/types.ts';
import {
  analyzeExports, attachedSurfaces, auditRoutes, auditSurfaces, enumerateRoutes, listenerSites, listenersIn,
} from './helpers/enumerateRoutes.ts';
import type { AuditIssue, AuditPolicy } from './helpers/enumerateRoutes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagesDir = path.join(root, 'src/pages');
const attachSource = fs.readFileSync(path.join(root, 'server/attach.mjs'), 'utf8');

// Held here, apart from the manifest, so widening public takes two edits (Q27).
const STATIC_CANDIDATES = ['/api/os/theme.css', '/api/os/icons.svg', '/api/os/icons/[name].svg'];
const candidateKeys = STATIC_CANDIDATES.flatMap((r) => [`GET ${r}`, `HEAD ${r}`]);
const POLICY: AuditPolicy = {
  publicRoutes: new Set([
    'GET /api/admin/first-boot', 'HEAD /api/admin/first-boot',
    'GET /api/auth/status', 'HEAD /api/auth/status', 'POST /api/auth/setup', 'POST /api/auth/login',
    'GET /api/auth/password-policy', 'HEAD /api/auth/password-policy',
    ...candidateKeys,
  ]),
  publicCandidates: new Set(candidateKeys),
  publicSurfaces: new Set(['shell-static-assets', 'page-setup', 'page-login']),
};
const NEVER_PUBLIC = [
  '/api/os/context', '/api/os/volumes', '/api/os/lock', '/api/os/unlock', '/api/os/ui/command',
  '/api/auth/logout', '/api/auth/session', '/api/auth/whoami',
  '/api/auth/password', '/api/auth/account', '/api/auth/sessions/revoke-others',
];
// Classified in SURFACE_MANIFEST as shell-listener, ws-proxy and sse-mux.
const KNOWN_LISTENERS = [
  'server.mjs createServer',
  'server/attach.mjs WebSocketServer',
  'server/attach.mjs upgrade',
  'server/sse-mux.mjs WebSocketServer',
];

const inventory = enumerateRoutes(pagesDir);
const apiRoutes = inventory.routes.filter((r) => r.route.startsWith('/api/'));

const codes = (issues: AuditIssue[]) => issues.map((i) => i.code);
const show = (issues: AuditIssue[]) => issues.map((i) => `${i.code}: ${i.subject}`).join('\n');

// ── the real tree ───────────────────────────────────────────────────────────

test('every route, method and non-route is classified', () => {
  assert.ok(apiRoutes.length > 100, 'the walk found the API routes');
  assert.equal(apiRoutes.length, inventory.routes.length, 'no endpoint outside /api');
  const issues = auditRoutes(inventory, ROUTE_ACCESS_MANIFEST, POLICY);
  assert.deepEqual(issues, [], show(issues));
});

test('every non-Astro surface and SSR page is classified', () => {
  const attached = attachedSurfaces(attachSource);
  assert.ok(attached.includes('attachWsProxy'), 'the parse found attachShellServers');
  const issues = auditSurfaces(SURFACE_MANIFEST, attached, inventory.pages, POLICY);
  assert.deepEqual(issues, [], show(issues));
});

test('every listener in the shell server is classified', () => {
  assert.deepEqual(listenerSites(root), KNOWN_LISTENERS);
});

test('the listener scan finds each form and ignores strings and comments', () => {
  const source = [
    `server.on('upgrade', handler);`,
    `http.createServer(handler);`,
    `new WebSocketServer({ noServer: true });`,
    `new ws.WebSocketServer({ noServer: true });`,
    `server.on('request', handler);`,
    `// server.on('upgrade', handler);`,
    'const s = `http.createServer()`;',
  ].join('\n');
  assert.deepEqual(listenersIn('x.mjs', source), [
    'x.mjs upgrade', 'x.mjs createServer', 'x.mjs WebSocketServer', 'x.mjs WebSocketServer',
  ]);
});

test('the route names follow Astro', () => {
  const routes = new Set(inventory.routes.map((r) => r.route));
  for (const r of ['/api/os/theme.css', '/api/os/icons/[name].svg', '/api/apps', '/api/kv/[...path]']) {
    assert.ok(routes.has(r), r);
  }
  assert.ok(!routes.has('/api/apps/index'));
});

test('sensitive routes are never public, for any method or variant', () => {
  for (const route of NEVER_PUBLIC) {
    const info = inventory.routes.find((r) => r.route === route);
    assert.ok(info, route);
    for (const method of info.methods) {
      assert.ok(!effectiveRule(ROUTE_ACCESS_MANIFEST, info, method)?.allow.includes('public'), `${method} ${route}`);
    }
    for (const v of ROUTE_ACCESS_MANIFEST.routes[route]?.variants ?? []) {
      assert.ok(!v.rule.allow.includes('public'), `${route}#${v.id}`);
    }
  }
});

test('first-boot is public only without ?log, and implicit HEAD follows GET', () => {
  const info = inventory.routes.find((r) => r.route === '/api/admin/first-boot')!;
  assert.deepEqual(effectiveRule(ROUTE_ACCESS_MANIFEST, info, 'HEAD')?.allow, ['public']);
  const log = ROUTE_ACCESS_MANIFEST.routes['/api/admin/first-boot']!.variants!.find((v) => v.id === 'build-log')!;
  assert.deepEqual(log.match, { on: 'query', name: 'log' });
  assert.deepEqual(log.rule.allow, ['owner']);
});

test('kv is denied unless a namespace variant allows it', () => {
  const kv = ROUTE_ACCESS_MANIFEST.routes['/api/kv/[...path]']!;
  for (const m of ROUTE_METHODS) assert.deepEqual(kv.methods?.[m]?.allow, [], m);
  const byId = new Map(kv.variants!.map((v) => [v.id, v]));
  assert.deepEqual(byId.get('os-read')!.rule.allow, ['own-instance', 'owner']);
  assert.deepEqual(byId.get('os-write')!.rule.permissions, ['system.kv.os.<topic>.write']);
  // D46: an app's storage, per user, needs its own storage.read / storage.write.
  assert.deepEqual(byId.get('app-read')!.rule.allow, ['own-instance', 'owner']);
  assert.deepEqual(byId.get('app-read')!.rule.targetPermissions, ['storage.read']);
  assert.deepEqual(byId.get('app-write')!.rule.targetPermissions, ['storage.write']);
});

// ── the enumerator ──────────────────────────────────────────────────────────

test('dispatch follows Astro: ALL takes everything, HEAD falls back to GET', () => {
  assert.deepEqual(dispatchedMethods(['GET']), ['GET', 'HEAD']);
  assert.deepEqual(dispatchedMethods(['POST']), ['POST']);
  assert.deepEqual(dispatchedMethods(['ALL']), [...ROUTE_METHODS]);
  assert.deepEqual(dispatchedMethods(['ALL', 'GET']), [...ROUTE_METHODS]);
});

test('plain handler exports are read, and code inside strings is not', () => {
  const r = analyzeExports('a.ts', [
    'export const GET = () => new Response();',
    'export async function POST() { return new Response(); }',
    'export function helper() {}',
    'export interface Shape { a: 1 }',
    'export type { Shape as GET2 };',
    'const s = `export function DELETE() {}`;',
  ].join('\n'));
  assert.deepEqual(r, { handlers: ['GET', 'POST'], problems: [] });
});

for (const [form, source] of [
  ['export *', `export * from './x';`],
  ['renamed export', `const x = () => 1; export { x as GET };`],
  ['re-export', `export { GET } from './x';`],
  ['namespace export', `export * as GET from './x';`],
  ['lowercase method', `export const get = () => 1;`],
  ['lowercase function', `export function post() {}`],
  ['lowercase all', `export const all = () => 1;`],
  ['destructured export', `export const { GET } = handlers;`],
  ['non-standard method', `export const PROPFIND = () => 1;`],
  ['class export', `export class GET {}`],
  ['export =', `export = handlers;`],
  ['syntax error', `export const GET = (;`],
] as const) {
  test(`fails closed on ${form}`, () => {
    assert.notDeepEqual(analyzeExports('a.ts', source).problems, []);
  });
}

// ── synthetic fixtures: each way the audit must fail ────────────────────────

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-route-manifest-'));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
let fixtureId = 0;

function fixture(files: Record<string, string>) {
  const dir = path.join(fixtureRoot, String(fixtureId++));
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return enumerateRoutes(dir);
}

const GET = 'export const GET = () => new Response();';
const OWNER: AccessRule = { allow: ['owner'], target: 'system' };
const manifest = (over: Partial<RouteAccessManifest> = {}): RouteAccessManifest =>
  ({ groups: { demo: OWNER }, routes: {}, nonRoutes: {}, ...over });
const NO_PUBLIC: AuditPolicy = { publicRoutes: new Set(), publicCandidates: new Set(), publicSurfaces: new Set() };
const audit = (files: Record<string, string>, m: RouteAccessManifest, p = NO_PUBLIC) =>
  codes(auditRoutes(fixture(files), m, p));

test('fixture baseline: a covered route has no issues', () => {
  assert.deepEqual(audit({ 'api/demo/a.ts': GET }, manifest()), []);
});

test('fails when a method and route has no effective rule', () => {
  assert.ok(audit({ 'api/other/a.ts': GET }, manifest()).includes('no-effective-rule'));
});

test('fails when an entry points to a removed route', () => {
  const m = manifest({ routes: { '/api/demo/gone': { methods: { GET: OWNER } } } });
  assert.ok(audit({ 'api/demo/a.ts': GET }, m).includes('stale-route'));
});

test('fails when an entry points to a removed method', () => {
  const m = manifest({ routes: { '/api/demo/a': { methods: { POST: OWNER } } } });
  assert.ok(audit({ 'api/demo/a.ts': GET }, m).includes('stale-method'));
});

test('fails when a variant points to a removed method', () => {
  const m = manifest({
    routes: { '/api/demo/a': { variants: [{ id: 'v', methods: ['PUT'], match: { on: 'query', name: 'x' }, rule: OWNER }] } },
  });
  assert.ok(audit({ 'api/demo/a.ts': GET }, m).includes('stale-method'));
});

test('fails when a baseline group has no routes left', () => {
  const m = manifest({ groups: { demo: OWNER, gone: OWNER } });
  assert.ok(audit({ 'api/demo/a.ts': GET }, m).includes('stale-group'));
});

test('fails when an ALL route lacks a rule for any method', () => {
  const files = { 'api/demo/[...p].ts': 'export const ALL = () => new Response();' };
  const partial = Object.fromEntries(ROUTE_METHODS.filter((x) => x !== 'OTHER').map((x) => [x, OWNER]));
  const issues = auditRoutes(fixture(files), manifest({ routes: { '/api/demo/[...p]': { methods: partial } } }), NO_PUBLIC);
  assert.deepEqual(issues, [{ code: 'all-without-method-rule', subject: 'OTHER /api/demo/[...p]' }]);
  const full = Object.fromEntries(ROUTE_METHODS.map((x) => [x, OWNER]));
  assert.deepEqual(audit(files, manifest({ routes: { '/api/demo/[...p]': { methods: full } } })), []);
});

test('fails when a route uses an unanalyzable export form', () => {
  assert.ok(audit({ 'api/demo/a.ts': `export * from './b';` }, manifest()).includes('unanalyzable'));
});

test('fails when a public rule is outside the allowlist', () => {
  const pub: AccessRule = { allow: ['public'], target: 'system' };
  assert.ok(audit({ 'api/demo/a.ts': GET }, manifest({ routes: { '/api/demo/a': { methods: { GET: pub } } } })).includes('public-not-allowed'));
  assert.ok(audit({ 'api/demo/a.ts': GET }, manifest({ groups: { demo: pub } })).includes('public-not-allowed'));
  const variant = manifest({
    routes: { '/api/demo/a': { variants: [{ id: 'v', methods: ['GET'], match: { on: 'query', name: 'x' }, rule: pub }] } },
  });
  assert.ok(audit({ 'api/demo/a.ts': GET }, variant).includes('public-not-allowed'));
});

test('an allowlisted GET does not make its implicit HEAD public', () => {
  const pub: AccessRule = { allow: ['public'], target: 'system' };
  const policy: AuditPolicy = { ...NO_PUBLIC, publicRoutes: new Set(['GET /api/demo/a']) };
  const issues = auditRoutes(fixture({ 'api/demo/a.ts': GET }), manifest({ routes: { '/api/demo/a': { methods: { GET: pub } } } }), policy);
  assert.deepEqual(issues, [{ code: 'public-not-allowed', subject: 'HEAD /api/demo/a' }]);
});

test('fails when a public candidate has no decision note', () => {
  const pub: AccessRule = { allow: ['public'], target: 'system' };
  const keys = ['GET /api/demo/a', 'HEAD /api/demo/a'];
  const policy: AuditPolicy = { ...NO_PUBLIC, publicRoutes: new Set(keys), publicCandidates: new Set(keys) };
  const m = manifest({ routes: { '/api/demo/a': { methods: { GET: pub } } } });
  assert.ok(audit({ 'api/demo/a.ts': GET }, m, policy).includes('public-candidate-without-decision'));
});

test('fails when a helper is not listed as a non-route', () => {
  const files = { 'api/demo/a.ts': GET, 'api/demo/helper.ts': 'export function help() {}' };
  assert.ok(audit(files, manifest()).includes('unlisted-helper'));
  assert.deepEqual(audit(files, manifest({ nonRoutes: { '/api/demo/helper': 'a helper' } })), []);
});

test('fails when a listed non-route gains a handler or disappears', () => {
  const m = manifest({ nonRoutes: { '/api/demo/a': 'a helper' } });
  assert.ok(audit({ 'api/demo/a.ts': GET }, m).includes('stale-non-route'));
  assert.ok(audit({ 'api/demo/b.ts': GET }, m).includes('stale-non-route'));
});

test('fails when an ambiguous entry has no decision note', () => {
  const bare: AccessRule = { ...OWNER, ambiguous: true };
  const blank: AccessRule = { ...OWNER, ambiguous: true, decision: { note: '  ', phase: 1 } };
  for (const r of [bare, blank]) {
    const m = manifest({ routes: { '/api/demo/a': { methods: { GET: r } } } });
    assert.ok(audit({ 'api/demo/a.ts': GET }, m).includes('ambiguous-without-decision'));
  }
});

test('fails when a decision note is not marked ambiguous', () => {
  const r: AccessRule = { ...OWNER, decision: { note: 'why', phase: 1 } };
  const m = manifest({ routes: { '/api/demo/a': { methods: { GET: r } } } });
  assert.ok(audit({ 'api/demo/a.ts': GET }, m).includes('decision-without-ambiguous'));
});

test('fails on two files for one route', () => {
  assert.ok(audit({ 'api/demo/a.ts': GET, 'api/demo/a/index.ts': GET }, manifest()).includes('unanalyzable'));
});

test('skips _ and dot names, keeps inner dots, collapses index', () => {
  const inv = fixture({
    'api/demo/_private.ts': GET,
    'api/_hidden/a.ts': GET,
    'api/demo/.dot.ts': GET,
    'api/demo/style.css.ts': GET,
    'api/demo/index.ts': GET,
    'page.astro': '',
  });
  assert.deepEqual(inv.routes.map((r) => r.route).sort(), ['/api/demo', '/api/demo/style.css']);
  assert.deepEqual(inv.pages.map((p) => p.route), ['/page']);
});

const surface = (over: Partial<AccessSurface>): AccessSurface =>
  ({ id: 's', kind: 'websocket', source: 'x', paths: ['/x'], rule: OWNER, ...over });
const attachFixture = (body: string) => `export async function attachShellServers(httpServer) {\n${body}\n}`;

test('fails when attachShellServers gains an unclassified surface', () => {
  const attached = attachedSurfaces(attachFixture('attachKnown(httpServer);\nawait attachNewThing(httpServer);'));
  assert.deepEqual(attached, ['attachKnown', 'attachNewThing']);
  const issues = auditSurfaces([surface({ attach: 'attachKnown' })], attached, [], NO_PUBLIC);
  assert.deepEqual(issues, [{ code: 'surface-missing', subject: 'attachNewThing' }]);
});

test('fails when attachShellServers listens directly', () => {
  const attached = attachedSurfaces(attachFixture(`httpServer.on('upgrade', handler);`));
  assert.deepEqual(codes(auditSurfaces([], attached, [], NO_PUBLIC)), ['surface-missing']);
});

test('fails when a surface entry is stale', () => {
  assert.deepEqual(codes(auditSurfaces([surface({ attach: 'attachGone' })], [], [], NO_PUBLIC)), ['surface-stale']);
  assert.deepEqual(codes(auditSurfaces([surface({ kind: 'page', page: '/gone' })], [], [], NO_PUBLIC)), ['surface-stale']);
});

test('fails when an SSR page is unclassified', () => {
  const issues = auditSurfaces([], [], [{ route: '/new', file: 'new.astro' }], NO_PUBLIC);
  assert.deepEqual(issues, [{ code: 'surface-missing', subject: 'page /new' }]);
});

test('fails when a surface is public outside the allowlist', () => {
  const pub = surface({ rule: { allow: ['public'], target: 'system' } });
  assert.deepEqual(codes(auditSurfaces([pub], [], [], NO_PUBLIC)), ['public-not-allowed']);
});

test('fails when a surface decision is missing', () => {
  const s = surface({ rule: { ...OWNER, ambiguous: true } });
  assert.deepEqual(codes(auditSurfaces([s], [], [], NO_PUBLIC)), ['ambiguous-without-decision']);
});
