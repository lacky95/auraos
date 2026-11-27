// Phase 3a integration: an in-process smoke of the middleware's decision path
// with AURA_ACCESS_ENFORCE=enforce against the real route access manifest and
// the real principal resolver (auth.ts `resolveCaller`). Only the stores are
// fakes: instance tokens, the login session, the operator tickets (real files
// in a temp dir), the D28 network table and the D45 App Host services.
//
// Each request goes the middleware's way: a gateway call through
// enforceGateway, then every /api call through the access gate.
//
//   node tools/run-tests.mjs --only=packages/shell
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Authorizer } from '@aura/core';
import type { AccessPrincipal, GatewayIdentityClaim, InstallBinding } from '@aura/core';
import * as setupTickets from '@aura/core/setup-tickets';
import { createSetupTicket, defaultSetupTicketDir, FileSetupTickets, operatorRequestSubject } from '@aura/core/setup-tickets';
import { GATEWAY_IDENTITY_HEADER, OWNER_SSR_HEADER } from '@aura/core/host-rules';
import { signGatewayClaim, signOwnerSsrClaim } from '../server/gateway-identity.mjs';
import { stripShellCredentials } from '../server/shell-credentials.mjs';
import { ACCESS_MODE_ENV } from '../server/access-mode.mjs';
import { createDecide } from '../src/lib/access/decide.ts';
import { accessGate, reportBodyVariant, type GateDeps } from '../src/lib/access/enforce.ts';
import { enforceGateway } from '../src/lib/access/gatewayCaller.ts';
import { isTrustedOwnerAgent, type GatewayOwnerDeps } from '../src/lib/access/identify.ts';
import type { ObserverManager } from '../src/lib/access/observer.ts';
import { installGate } from '../src/lib/approvals/nexus.ts';
import { resolveCaller, type AuthDeps } from '../src/lib/auth.ts';
import { localSystemId } from '@aura/core/system-identity';
/** The test data dir's own system id (D47): every resolved principal carries it. */
const SYS = localSystemId();

// ── the system ──────────────────────────────────────────────────────────────

const TERMINAL = 'com.aura.terminal';
const AURASHELLD = 'com.aura.aurashelld';
const SETTINGS = 'com.aura.settings';
const COUNTER = 'com.example.counter';
const TERMINALX = 'io.lakner.terminalx';

// Every instance is the owner's (its server-side `owner`), as on a one-user system.
const instances: Record<string, { appId: string; instanceId: string; sandbox: string; state: string; owner: string }> = {};
for (const appId of [TERMINAL, AURASHELLD, SETTINGS, COUNTER, TERMINALX]) {
  instances[`${appId}-1`] = { appId, instanceId: `${appId}-1`, sandbox: 'container', state: 'resumed', owner: 'default' };
}
const scopes: Record<string, string> = { [TERMINAL]: 'system', [AURASHELLD]: 'system', [SETTINGS]: 'system', [COUNTER]: 'user', [TERMINALX]: 'user' };
const declared: Record<string, string[]> = {
  [TERMINAL]: [], [AURASHELLD]: [], [SETTINGS]: ['system.kv.os.theme.write'],
  // Declared, never granted: a privileged permission (stream C) does nothing on its own.
  [COUNTER]: ['system.kv.os.theme.write', 'storage.read'],
  // Declared and granted by the owner (D29): TerminalX's watcher.
  [TERMINALX]: ['terminal.embed', 'terminal.sessions.list'],
};
const TOKENS: Record<string, string> = {
  'aura1.terminal': `${TERMINAL}-1`, 'aura1.aurashelld': `${AURASHELLD}-1`, 'aura1.counter': `${COUNTER}-1`,
  'aura1.terminalx': `${TERMINALX}-1`, 'aura1.settings': `${SETTINGS}-1`,
};
// A sidecar of Settings' instance (never the owner, D45).
const SIDECAR_TOKENS: Record<string, { instanceId: string; sidecar: string }> = { 'aura1.settings-db': { instanceId: `${SETTINGS}-1`, sidecar: 'db' } };
const mgr = {
  tokens: { verify: (t: string) => SIDECAR_TOKENS[t] ?? (TOKENS[t] ? { instanceId: TOKENS[t] } : null) },
  getInstance: (id: string) => instances[id],
  getInstancesByApp: (appId: string) => Object.values(instances).filter((i) => i.appId === appId),
  getAllInstances: () => Object.values(instances),
  getManifest: (id: string) => (scopes[id] ? { scopeId: scopes[id] } : undefined),
  isTrustedSystemCopy: (id: string) => scopes[id] === 'system',
  getActivity: () => undefined,
  registry: { getById: (id: string) => (scopes[id] ? { id } : undefined) },
} as unknown as ObserverManager;

