// Who may use the owner's System Terminal from another app (D25, D29, 5.16):
// the OPEN_TERMINAL extras and the embed `frame-ancestors`, over fake grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_TERMINAL_ACTION, createTerminalAccess, openTerminalRefusal, shareSession, sweepSessionGrants, terminalEmbedAncestors,
  terminalSessionInstance,
} from '../server/terminal-embed.mjs';

const TERMINAL = 'com.aura.terminal';
const TX = 'io.lakner.terminalx';
const COUNTER = 'com.aura.counter';
const SESSION = 'com.aura.terminal-2#a3';

/**
 * Grants: app → permissions; sessions: app → session ids, granted in life
 * `binding`; scopes: app → install scope; lives: Terminal instance → its life now.
 */
function access(opts: {
  grants?: Record<string, string[]>; sessions?: Record<string, string[]>; scopes?: Record<string, string>;
  binding?: string | undefined; lives?: Record<string, string>;
} = {}) {
  const grants = opts.grants ?? { [TX]: ['terminal.embed'] };
  const sessions = opts.sessions ?? { [TX]: [SESSION] };
  const scopes = opts.scopes ?? { [TERMINAL]: 'system', [TX]: 'user', [COUNTER]: 'system' };
  const binding = 'binding' in opts ? opts.binding : 'life-2';
  const lives = opts.lives ?? { 'com.aura.terminal-2': 'life-2' };
  return createTerminalAccess({
    scopeOf: async (appId: string) => scopes[appId],
    authorize: async (appId: string, permission: string) => (grants[appId] ?? []).includes(permission),
    sessionGrant: async (appId: string, sessionId: string) => ((sessions[appId] ?? []).includes(sessionId)
      ? { ...(binding ? { binding } : {}) } : null),
    sessionLife: async (sessionId: string) => lives[terminalSessionInstance(sessionId) ?? ''] ?? null,
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

test('a command needs a proved owner or the System Terminal; background and sessionId need the owner from a non-app caller', async () => {
  // Nothing proved: any web page can POST a no-cors text/plain body.
  assert.notEqual(await openTerminalRefusal(intent({ command: 'id' }), null, access()), null);
  assert.notEqual(await openTerminalRefusal(intent({ command: 'id', background: true }), null, access()), null);
  assert.notEqual(await openTerminalRefusal(intent({ command: 'id' }), { owner: false } as never, access()), null);
  // The owner (the desktop's own page or the host operator).
  assert.equal(await openTerminalRefusal(intent({ command: 'id' }), { owner: true } as never, access()), null);
  // `background` and `sessionId` reach a session too: an unverified caller is refused them.
  assert.match(String(await openTerminalRefusal(intent({ background: true }), null, access())), /owner/);
  assert.match(String(await openTerminalRefusal(intent({ sessionId: SESSION }), null, access())), /owner/);
  assert.notEqual(await openTerminalRefusal(intent({ sessionId: SESSION }), { owner: false } as never, access()), null);
  // The owner may use them; a plain window and `background: false` stay open to everyone.
  assert.equal(await openTerminalRefusal(intent({ background: true, sessionId: SESSION }), { owner: true } as never, access()), null);
  assert.equal(await openTerminalRefusal(intent({}), null, access()), null);
  assert.equal(await openTerminalRefusal(intent({ background: false }), null, access()), null);
  assert.equal(await openTerminalRefusal({ action: 'aura.intent.action.VIEW', extras: { command: 'id' } }, null, access()), null);
});

// ── a session grant lives as long as its session ────────────────────────────

test('a session grant counts only in the instance life it was made in', async () => {
  const tx = { appId: TX };
  const open = intent({ sessionId: SESSION });
  assert.equal(await openTerminalRefusal(open, tx, access()), null);
  // The instance id was recycled (a new spawn), and the reused session name with it.
  assert.notEqual(await openTerminalRefusal(open, tx, access({ lives: { 'com.aura.terminal-2': 'life-3' } })), null);
  // The instance is gone.
  assert.notEqual(await openTerminalRefusal(open, tx, access({ lives: {} })), null);
  // A grant made before grants were bound.
  assert.notEqual(await openTerminalRefusal(open, tx, access({ binding: undefined })), null);
});

const grantRec = (sessionId: string, binding: string | undefined, appId = TX) => ({
  subject: { kind: 'app', id: appId }, permission: 'terminal.embed', scope: { kind: 'terminal-session', id: sessionId },
  ...(binding ? { binding } : {}),
});

function sweepDeps(records: unknown[], instances: Record<string, { running: boolean; life: string | null }>, live: Record<string, string[] | 'down'>) {
  const asked: string[] = [];
  const revoked: string[][] = [];
  return {
    asked, revoked,
    deps: {
      listGrants: async () => records,
      instance: async (id: string) => instances[id] ?? null,
      liveSessions: async (id: string) => {
        asked.push(id);
        const l = live[id];
        if (!l || l === 'down') throw new Error('unreachable');
        return new Set(l);
      },
      revokeSessions: async (ids: Set<string>) => { revoked.push([...ids].sort()); },
    },
  };
}

test('the sweep drops grants of sessions that ended while nobody listened, and nothing else', async () => {
  const t2 = 'com.aura.terminal-2';
  const records = [
    grantRec(`${t2}#a1`, 'life-2'),                      // live: kept
    grantRec(`${t2}#a2`, 'life-2'),                      // not live any more: dropped
    grantRec(`${t2}#a3`, 'life-1'),                      // an earlier life of the instance: dropped
    grantRec(`${t2}#a4`, undefined),                     // unbound: dropped
    grantRec('com.aura.terminal-5#a1', 'life-5'),        // instance gone: dropped
    grantRec('com.aura.terminal-7#a1', 'life-7'),        // can't answer now: kept
    grantRec('com.aura.terminal-8#a1', 'life-8'),        // starting: kept
    { ...grantRec(`${t2}#a9`, 'life-2'), scope: { kind: 'os' } },
    { ...grantRec(`${t2}#a9`, 'life-2'), permission: 'terminal.sessions.list' },
  ];
  const s = sweepDeps(records, {
    [t2]: { running: true, life: 'life-2' },
    'com.aura.terminal-7': { running: true, life: 'life-7' },
    'com.aura.terminal-8': { running: false, life: 'life-8' },
  }, { [t2]: [`${t2}#a1`, `${t2}#a9`], 'com.aura.terminal-7': 'down' });
  const dropped = await sweepSessionGrants(null, s.deps);
  assert.deepEqual(dropped.sort(), [`${t2}#a2`, `${t2}#a3`, `${t2}#a4`, 'com.aura.terminal-5#a1']);
  assert.deepEqual(s.revoked, [dropped.sort()]);
  assert.deepEqual(s.asked.sort(), [t2, 'com.aura.terminal-7'], 'one listing per running instance');
});

test('a sweep for one instance touches only its grants', async () => {
  const s = sweepDeps([grantRec('com.aura.terminal-2#a1', 'old'), grantRec('com.aura.terminal-3#a1', 'old')],
    { 'com.aura.terminal-2': { running: true, life: 'new' }, 'com.aura.terminal-3': { running: true, life: 'new' } }, {});
  assert.deepEqual(await sweepSessionGrants('com.aura.terminal-3', s.deps), ['com.aura.terminal-3#a1']);
  const none = sweepDeps([grantRec('com.aura.terminal-2#a1', 'new')], { 'com.aura.terminal-2': { running: true, life: 'new' } },
    { 'com.aura.terminal-2': ['com.aura.terminal-2#a1'] });
  assert.deepEqual(await sweepSessionGrants(null, none.deps), []);
  assert.deepEqual(none.revoked, [], 'nothing to drop, no write');
});

test('sharing fails closed when the session grant cannot be recorded', async () => {
  const grant = async () => { throw new Error('no instance identity'); };
  assert.equal(await shareSession(TX, SESSION, { access: access({ sessions: {} }), grant }), 'unavailable');
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
