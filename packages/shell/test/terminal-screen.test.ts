// `GET /api/terminal/sessions/screen` (5.16): derived screen facts for an app
// holding terminal.sessions.list AND terminal.screen.read, over fake grants
// and a fake Terminal instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCREEN_READS_PER_MINUTE, createScreenStateRoute, screenFacts } from '../src/lib/terminalScreen.ts';
import { createTerminalAccess, terminalSessionInstance } from '../server/terminal-embed.mjs';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';

const TERMINAL = 'com.aura.terminal';
const TX = 'io.lakner.terminalx';
const COUNTER = 'io.example.counter';
const SESSION = 'com.aura.terminal-2#a3';
const ROWS = ['✻ Thinking… (esc to interrupt)', 'secret: hunter2'];

function route(opts: { grants?: Record<string, string[]>; listed?: string[] | null; now?: () => number } = {}) {
  const grants = opts.grants ?? { [TX]: ['terminal.sessions.list', 'terminal.screen.read'] };
  const access = createTerminalAccess({
    systemCopy: async (appId: string) => appId === TERMINAL,
    authorize: async (appId: string, permission: string) => (grants[appId] ?? []).includes(permission),
    sessionGrant: async () => null,
    sessionLife: async () => null,
  });
  const reads: string[] = [];
  const handle = createScreenStateRoute({
    caller: async (request) => {
      const who = request.headers.get('x-test-app');
      const user = request.headers.get('x-test-user');
      return who === 'invalid' ? 'invalid' : who ? { app: { appId: who }, key: `app:${who}` } : { app: null, key: user ? `user:${user}` : 'operator' };
    },
    isSystemTerminal: access.isSystemTerminal,
    mayReadScreens: access.mayReadScreens,
    sessionInstance: (id) => terminalSessionInstance(id) ?? null,
    listed: async (instanceId) => (instanceId === 'com.aura.terminal-2' ? ('listed' in opts ? opts.listed! : [SESSION]) : null),
    screen: async (_instanceId, sessionId) => { reads.push(sessionId); return ROWS; },
    now: opts.now,
  });
  const call = async (app: string | null, id: string | null = SESSION, user?: string) => {
    const url = `http://shell/api/terminal/sessions/screen${id === null ? '' : `?id=${encodeURIComponent(id)}`}`;
    const res = await handle(new Request(url, { headers: { ...(app ? { 'x-test-app': app } : {}), ...(user ? { 'x-test-user': user } : {}) } }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { call, reads };
}

test('with both grants: the derived facts of a listed session, never its rows', async () => {
  const r = route();
  const { status, body } = await r.call(TX);
  assert.equal(status, 200);
  assert.deepEqual(body, { id: SESSION, busy: true, codex: false });
  assert.ok(!JSON.stringify(body).includes('hunter2'));
  assert.deepEqual(screenFacts('x#a1', ['>_ OpenAI Codex', '> ']), { id: 'x#a1', busy: false, codex: true });
});

test('refused without terminal.screen.read, without the list grant, and for another app', async () => {
  assert.equal((await route({ grants: { [TX]: ['terminal.sessions.list'] } }).call(TX)).status, 403);
  assert.equal((await route({ grants: { [TX]: ['terminal.screen.read'] } }).call(TX)).status, 403, 'needs the list grant too');
  const r = route();
  const other = await r.call(COUNTER);
  assert.equal(other.status, 403);
  assert.equal(other.body.error, 'not-granted');
  assert.equal((await r.call('invalid')).status, 401);
  assert.deepEqual(r.reads, [], 'no screen was read for a refused caller');
});

test('refused for a session its instance does not list, a stopped instance and a bad id', async () => {
  const r = route({ listed: ['com.aura.terminal-2#a1'] });
  const unlisted = await r.call(TX);
  assert.deepEqual([unlisted.status, unlisted.body.error], [404, 'unknown-session']);
  assert.deepEqual(r.reads, []);
  assert.equal((await route().call(TX, 'com.aura.terminal-7#a1')).body.error, 'instance-not-running');
  for (const bad of [null, 'io.evil.app-1#a1', 'com.aura.terminal-2']) assert.equal((await route().call(TX, bad)).status, 400, String(bad));
});

test('the System Terminal needs no grant; other callers without an app identity are left to the manifest rule', async () => {
  const r = route({ grants: {} });
  assert.equal((await r.call(TERMINAL)).status, 200);
  assert.equal((await r.call(null)).status, 200);
  const rule = ROUTE_ACCESS_MANIFEST.routes['/api/terminal/sessions/screen']?.methods?.GET;
  assert.ok(rule);
  assert.deepEqual([...rule.allow], ['app-permission', 'owner']);
  assert.deepEqual([...(rule.permissions ?? [])], ['terminal.sessions.list', 'terminal.screen.read']);
});

test('polling is rate-limited per caller app, and the window resets', async () => {
  let t = 1_000;
  const r = route({ now: () => t });
  for (let i = 0; i < SCREEN_READS_PER_MINUTE; i++) assert.equal((await r.call(TX)).status, 200);
  const over = await r.call(TX);
  assert.deepEqual([over.status, over.body.error], [429, 'rate-limited']);
  t += 60_000;
  assert.equal((await r.call(TX)).status, 200);
});

test('L1: the limit is per caller; callers without an app identity no longer share one bucket; the rule holds in every mode', async () => {
  const r = route({ now: () => 1_000 });
  for (let i = 0; i < SCREEN_READS_PER_MINUTE; i++) assert.equal((await r.call(null, SESSION, 'default')).status, 200);
  assert.equal((await r.call(null, SESSION, 'default')).status, 429);
  assert.equal((await r.call(null)).status, 200, 'the operator has its own bucket');
  assert.equal((await r.call(TX)).status, 200, 'and each app');
  assert.equal(ROUTE_ACCESS_MANIFEST.routes['/api/terminal/sessions/screen']?.methods?.GET?.guard, 'rule');
});

test('the route audits nothing per poll', () => {
  const src = readFileSync(new URL('../src/pages/api/terminal/sessions/screen.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/lib/terminalScreen.ts', import.meta.url), 'utf8');
  assert.ok(!/audit/i.test(src.replace(/Nothing is audited per call/, '')));
});

test('M3: the Terminal routes read the caller from the one resolver: a bad bearer is 401, an API key is held to grants', async () => {
  const { terminalCaller, verifiedAppCaller } = await import('../src/lib/terminalCaller.ts');
  const instances: Record<string, { appId: string; instanceId: string }> = { 'io.lakner.terminalx-1': { appId: 'io.lakner.terminalx', instanceId: 'io.lakner.terminalx-1' } };
  const deps = {
    mgr: {
      getInstance: (id: string) => instances[id],
      getManifest: () => undefined,
      tokens: { verify: (t: string) => (t === 'aura1.good' ? { instanceId: 'io.lakner.terminalx-1' } : null) },
    },
    apiKeys: { verify: async (k: string) => (k === 'aura_k1_good' ? { id: 'k1', name: 'ci', scopes: ['terminal.embed'] } : null) },
  } as never;
  const req = (auth?: string) => new Request('http://shell/api/terminal/sessions', { headers: auth ? { authorization: auth } : {} });
  assert.equal(await terminalCaller(req('Bearer garbage'), deps), 'invalid', 'never "no app identity"');
  assert.equal(await terminalCaller(req('Bearer aura1.forged'), deps), 'invalid');
  assert.equal(await terminalCaller(req('Bearer aura_k1_revoked'), deps), 'invalid', 'a revoked API key');
  assert.equal(await terminalCaller(req('Basic xyz'), deps), 'invalid');
  assert.deepEqual(await terminalCaller(req('Bearer aura1.good'), deps),
    { app: { appId: 'io.lakner.terminalx', instanceId: 'io.lakner.terminalx-1' }, key: 'app:io.lakner.terminalx' });
  const key = await terminalCaller(req('Bearer aura_k1_good'), deps);
  assert.ok(key !== 'invalid' && key.app?.appId === 'api-key:k1', 'an API key is an app with no grants, never unlimited');
  assert.deepEqual(await terminalCaller(req(), deps), { app: null, key: 'anonymous' });
  // The grant check then refuses the key: no app holds grants under that id.
  const access = createTerminalAccess({ scopeOf: async () => 'user', authorize: async () => true, sessionGrant: async () => null, sessionLife: async () => null });
  assert.equal(await access.mayUseSession('api-key:k1', SESSION), false);
  assert.equal(typeof verifiedAppCaller, 'function');
  const src = readFileSync(new URL('../src/lib/terminalCaller.ts', import.meta.url), 'utf8');
  assert.ok(!/tokens\.verify|authorization/i.test(src.replace(/Authorization header/g, '')), 'no second reading of the bearer');
});