const authorizer = new Authorizer({
  grants: { get: async (s: { id: string }, p: string) => (s.id === TERMINALX && p === 'terminal.sessions.list' ? { appScope: 'user', installationId: 'inst-1' } : null) } as never,
  declared: (id: string) => declared[id],
  appBinding: async (id: string) => ({ scope: scopes[id], installationId: scopes[id] ? 'inst-1' : null }),
});

// The owner's login: cookie `sess=ok` names live session s-live.
const OWNER_SID = 's-live';
const login: NonNullable<AuthDeps['login']> = {
  cookieToken: (request) => /(?:^|;\s*)sess=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null,
  userSession: async (token) => (token === 'ok' ? { sessionId: OWNER_SID, userId: 'default', role: 'owner' as const } : null),
};

// D45: the App Host services behind a trusted UI's owner claim.
const ownerServices = (async () => ({
  registry: { getInstallation: async (id: string) => (id === 'inst-settings' ? { appId: SETTINGS, scope: 'system', state: 'active' } : null) },
  sessionLive: async (sid: string) => (sid === OWNER_SID ? ({ role: 'owner' as const }) : false as const),
})) as unknown as GatewayOwnerDeps['services'];

// D89 B6: the Terminal container's address on the app network: no identity any more.
const TERMINAL_PEER = '172.20.0.7';

let dataDir = '';
let tickets: FileSetupTickets;

before(() => {
  process.env[ACCESS_MODE_ENV] = 'enforce';
  dataDir = mkdtempSync(join(tmpdir(), 'aura-enforce-smoke-'));
  tickets = new FileSetupTickets({ dir: defaultSetupTicketDir(dataDir) });
});
after(() => {
  delete process.env[ACCESS_MODE_ENV];
  rmSync(dataDir, { recursive: true, force: true });
});

const authDeps = (): AuthDeps => ({
  mgr: mgr as unknown as AuthDeps['mgr'],
  apiKeys: { verify: async () => null },
  login,
  ownerServices,
  operatorTickets: tickets,
});

const gateDeps = (): GateDeps => ({
  authorizer,
  ownerAgent: (p) => isTrustedOwnerAgent(p, mgr as never),
  mgr: () => mgr,
  services: () => null,
  redisReady: () => false,
  internalSecret: () => 'internal-secret',
  instanceOwner: (id) => ((mgr as unknown as { getInstance(id: string): { owner?: string } | undefined }).getInstance(id)?.owner ?? null),
  principal: (request) => resolveCaller(request, authDeps()),
  // No `mode`: the gate reads AURA_ACCESS_ENFORCE, as on the shell.
});

// ── requests ────────────────────────────────────────────────────────────────

interface Call { method?: string; path: string; route: string; params?: Record<string, string>; body?: unknown; headers?: Record<string, string>; peer?: string }

