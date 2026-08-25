// Tests for the exclusive-view PTY session protocol: at most one browser
// renders a session at a time, the others get `busy` and can claim it — plus
// the launch claim, which settles the one race first-come gets wrong.
// Run via:
//   pnpm --filter com.aura.terminal test
//
// Drives the real pty-server over real WebSockets and a real shell, because
// what's worth protecting here is the wire protocol (who gets `granted`, who
// gets the scrollback, whose keystrokes reach the PTY) — not the arithmetic.
// The source is imported directly with node's type stripping: the Astro build
// emits hashed chunk names, so there is no stable dist path to import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

import { getPtyWss, killSession } from '../src/pty-server.ts';

const SESSION = 'test-session-ownership';
const decoder = new TextDecoder();

// The window in which a dropped socket is treated as a reload rather than a
// departure. Short enough to wait out in a test, long enough to still be a
// meaningful gap. The server reads it lazily, so setting it here — after the
// hoisted import — takes effect.
const HOLD_MS = 1000;
process.env.AURA_TERM_OWNER_HOLD_MS = String(HOLD_MS);

const wss = getPtyWss();
const server = http.createServer();
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();

/** Open a socket as browser `browserId` on `session`, splitting the two frame
 *  types the server uses: binary = control message, text = PTY output.
 *  `launchClaim` is the flag the browser that launched the window sends. */
