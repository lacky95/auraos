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
    caller: (request) => {
      const who = request.headers.get('x-test-app');
      return who === 'invalid' ? 'invalid' : who ? { appId: who } : null;
    },
    isSystemTerminal: access.isSystemTerminal,
    mayReadScreens: access.mayReadScreens,
    sessionInstance: (id) => terminalSessionInstance(id) ?? null,
    listed: async (instanceId) => (instanceId === 'com.aura.terminal-2' ? ('listed' in opts ? opts.listed! : [SESSION]) : null),
    screen: async (_instanceId, sessionId) => { reads.push(sessionId); return ROWS; },
    now: opts.now,
  });
  const call = async (app: string | null, id: string | null = SESSION) => {
    const url = `http://shell/api/terminal/sessions/screen${id === null ? '' : `?id=${encodeURIComponent(id)}`}`;
    const res = await handle(new Request(url, { headers: app ? { 'x-test-app': app } : {} }));
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

test('the route audits nothing per poll', () => {
  const src = readFileSync(new URL('../src/pages/api/terminal/sessions/screen.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/lib/terminalScreen.ts', import.meta.url), 'utf8');
  assert.ok(!/audit/i.test(src.replace(/Nothing is audited per call/, '')));
});