function ctx(c: Call) {
  const url = new URL(c.path, 'http://127.0.0.1:3000');
  const request = new Request(url, {
    method: c.method ?? 'GET',
    headers: { ...(c.body !== undefined ? { 'content-type': 'application/json' } : {}), ...c.headers },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
  return { request, url, routePattern: c.route, params: c.params ?? {}, clientAddress: c.peer };
}

/** The middleware's answer before the route runs: 'pass', or the refusal's status and error. */
async function middleware(c: Call): Promise<string> {
  const context = ctx(c);
  if (context.request.headers.has(GATEWAY_IDENTITY_HEADER)) {
    const refusedAtGateway = await enforceGateway(context, {
      mgr, decide: createDecide({ authorizer }), ownerServices, audit: async () => undefined,
    });
    if (refusedAtGateway) return `${refusedAtGateway.status} ${(await refusedAtGateway.json() as { error: string }).error}`;
  }
  const r = await accessGate(context, gateDeps());
  if (!r.refused) return 'pass';
  return `${r.refused.status} ${(await r.refused.json() as { error: string }).error}`;
}

const desktop = { cookie: 'sess=ok', origin: 'http://127.0.0.1:3000' };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
/** `docker exec aura-shell aura …`: a fresh one-time ticket for exactly this request (aura-cli lib/identity.ts). */
const operator = (method: string, path: string) => ({
  'x-aura-operator': createSetupTicket(dataDir, { purpose: 'operator', subject: operatorRequestSubject(method, path) }).code,
});
function gatewayClaim(appId: string, method: string, path: string, over: Partial<GatewayIdentityClaim> = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    v: 1, appId, installationId: `inst-${appId}`, instanceId: `${appId}-1`, label: 'main', slot: 1,
    origin: `http://${appId}.apps.test`, userId: 'default', method, path, iat, exp: iat + 30, ...over,
  } as GatewayIdentityClaim;
  return { [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(claim) };
}

const APPROVAL = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
const THEME_PUT: Call = { method: 'PUT', path: '/api/kv/os/theme', route: '/api/kv/[...path]', params: { path: 'os/theme' }, body: { value: {} } };
const INSTALL: Call = { method: 'POST', path: '/api/nexus/install', route: '/api/nexus/install', body: { ref: 'notes', scope: 'user' } };
const APPS: Call = { path: '/api/apps', route: '/api/apps' };

// ── allowed ─────────────────────────────────────────────────────────────────

test('enforce: the owner desktop works on its login', async () => {
  for (const c of [
    APPS,
    { method: 'POST', path: '/api/os/clients', route: '/api/os/clients', body: { lock: 'unlocked' } },
    { path: '/api/os/about', route: '/api/os/about' },
    { path: '/api/kv/os/theme', route: '/api/kv/[...path]', params: { path: 'os/theme' } },
    THEME_PUT,
    { path: '/api/approvals', route: '/api/approvals' },
    INSTALL,
  ] as Call[]) {
    assert.equal(await middleware({ ...c, headers: desktop }), 'pass', `${c.method ?? 'GET'} ${c.path}`);
  }
});

test('enforce: App Host gateway calls: an app on its own rules, Settings as the owner (D45)', async () => {
  const themes = { path: '/api/os/themes', route: '/api/os/themes' };
  assert.equal(await middleware({ ...themes, headers: gatewayClaim(COUNTER, 'GET', themes.path) }), 'pass');
  const own = { path: `/api/kv/app/${COUNTER}/k`, route: '/api/kv/[...path]', params: { path: `app/${COUNTER}/k` } };
  assert.equal(await middleware({ ...own, headers: gatewayClaim(COUNTER, 'GET', own.path) }), 'pass');
  // D46: its own storage only with the declaration: Counter declares storage.read, not storage.write.
  assert.equal(await middleware({ ...own, method: 'PUT', headers: gatewayClaim(COUNTER, 'PUT', own.path) }), '403 gateway-denied');
  const asOwner = gatewayClaim(SETTINGS, 'PUT', THEME_PUT.path, { installationId: 'inst-settings', owner: { userId: 'default', sid: OWNER_SID } } as Partial<GatewayIdentityClaim>);
  assert.equal(await middleware({ ...THEME_PUT, headers: asOwner }), 'pass');
});

test('enforce: the System Terminal CLI and agents, by the Terminal instance token (D29)', async () => {
  const t = bearer('aura1.terminal');
  assert.equal(await middleware({ ...APPS, headers: t }), 'pass');
  assert.equal(await middleware({ ...INSTALL, headers: t }), 'pass', 'the Terminal asks; the handler wants the approval');
  assert.equal(await middleware({ path: `/api/approvals/${APPROVAL}`, route: '/api/approvals/[id]', params: { id: APPROVAL }, headers: t }), 'pass');
});

test('enforce: the host operator CLI, by its one-time ticket', async () => {
  for (const c of [
    APPS,
    INSTALL,
    { method: 'POST', path: `/api/approvals/${APPROVAL}/approve`, route: '/api/approvals/[id]/[decision]', params: { id: APPROVAL, decision: 'approve' }, body: { operatorCode: 'x' } },
    { method: 'DELETE', path: `/api/approvals/blocked/${COUNTER}`, route: '/api/approvals/blocked/[appId]', params: { appId: COUNTER }, body: {} },
    THEME_PUT,
  ] as Call[]) {
    const method = c.method ?? 'GET';
    assert.equal(await middleware({ ...c, headers: operator(method, c.path) }), 'pass', `${method} ${c.path}`);
  }
});

test('enforce: agent MCP: from the Terminal by its token (D89 B5/B6; tokenless from its address no more), and aurashelld by its token', async () => {
  const mcp = { method: 'POST', path: '/api/proxy/com.aura.docs/mcp', route: '/api/proxy/[id]/[...path]', params: { id: 'com.aura.docs', path: 'mcp' }, body: {} };
  assert.equal(await middleware({ ...mcp, peer: TERMINAL_PEER }), '401 unauthenticated', 'an address is no caller');
  assert.equal(await middleware({ ...mcp, peer: TERMINAL_PEER, headers: bearer('aura1.terminal') }), 'pass');
  assert.equal(await middleware({ ...mcp, headers: bearer('aura1.counter') }), 'pass', 'any app by its own token reaches another app\'s MCP');
  const ui = { method: 'POST', path: '/api/os/ui/command', route: '/api/os/ui/command', body: { command: 'noop' } };
  assert.equal(await middleware({ ...ui, headers: bearer('aura1.aurashelld') }), 'pass');
});

test('enforce: SelfUpdater\'s health probe is public; the about route it used is not', async () => {
  assert.equal(await middleware({ path: '/api/auth/status', route: '/api/auth/status' }), 'pass');
  assert.equal(await middleware({ path: '/api/os/about', route: '/api/os/about' }), '401 unauthenticated');
});

// ── refused ─────────────────────────────────────────────────────────────────

test('enforce: an anonymous caller gets nothing but the public routes', async () => {
  for (const c of [
    APPS, INSTALL, THEME_PUT,
    { method: 'POST', path: '/api/os/clients', route: '/api/os/clients', body: {} },
    { method: 'POST', path: '/api/proxy/com.aura.docs/mcp', route: '/api/proxy/[id]/[...path]', params: { id: 'com.aura.docs', path: 'mcp' }, body: {}, peer: '10.9.9.9' },
  ] as Call[]) {
    assert.equal(await middleware(c), '401 unauthenticated', `${c.method ?? 'GET'} ${c.path}`);
  }
});

test('enforce: Counter reaches no owner route, by token or through its App Host', async () => {
  const t = bearer('aura1.counter');
  assert.equal(await middleware({ ...APPS, headers: t }), '403 access-denied');
  assert.equal(await middleware({ ...INSTALL, headers: t }), '403 access-denied', 'D31: no install from an ordinary app');
  assert.equal(await middleware({ ...THEME_PUT, headers: t }), '403 access-denied', 'system.kv.os.theme.write is declared, not granted');
  assert.equal(await middleware({ ...APPS, headers: gatewayClaim(COUNTER, 'GET', APPS.path) }), '403 gateway-denied');
  const other = { path: `/api/kv/app/${SETTINGS}/k`, route: '/api/kv/[...path]', params: { path: `app/${SETTINGS}/k` } };
  assert.equal(await middleware({ ...other, headers: t }), '403 access-denied');
});

test('enforce: an operator ticket is good once, for its own request only', async () => {
  const h = operator('GET', '/api/apps');
  assert.equal(await middleware({ ...APPS, headers: h }), 'pass');
  assert.equal(await middleware({ ...APPS, headers: h }), '401 unauthenticated', 'used up');
  assert.equal(await middleware({ ...INSTALL, headers: operator('GET', '/api/apps') }), '401 unauthenticated', 'another request');
  assert.equal(await middleware({ ...APPS, headers: { 'x-aura-operator': 'AAAAA-AAAAA-AAAAA-AAAAA' } }), '401 unauthenticated');
});

// The live smoke tool (tools/smoke), run in the master as the deploy does.
const smokeLib = (file: string) => import(String(new URL(`../../../tools/smoke/lib/${file}`, import.meta.url)));
const SMOKE_ROUTES: Array<[RegExp, string, (m: RegExpExecArray) => Record<string, string>]> = [
  [/^\/api\/apps\/([^/]+)\/instances$/, '/api/apps/[id]/instances', (m) => ({ id: m[1]! })],
  [/^\/api\/instances\/([^/]+)\/(status|sidecars|mounts|ports)$/, '/api/instances/[instanceId]/$2', (m) => ({ instanceId: m[1]! })],
  [/^\/api\/proxy\/([^/]+)\/(.+)$/, '/api/proxy/[id]/[...path]', (m) => ({ id: m[1]!, path: m[2]! })],
];
function smokeCall(path: string): Call {
  const pathname = path.split('?')[0]!;
  for (const [re, route, params] of SMOKE_ROUTES) {
    const m = re.exec(pathname);
    if (m) return { path, route: route.replace('$2', m[2] ?? ''), params: params(m) };
  }
  return { path, route: pathname };
}

test('enforce: the smoke tool in the master is the host operator on every request it may send, the Terminal proxy included', async () => {
  const { ALLOWED_LIVE_REQUESTS } = await smokeLib('guard.mjs');
  const { loadOperatorIdentity } = await smokeLib('operator.mjs');
  const target = 'http://127.0.0.1:3000';
  const { identity } = await loadOperatorIdentity(target, { env: { AURA_DATA_DIR: dataDir }, tickets: setupTickets });
  assert.ok(identity);
  for (const r of ALLOWED_LIVE_REQUESTS as Array<{ method: string; path?: string; template?: string }>) {
    const path = r.path ?? r.template!.replace(/\{\w+\}/, `${TERMINAL}-1`);
    const call = smokeCall(path);
    assert.equal(await middleware(call), '401 unauthenticated', `anonymous ${path}`);
    assert.equal(await middleware({ ...call, headers: identity(r.method, path) }), 'pass', `operator ${path}`);
  }
  // Never from a sandbox, never to another origin: then it stays anonymous, as before.
  for (const [t, env] of [[target, { AURA_INSTANCE_TOKEN: 'x' }], ['http://10.0.0.9:3000', {}], [target, { OS_API_BASE: 'http://aura-shell:3000' }]] as const) {
    assert.equal((await loadOperatorIdentity(t, { env: { ...env, AURA_DATA_DIR: dataDir }, tickets: setupTickets })).identity, null, `${t} ${JSON.stringify(env)}`);
  }
  // The proxy never hands the (used) ticket on to the app.
  const headers = new Headers({ ...identity('GET', '/api/proxy/x/y'), accept: 'x' });
  stripShellCredentials(headers, 'test');
  assert.equal(headers.get('x-aura-operator'), null);
  assert.equal(headers.get('accept'), 'x');
});

test('enforce: an install without the owner\'s approval is not approved', async () => {
  const binding = { action: 'nexus.install', appId: 'com.example.notes', digest: 'sha256:abc', scope: 'user', permissions: [] } as unknown as InstallBinding;
  const asked = (principal: AccessPrincipal) => installGate({} as never, principal, new Request('http://127.0.0.1:3000/api/nexus/install', { method: 'POST' }), undefined);
  // Through the gate, the Terminal and the operator reach the handler; nothing in their request approves it.
  assert.equal(await asked({ kind: 'instance', appId: TERMINAL, instanceId: `${TERMINAL}-1`, verification: 'verified' }).approval(binding), false);
  assert.equal(await asked({ kind: 'operator', verification: 'verified' }).approval(binding), false);
});

// ── the gaps closed in integration ──────────────────────────────────────────

test('the report peeks at an operator ticket; the gate and the route share one claim', async () => {
  const { resolvePrincipal } = await import('../src/lib/access/identify.ts');
  const h = operator('GET', '/api/apps');
  const request = new Request('http://127.0.0.1:3000/api/apps', { headers: h });
  const base = { mgr: null, apiKeys: null, login: null };
  // The access report (observer.ts) only peeks: the ticket stays.
  assert.equal((await resolvePrincipal(request, { ...base, operatorTickets: { peek: tickets.peek.bind(tickets) } })).via, 'operator-ticket');
  let claims = 0;
  const counting = { claim: (code: string, p: 'operator') => { claims += 1; return tickets.claim(code, p); } };
  const first = await resolvePrincipal(request, { ...base, operatorTickets: counting });
  const again = await resolvePrincipal(request, { ...base, operatorTickets: counting });
  assert.deepEqual(first, { principal: { kind: 'operator', verification: 'verified' }, via: 'operator-ticket' });
  assert.deepEqual(again, first);
  assert.equal(claims, 1, 'claimed once per request');
  // A bearer wins: the header is not even read.
  const withBearer = new Request('http://127.0.0.1:3000/api/apps', { headers: { ...operator('GET', '/api/apps'), ...bearer('aura1.counter') } });
  assert.equal((await resolveCaller(withBearer, authDeps())).principal.kind, 'instance');
});

test('the admin grants list does not show Settings\' D45 KV permissions as waiting for a grant', async () => {
  const { asOwnerPermissions } = await import('../src/pages/api/admin/grants.ts');
  const perms = ['system.kv.os.theme.write', 'notifications.popup'];
  assert.deepEqual(asOwnerPermissions(SETTINGS, 'system', perms), ['system.kv.os.theme.write']);
  assert.deepEqual(asOwnerPermissions(SETTINGS, 'user', perms), [], 'a same-id copy is not Settings');
  assert.deepEqual(asOwnerPermissions(COUNTER, 'system', perms), []);
  assert.deepEqual(asOwnerPermissions('com.aura.nexus', 'system', perms), [], 'Nexus has no kv group');
});

test('a fresh approval over HTTP says to use HTTPS or the host (D18)', async () => {
  const { decisionErrorText, operatorRequiredText } = await import('../src/lib/approvals/dialogClient.ts');
  assert.equal(operatorRequiredText(APPROVAL), `This needs HTTPS, or approve on the host with \`aura approve ${APPROVAL}\`.`);
  assert.equal(decisionErrorText('operator-required', APPROVAL), operatorRequiredText(APPROVAL));
});

// ── Stage 3 (VM report run): would-denies decided ───────────────────────────

/** The same request with AURA_ACCESS_ENFORCE=report. */
async function inReport(c: Call): Promise<string> {
  process.env[ACCESS_MODE_ENV] = 'report';
  try { return await middleware(c); } finally { process.env[ACCESS_MODE_ENV] = 'enforce'; }
}

const CONTEXT: Call = { path: '/api/os/context', route: '/api/os/context' };
const START_TERMINAL: Call = { method: 'POST', path: `/api/apps/${TERMINAL}/start`, route: '/api/apps/[id]/start', params: { id: TERMINAL } };

test('enforce: Counter reads no Aura Context keys and starts no Terminal; report mode keeps today\'s 200', async () => {
  const t = bearer('aura1.counter');
  for (const c of [CONTEXT, START_TERMINAL]) {
    assert.equal(await middleware({ ...c, headers: t }), '403 access-denied', `${c.method ?? 'GET'} ${c.path}`);
    assert.equal(await middleware({ ...c, headers: gatewayClaim(COUNTER, c.method ?? 'GET', c.path) }), '403 gateway-denied');
    assert.equal(await middleware({ ...c, headers: desktop }), 'pass', 'the owner');
    assert.equal(await middleware({ ...c, headers: bearer('aura1.terminal') }), 'pass', 'the System Terminal CLI (D29)');
    assert.equal(await inReport({ ...c, headers: t }), 'pass', 'report: counted as would-deny, not refused');
  }
});

test('enforce (D50): the owner\'s management routes take the owner, the operator and the System Terminal; other apps never, in any mode', async () => {
  for (const c of [
    { path: '/api/admin/access-report', route: '/api/admin/access-report' },
    { path: '/api/admin/grants', route: '/api/admin/grants' },
    { method: 'POST', path: '/api/admin/grants', route: '/api/admin/grants', body: { subjectId: COUNTER, permission: 'notifications.popup' } },
    { method: 'POST', path: '/api/admin/manifest-edit', route: '/api/admin/manifest-edit', body: { appId: COUNTER, action: 'add-tool', tool: 'git' } },
  ] as Call[]) {
    const method = c.method ?? 'GET';
    const what = `${method} ${c.path}`;
    assert.equal(await middleware({ ...c, headers: operator(method, c.path) }), 'pass', `operator ${what}`);
    assert.equal(await inReport({ ...c, headers: operator(method, c.path) }), 'pass', `report: operator ${what}`);
    // The route then asks the owner's approval (lib/approvals/admin.ts).
    assert.equal(await middleware({ ...c, headers: bearer('aura1.terminal') }), 'pass', `System Terminal ${what}`);
    assert.equal(await middleware({ ...c, headers: desktop }), 'pass', `the owner's login ${what}`);
    assert.equal(await middleware({ ...c, headers: gatewayClaim(SETTINGS, method, c.path, { installationId: 'inst-settings', owner: { userId: 'default', sid: OWNER_SID } } as Partial<GatewayIdentityClaim>) }), 'pass', `Settings ${what}`);
    for (const app of ['aura1.counter', 'aura1.terminalx']) {
      assert.equal(await middleware({ ...c, headers: bearer(app) }), '403 access-denied', `${app} ${what}`);
      assert.equal(await inReport({ ...c, headers: bearer(app) }), '403 access-denied', `report: ${app} ${what}`);
    }
    assert.equal(await middleware(c), '401 unauthenticated', `anonymous ${what}`);
    assert.equal(await middleware({ ...c, headers: bearer('aura-admin1.retired.token') }), '401 unauthenticated', `retired admin bearer ${what}`);
  }
});

test('enforce: apps send intents; only the System Terminal and the owner carry a command', async () => {
  const intent = (body: unknown): Call => ({ method: 'POST', path: '/api/intents/start', route: '/api/intents/start', body });
  const view = intent({ action: 'aura.intent.action.VIEW', uri: 'http://com.example.counter.apps.test/' });
  const embed = intent({ action: 'aura.intent.action.OPEN_TERMINAL', appId: TERMINAL, extras: { background: true } });
  const command = intent({ action: 'aura.intent.action.OPEN_TERMINAL', extras: { command: 'ls' } });
  const selfIntent = intent({ action: 'com.example.counter.action.OPEN_LIVE', appId: COUNTER, instanceId: `${COUNTER}-1` });
  for (const [c, h] of [
    [view, bearer('aura1.counter')], [embed, bearer('aura1.terminalx')], [command, bearer('aura1.terminal')],
    [view, gatewayClaim(COUNTER, 'POST', '/api/intents/start')], [command, desktop],
  ] as const) {
    assert.equal(await middleware({ ...c, headers: h }), 'pass');
  }
  assert.equal(await middleware({ ...command, headers: bearer('aura1.counter') }), '403 access-denied', '5.16: command is the System Terminal\'s');
  assert.equal(await middleware(view), '401 unauthenticated');
  // Report mode: the command variant holds in every mode, so the gate reads
  // the body and hands the report the variant it settled.
  process.env[ACCESS_MODE_ENV] = 'report';
  try {
    const settled = async (c: Call, headers: Record<string, string>) => {
      const r = await accessGate(ctx({ ...c, headers }), gateDeps());
      return [r.refused?.status ?? 'pass', r.bodyVariant];
    };
    assert.deepEqual(await settled(view, bearer('aura1.counter')), ['pass', null]);
    assert.deepEqual(await settled(embed, bearer('aura1.terminalx')), ['pass', null]);
    assert.deepEqual(await settled(command, bearer('aura1.counter')), [403, 'terminal-command']);
    assert.deepEqual(await settled(command, bearer('aura1.terminal')), ['pass', 'terminal-command']);
    // Steel's live view: an explicit intent to itself, no extras (io.lakner.steelaibrowser src/lib/live-view.ts).
    assert.deepEqual(await settled(selfIntent, bearer('aura1.counter')), ['pass', null]);
  } finally {
    process.env[ACCESS_MODE_ENV] = 'enforce';
  }
  assert.equal(await middleware({ ...selfIntent, headers: bearer('aura1.counter') }), 'pass');
  // A gateway call is decided at the gateway; the report still gets the settled variant (else: ambiguous-rule).
  const viaGateway = await accessGate(ctx({ ...view, headers: gatewayClaim(COUNTER, 'POST', '/api/intents/start') }), gateDeps());
  assert.deepEqual([viaGateway.refused, viaGateway.bodyVariant], [null, null]);
  // One refused at the gateway never reaches the gate: the middleware hands the report its variant (reportBodyVariant).
  const counterCommand = { ...command, headers: gatewayClaim(COUNTER, 'POST', '/api/intents/start') };
  assert.equal(await middleware(counterCommand), '403 gateway-denied');
  assert.equal(await reportBodyVariant(ctx(counterCommand)), 'terminal-command');
  assert.equal(await reportBodyVariant(ctx({ ...view, headers: gatewayClaim(COUNTER, 'POST', '/api/intents/start') })), null);
  assert.equal(await reportBodyVariant(ctx({ path: '/api/apps', route: '/api/apps', headers: gatewayClaim(COUNTER, 'GET', '/api/apps') })), undefined);
});

test('enforce: TerminalX\'s agent watch by its list grant; another app none, in report mode too', async () => {
  const events: Call = { path: `/api/terminal/sessions/events?instance=${TERMINAL}-1`, route: '/api/terminal/sessions/events' };
  const hooks: Call = { method: 'POST', path: `/api/terminal/agent-hooks?instance=${TERMINAL}-1`, route: '/api/terminal/agent-hooks' };
  const instancesOf = (id: string): Call => ({ path: `/api/apps/${id}/instances`, route: '/api/apps/[id]/instances', params: { id } });
  for (const c of [events, hooks, instancesOf(TERMINAL)]) {
    assert.equal(await middleware({ ...c, headers: bearer('aura1.terminalx') }), 'pass', c.path);
    assert.equal(await middleware({ ...c, headers: gatewayClaim(TERMINALX, c.method ?? 'GET', c.path) }), 'pass', `gateway ${c.path}`);
    assert.equal(await middleware({ ...c, headers: bearer('aura1.terminal') }), 'pass', `System Terminal ${c.path}`);
    assert.equal(await middleware({ ...c, headers: bearer('aura1.counter') }), '403 access-denied', `Counter ${c.path}`);
  }
  assert.equal(await middleware({ ...instancesOf(COUNTER), headers: bearer('aura1.terminalx') }), '403 access-denied', 'the grant names the Terminal only');
  for (const c of [events, hooks]) {
    assert.equal(await inReport({ ...c, headers: bearer('aura1.counter') }), '403 access-denied', `report: ${c.path} is new, held to its rule`);
    assert.equal(await inReport(c), '401 unauthenticated');
    assert.equal(await inReport({ ...c, headers: bearer('aura1.terminalx') }), 'pass');
  }
});

// ── D45: a trusted system UI's server-side page reads ───────────────────────

/** What the router hands Settings' server with a page request on the owner's live session (app-hosts.mjs `ownerSsrHeader`). */
const ownerSsr = (over: Partial<{ appId: string; installationId: string; instanceId: string; userId: string; sid: string }> = {}) => ({
  [OWNER_SSR_HEADER]: signOwnerSsrClaim({
    appId: SETTINGS, installationId: 'inst-settings', instanceId: `${SETTINGS}-1`, userId: 'default', sid: OWNER_SID, ...over,
  }),
});
const SSR_READS: Call[] = [
  APPS,
  { path: '/api/apps/serve', route: '/api/apps/serve' },
  { path: '/api/os/context', route: '/api/os/context' },
  { path: '/api/os/volumes', route: '/api/os/volumes' },
  { path: '/api/scopes', route: '/api/scopes' },
  { path: '/api/os/about', route: '/api/os/about' },
];

test('enforce: Settings\' page render reads as the owner with its token and the router\'s owner claim (D45)', async () => {
  for (const c of SSR_READS) {
    assert.equal(await middleware({ ...c, headers: { ...bearer('aura1.settings'), ...ownerSsr() } }), 'pass', c.path);
    // What it got before: nothing (401), and its token alone does not make the owner.
    assert.equal(await middleware(c), '401 unauthenticated', `anonymous ${c.path}`);
    assert.equal(await middleware({ ...c, headers: bearer('aura1.settings') }), '403 access-denied', `token alone ${c.path}`);
  }
  const resolved = await resolveCaller(ctx({ ...APPS, headers: { ...bearer('aura1.settings'), ...ownerSsr() } }).request, authDeps());
  assert.deepEqual(resolved.principal, {
    kind: 'user', userId: 'default', role: 'owner', sessionId: OWNER_SID, verification: 'verified', systemId: SYS,
    through: { appId: SETTINGS, instanceId: `${SETTINGS}-1` },
  });
});

test('enforce: the owner SSR claim grants nothing on its own, replayed, stale, for a mutation or another app', async () => {
  const expired = (() => {
    const iat = Math.floor(Date.now() / 1000) - 120;
    return {
      [OWNER_SSR_HEADER]: signGatewayClaim({
        v: 1, use: 'owner-ssr', appId: SETTINGS, installationId: 'inst-settings', instanceId: `${SETTINGS}-1`,
        userId: 'default', owner: { userId: 'default', sid: OWNER_SID }, iat, exp: iat + 60,
      } as unknown as GatewayIdentityClaim),
    };
  })();
  // Flip the signature's first character: it carries 6 full bits of the MAC's first byte. (The last
  // base64url character of a 32-byte MAC is mostly padding bits, so flipping it could still verify.)
  const forged = (() => {
    const [prefix, payload, sig = ''] = ownerSsr()[OWNER_SSR_HEADER].split('.');
    assert.ok(sig.length > 1);
    return { [OWNER_SSR_HEADER]: `${prefix}.${payload}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}` };
  })();
  for (const c of SSR_READS) {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['no instance token', ownerSsr(), '401 unauthenticated'],
      ['on the desktop login it is ignored too', { ...desktop, ...ownerSsr({ sid: 's-gone' }) }, 'pass'],
      ['expired', { ...bearer('aura1.settings'), ...expired }, '403 access-denied'],
      ['forged signature', { ...bearer('aura1.settings'), ...forged }, '403 access-denied'],
      ['replayed by another instance', { ...bearer('aura1.counter'), ...ownerSsr() }, '403 access-denied'],
      ['Counter\'s own claim', { ...bearer('aura1.counter'), ...ownerSsr({ appId: COUNTER, instanceId: `${COUNTER}-1`, installationId: `inst-${COUNTER}` }) }, '403 access-denied'],
      ['a sidecar\'s token', { ...bearer('aura1.settings-db'), ...ownerSsr() }, '403 access-denied'],
      ['session no longer live', { ...bearer('aura1.settings'), ...ownerSsr({ sid: 's-gone' }) }, '403 access-denied'],
      ['a user-scope copy\'s installation', { ...bearer('aura1.settings'), ...ownerSsr({ installationId: 'inst-settings-user' }) }, '403 access-denied'],
    ];
    for (const [why, headers, want] of cases) {
      assert.equal(await middleware({ ...c, headers }), want, `${why}: ${c.path}`);
    }
  }
  // Reads only: a mutation stays on Settings' instance rules, even on an owner route Settings covers.
  const enable: Call = { method: 'POST', path: '/api/admin/apps/enabled', route: '/api/admin/apps/enabled', body: { appId: COUNTER, enabled: false } };
  assert.equal(await middleware({ ...enable, headers: { ...bearer('aura1.settings'), ...ownerSsr() } }), '403 access-denied');
  // Never a target the owner keeps out of apps, though the route is in Settings' D45 scope.
  const approvals: Call = { path: '/api/approvals', route: '/api/approvals' };
  assert.equal(await middleware({ ...approvals, headers: desktop }), 'pass');
  assert.equal(await middleware({ ...approvals, headers: { ...bearer('aura1.settings'), ...ownerSsr() } }), '403 access-denied');
  // Nor a path outside Settings' D45 scope.
  assert.equal(await middleware({ ...INSTALL, headers: { ...bearer('aura1.settings'), ...ownerSsr() } }), '403 access-denied');
});