function openBrowser(browserId, { session = SESSION, launchClaim = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`
    + `?_aura_session=${session}&_aura_browser=${browserId}`
    + (launchClaim ? '&_aura_claim=1' : ''));
  const view = { ws, ctl: [], out: [], browserId };
  ws.on('message', (data, isBinary) => {
    if (isBinary) view.ctl.push(JSON.parse(decoder.decode(data)));
    else view.out.push(data.toString());
  });
  return view;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `fn()` is truthy — the protocol is asynchronous end to end. */
async function until(fn, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const state = (view) => view.ctl.at(-1)?.type;
const screen = (view) => view.out.join('');
const type = (view, cmd) => view.ws.send(JSON.stringify({ type: 'data', data: `${cmd}\r` }));

test('one browser owns a terminal session at a time', async (t) => {
  const a = openBrowser('browser-a');

  await t.test('the first browser in gets the terminal', async () => {
    await until(() => a.ctl.length, 'a control frame for browser-a');
    assert.equal(state(a), 'granted');
  });

  await t.test('the live view drives the shell', async () => {
    a.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await sleep(400);              // let the shell reach its first prompt
    a.out.length = 0;
    type(a, 'echo MARKER_A');
    await until(() => screen(a).includes('MARKER_A'), 'browser-a echo');
  });

  const b = openBrowser('browser-b');

  await t.test('a second browser is told the terminal is in use', async () => {
    await until(() => b.ctl.length, 'a control frame for browser-b');
    assert.equal(state(b), 'busy');
    assert.equal(b.out.length, 0, 'a spectator must get no scrollback replay');
    assert.equal(state(a), 'granted', 'the owner keeps its terminal');
  });

  await t.test('a spectator cannot reach the shared shell', async () => {
    a.out.length = 0;
    type(b, 'echo MARKER_MUST_NOT_RUN');
    b.ws.send(JSON.stringify({ type: 'resize', cols: 20, rows: 5 }));
    await sleep(500);
    assert.ok(!screen(a).includes('MARKER_MUST_NOT_RUN'));
  });

  await t.test('"Use terminal here" moves the live view', async () => {
    b.ws.send(JSON.stringify({ type: 'claim' }));
    await until(() => state(b) === 'granted', 'browser-b granted');
    await until(() => state(a) === 'busy', 'browser-a revoked');
    assert.ok(screen(b).includes('MARKER_A'),
      'the claiming view continues where the session was, via the scrollback replay');
  });

  await t.test('the revoked view is the locked-out one now', async () => {
    b.out.length = 0;
    type(a, 'echo MARKER_AFTER_LOSS');
    await sleep(500);
    assert.ok(!screen(b).includes('MARKER_AFTER_LOSS'));

    b.out.length = 0;
    type(b, 'echo MARKER_B');
    await until(() => screen(b).includes('MARKER_B'), 'browser-b echo');
  });

  await t.test('the live browser keeps its session across a reload', async () => {
    // A reload of the OS UI drops every socket and rebuilds them a moment
    // later. That must not cost the reloading browser its terminal — which is
    // exactly what handing the session to a waiting spectator on close did.
    b.ws.close();                                    // b is live at this point
    await sleep(200);                                // the gap a reload leaves
    assert.equal(state(a), 'busy', 'the spectator must NOT inherit the session');

    const b2 = openBrowser('browser-b');             // same browser, new page
    await until(() => b2.ctl.length, 'a control frame for the reloaded browser-b');
    assert.equal(state(b2), 'granted', 'the owner picks its own session back up');
    assert.ok(screen(b2).includes('MARKER_B'), 'and gets the scrollback with it');
    assert.equal(state(a), 'busy', 'the spectator is still just a spectator');

    // Still the live one, not merely told so.
    b2.out.length = 0;
    type(b2, 'echo MARKER_AFTER_RELOAD');
    await until(() => screen(b2).includes('MARKER_AFTER_RELOAD'), 'reloaded echo');
    b2.ws.close();
  });

  await t.test('a spectator does not inherit while the owner may be reloading', async () => {
    // Inside the hold, a spectator reconnecting (keepalive, network blip) must
    // not walk off with a terminal whose owner is mid-reload.
    a.ws.close();
    const a2 = openBrowser('browser-a');
    await until(() => a2.ctl.length, 'a control frame for the reconnected browser-a');
    assert.equal(state(a2), 'busy');
    a2.ws.close();
  });

  await t.test('a second socket from the SAME browser is live as well', async () => {
    // Two iframes in one browser tab share a browser id — neither locks the
    // other out, which is what keeps a page reload seamless.
    const b3 = openBrowser('browser-b');
    await until(() => b3.ctl.length, 'a control frame for the first browser-b socket');
    assert.equal(state(b3), 'granted');
    const b4 = openBrowser('browser-b');
    await until(() => b4.ctl.length, 'a control frame for the second browser-b socket');
    assert.equal(state(b4), 'granted');
    b3.ws.close();
    b4.ws.close();
  });

  await t.test('an abandoned session is released once the hold expires', async () => {
    await sleep(HOLD_MS + 300);
    const c = openBrowser('browser-c');
    await until(() => c.ctl.length, 'a control frame for browser-c');
    assert.equal(state(c), 'granted');
    c.ws.close();
  });

  killSession(SESSION);
  await sleep(200);
});

test('the browser that launched a window wins the attach race', async () => {
  // The launch shows up in every browser at once, so the "wrong" browser's
  // iframe routinely connects first. The launching browser carries the shell's
  // one-shot mark as ?_aura_claim=1 and must end up live regardless.
  const session = 'test-session-launch';
  const early = openBrowser('browser-early', { session });
  await until(() => early.ctl.length, 'a control frame for the early browser');
  assert.equal(state(early), 'granted', 'first in is live, as usual');

  const launcher = openBrowser('browser-launcher', { session, launchClaim: true });
  await until(() => state(launcher) === 'granted', 'the launching browser granted');
  await until(() => state(early) === 'busy', 'the early browser revoked');

  // And it really is live, not just told so.
  await sleep(400);
  launcher.out.length = 0;
  type(launcher, 'echo MARKER_LAUNCHER');
  await until(() => screen(launcher).includes('MARKER_LAUNCHER'), 'launcher echo');

  early.ws.close();
  launcher.ws.close();
  killSession(session);
  await sleep(200);
  server.close();
});
