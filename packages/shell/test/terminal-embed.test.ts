// Who may use the owner's System Terminal from another app (D25, D29, 5.16):
// the OPEN_TERMINAL extras and the embed `frame-ancestors`, over fake grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_TERMINAL_ACTION, createTerminalAccess, openTerminalRefusal, shareSession, terminalEmbedAncestors, terminalSessionInstance,
} from '../server/terminal-embed.mjs';

const TERMINAL = 'com.aura.terminal';
const TX = 'io.lakner.terminalx';
const COUNTER = 'com.aura.counter';
const SESSION = 'com.aura.terminal-2#a3';

/** Grants: app → permissions; sessions: app → session ids; scopes: app → install scope. */
function access(opts: { grants?: Record<string, string[]>; sessions?: Record<string, string[]>; scopes?: Record<string, string> } = {}) {
  const grants = opts.grants ?? { [TX]: ['terminal.embed'] };
  const sessions = opts.sessions ?? { [TX]: [SESSION] };
  const scopes = opts.scopes ?? { [TERMINAL]: 'system', [TX]: 'user', [COUNTER]: 'system' };
  return createTerminalAccess({
    scopeOf: async (appId: string) => scopes[appId],
    authorize: async (appId: string, permission: string) => (grants[appId] ?? []).includes(permission),
    sessionGrant: async (appId: string, sessionId: string) => ((sessions[appId] ?? []).includes(sessionId) ? { ok: 1 } : null),
  });
}

const intent = (extras: Record<string, unknown>) => ({ action: OPEN_TERMINAL_ACTION, extras });

test('a session id names its Terminal instance, and nothing else passes', () => {
  assert.equal(terminalSessionInstance(SESSION), 'com.aura.terminal-2');
  assert.equal(terminalSessionInstance('com.aura.terminal#a1'), 'com.aura.terminal');
  for (const bad of ['io.evil.app-1#a1', 'com.aura.terminalx-1#a1', 'com.aura.terminal-2', 'a#b#c', 42, null, 'com.aura.terminal-2#a 1']) {
    assert.equal(terminalSessionInstance(bad), null, String(bad));
  }
});

test('an ungranted app cannot use OPEN_TERMINAL background, sessionId or command', async () => {
  const a = access();
  const counter = { appId: COUNTER };
  assert.match(String(await openTerminalRefusal(intent({ background: true }), counter, a)), /terminal\.embed/);
  assert.match(String(await openTerminalRefusal(intent({ sessionId: SESSION }), counter, a)), /not granted/);
  assert.match(String(await openTerminalRefusal(intent({ command: 'id' }), counter, a)), /command/);
  // A plain window is still open to every app.
  assert.equal(await openTerminalRefusal(intent({}), counter, a), null);
  assert.equal(await openTerminalRefusal({ action: 'aura.intent.action.VIEW', extras: { background: true } }, counter, a), null);
});

test('the embed grant allows background and the sessions it created, never command', async () => {
  const a = access();
  const tx = { appId: TX };
  assert.equal(await openTerminalRefusal(intent({ background: true }), tx, a), null);
  assert.equal(await openTerminalRefusal(intent({ sessionId: SESSION }), tx, a), null);
  assert.notEqual(await openTerminalRefusal(intent({ sessionId: 'com.aura.terminal-2#a9' }), tx, a), null);
  assert.notEqual(await openTerminalRefusal(intent({ background: true, command: 'id' }), tx, a), null);
  // A session grant without the app's grant is nothing (revoked).
  const revoked = access({ grants: {} });
  assert.notEqual(await openTerminalRefusal(intent({ sessionId: SESSION }), tx, revoked), null);
  assert.notEqual(await openTerminalRefusal(intent({ background: true }), tx, revoked), null);
});

test('the System Terminal keeps full control; a same-id copy in another scope does not', async () => {
  assert.equal(await openTerminalRefusal(intent({ command: 'id', background: true }), { appId: TERMINAL }, access()), null);
  const shadow = access({ scopes: { [TERMINAL]: 'user' } });
  assert.notEqual(await openTerminalRefusal(intent({ command: 'id' }), { appId: TERMINAL }, shadow), null);
});

test('a caller without an app identity is left to Phase 3', async () => {
  assert.equal(await openTerminalRefusal(intent({ command: 'id' }), null, access()), null);
});

// ── frame-ancestors ─────────────────────────────────────────────────────────

const edge = { scheme: 'http', origin: 'http://term1--desk.example' };
const registry = {
  resolveLabel: async (label: string) => ({
    terminalx1: { status: 'active', record: { appId: TX } },
    counter1: { status: 'active', record: { appId: COUNTER } },
    gone1: { status: 'retired' },
  } as Record<string, unknown>)[label] ?? { status: 'unknown' },
};
const ctx = (url: string, over: Record<string, unknown> = {}) => ({
  record: { appId: TERMINAL }, slot: { instanceId: 'com.aura.terminal-2' }, url, edge, base: 'desk.example', registry,
  buildOrigin: (scheme: string, label: string, base: string) => `${scheme}://${label}--${base}`,
  ...over,
});
const embedUrl = (session: string, label: string) =>
  `/?embed=1&session=${encodeURIComponent(session)}&_aura_embedder=${label}`;

test('exactly the granted embedder may frame its session', async () => {
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl(SESSION, 'terminalx1')), access()), ['http://terminalx1--desk.example']);
});

test('an ungranted app, another session, another instance or a revoked grant frames nothing', async () => {
  const a = access();
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl(SESSION, 'counter1')), a), []);
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl('com.aura.terminal-2#a9', 'terminalx1')), a), []);
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl(SESSION, 'terminalx1'), { slot: { instanceId: 'com.aura.terminal-3' } }), a), []);
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl(SESSION, 'gone1')), a), []);
  assert.deepEqual(await terminalEmbedAncestors(ctx(`/?embed=1&session=${encodeURIComponent(SESSION)}`), a), []);
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl(SESSION, 'terminalx1')), access({ grants: {} })), []);
});

test('only the System Terminal\'s pages can be embedded this way', async () => {
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl(SESSION, 'terminalx1'), { record: { appId: COUNTER } }), access()), []);
  const shadow = access({ scopes: { [TERMINAL]: 'user', [TX]: 'user' } });
  assert.deepEqual(await terminalEmbedAncestors(ctx(embedUrl(SESSION, 'terminalx1')), shadow), []);
});

// ── the owner shares an existing session (Shell dialog) ─────────────────────

test('the owner can share a session only with an app holding terminal.embed', async () => {
  const granted: Array<[string, string]> = [];
  const grant = async (appId: string, sessionId: string) => { granted.push([appId, sessionId]); };
  const a = access({ sessions: {} });
  assert.equal(await shareSession(TX, SESSION, { access: a, grant }), null);
  assert.deepEqual(granted, [[TX, SESSION]]);
  assert.equal(await shareSession(COUNTER, SESSION, { access: a, grant }), 'not-granted');
  assert.equal(await shareSession(TERMINAL, SESSION, { access: a, grant }), 'not-an-embedder');
  assert.equal(await shareSession(TX, 'io.evil-1#a1', { access: a, grant }), 'bad-session-id');
  assert.equal(await shareSession(TX, SESSION, { access: access({ grants: {} }), grant }), 'not-granted', 'revoked');
  assert.equal(granted.length, 1);
});
