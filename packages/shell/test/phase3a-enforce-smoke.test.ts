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
import { createSetupTicket, defaultSetupTicketDir, FileSetupTickets, operatorRequestSubject } from '@aura/core/setup-tickets';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { signGatewayClaim } from '../server/gateway-identity.mjs';
import { ACCESS_MODE_ENV } from '../server/access-mode.mjs';
import { createDecide } from '../src/lib/access/decide.ts';
import { accessGate, type GateDeps } from '../src/lib/access/enforce.ts';
import { enforceGateway } from '../src/lib/access/gatewayCaller.ts';
import { isTrustedOwnerAgent, type GatewayOwnerDeps } from '../src/lib/access/identify.ts';
import type { ObserverManager } from '../src/lib/access/observer.ts';
import { installGate } from '../src/lib/approvals/nexus.ts';
import { resolveCaller, type AuthDeps } from '../src/lib/auth.ts';

// ── the system ──────────────────────────────────────────────────────────────

const TERMINAL = 'com.aura.terminal';
const AURASHELLD = 'com.aura.aurashelld';
const SETTINGS = 'com.aura.settings';
const COUNTER = 'com.example.counter';
const TERMINALX = 'io.lakner.terminalx';

const instances: Record<string, { appId: string; instanceId: string; sandbox: string; state: string }> = {};
for (const appId of [TERMINAL, AURASHELLD, SETTINGS, COUNTER, TERMINALX]) {
  instances[`${appId}-1`] = { appId, instanceId: `${appId}-1`, sandbox: 'container', state: 'resumed' };
}
const scopes: Record<string, string> = { [TERMINAL]: 'system', [AURASHELLD]: 'system', [SETTINGS]: 'system', [COUNTER]: 'user', [TERMINALX]: 'user' };
const declared: Record<string, string[]> = {
  [TERMINAL]: [], [AURASHELLD]: [], [SETTINGS]: ['system.kv.os.theme.write'],
  // Declared, never granted: a privileged permission (stream C) does nothing on its own.
  [COUNTER]: ['system.kv.os.theme.write'],
  // Declared and granted by the owner (D29): TerminalX's watcher.
  [TERMINALX]: ['terminal.embed', 'terminal.sessions.list'],
};
const TOKENS: Record<string, string> = {
  'aura1.terminal': `${TERMINAL}-1`, 'aura1.aurashelld': `${AURASHELLD}-1`, 'aura1.counter': `${COUNTER}-1`,
  'aura1.terminalx': `${TERMINALX}-1`,
};
const mgr = {
  tokens: { verify: (t: string) => (TOKENS[t] ? { instanceId: TOKENS[t] } : null) },
  getInstance: (id: string) => instances[id],
  getInstancesByApp: (appId: string) => Object.values(instances).filter((i) => i.appId === appId),
  getAllInstances: () => Object.values(instances),
  getManifest: (id: string) => (scopes[id] ? { scopeId: scopes[id] } : undefined),
  getActivity: () => undefined,
  registry: { getById: (id: string) => (scopes[id] ? { id } : undefined) },
} as unknown as ObserverManager;

const authorizer = new Authorizer({
  grants: { get: async (s: { id: string }, p: string) => (s.id === TERMINALX && p === 'terminal.sessions.list' ? { appScope: 'user' } : null) } as never,
  declared: (id: string) => declared[id],
  appScope: (id: string) => scopes[id],
});

// The owner's login: cookie `sess=ok` names live session s-live.
const OWNER_SID = 's-live';
const login: NonNullable<AuthDeps['login']> = {
  cookieToken: (request) => /(?:^|;\s*)sess=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null,
  ownerSession: async (token) => (token === 'ok' ? { sessionId: OWNER_SID, userId: 'default' } : null),
};

// D45: the App Host services behind a trusted UI's owner claim.
const ownerServices = (async () => ({
  registry: { getInstallation: async (id: string) => (id === 'inst-settings' ? { appId: SETTINGS, scope: 'system', state: 'active' } : null) },
  sessionLive: async (sid: string) => sid === OWNER_SID,
})) as unknown as GatewayOwnerDeps['services'];

// D28: the Terminal container's address on the app network.
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
  network: async (peer) => (peer === TERMINAL_PEER
    ? { kind: 'instance', appId: TERMINAL, instanceId: `${TERMINAL}-1`, verification: 'verified' }
    : null),
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

test('enforce: agent MCP: tokenless from the Terminal container (D28), and aurashelld by its token', async () => {
  const mcp = { method: 'POST', path: '/api/proxy/com.aura.docs/mcp', route: '/api/proxy/[id]/[...path]', params: { id: 'com.aura.docs', path: 'mcp' }, body: {} };
  assert.equal(await middleware({ ...mcp, peer: TERMINAL_PEER }), 'pass');
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
  } finally {
    process.env[ACCESS_MODE_ENV] = 'enforce';
  }
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
