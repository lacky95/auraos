/**
 * The frame lifecycle and the one channel listener on real iframe elements,
 * in happy-dom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const SHELL = 'http://10-201-1-2.nip.io:3000';
const APP = 'http://notes1a2b3c4d--10-201-1-2.nip.io:3000';

const win = new Window({ url: `${SHELL}/`, settings: { disableIframePageLoading: true } });
for (const k of ['window', 'document', 'HTMLElement', 'HTMLIFrameElement', 'CSS'] as const) {
  (globalThis as Record<string, unknown>)[k] = (win as unknown as Record<string, unknown>)[k];
}

const {
  APP_FRAME_ALLOW, APP_FRAME_SANDBOX, clearAppFrame, isHostFrameReady, postToFrame, reloadHostFrame,
  setAppFrameUrl,
} = await import('../src/lib/appFrame.ts');
const { onAuraChannel } = await import('../src/lib/auraChannelShell.ts');

let codes = 0;
let gate: Promise<void> = Promise.resolve();
let handoffSystem: boolean | undefined;
globalThis.fetch = (async () => {
  await gate;
  codes++;
  return new Response(JSON.stringify({ code: `code${codes}`, origin: APP, slot: 1, ...(handoffSystem === undefined ? {} : { system: handoffSystem }) }));
}) as typeof fetch;

const settle = () => new Promise((r) => setTimeout(r, 5));

function slotFrame(id: string, src?: string): HTMLIFrameElement {
  const slot = win.document.createElement('div');
  slot.className = 'app-slot';
  slot.dataset['viewId'] = id;
  const f = win.document.createElement('iframe');
  if (src) f.setAttribute('src', src);
  slot.appendChild(f);
  win.document.body.appendChild(slot);
  return f as unknown as HTMLIFrameElement;
}

test('an app frame is sandboxed before it has a src, and is posted to at its exact origin', async () => {
  let open: () => void = () => undefined;
  gate = new Promise((r) => { open = r; });
  const f = slotFrame('h1');
  setAppFrameUrl(f, '/api/proxy/com.x.notes/doc', 'com.x.notes');
  assert.equal(f.getAttribute('sandbox'), APP_FRAME_SANDBOX);
  assert.equal(f.getAttribute('allow'), APP_FRAME_ALLOW);
  assert.equal(f.getAttribute('src'), null);
  open();
  await settle();
  gate = Promise.resolve();
  assert.match(f.getAttribute('src') ?? '', /^http:\/\/notes1a2b3c4d--10-201-1-2\.nip\.io:3000\/_aura\/handoff\?code=code\d+&next=%2Fdoc$/);
  assert.equal(postToFrame(f, { type: 'aura.window.focus' }), false, 'not before its load');

  f.dispatchEvent(new win.Event('load') as unknown as Event);
  assert.equal(isHostFrameReady(f), true);
  const posts: Array<[unknown, string]> = [];
  Object.defineProperty(f, 'contentWindow', { configurable: true, value: { postMessage: (m: unknown, o: string) => posts.push([m, o]) } });
  assert.equal(postToFrame(f, { type: 'aura.window.focus' }), true);
  assert.deepEqual(posts, [[{ type: 'aura.window.focus' }, APP]]);
  delete (f as unknown as Record<string, unknown>)['contentWindow'];
});

test('a reload spends a new code and waits for the new load', async () => {
  const f = slotFrame('h2');
  setAppFrameUrl(f, '/api/proxy/com.x.notes/', 'com.x.notes');
  await settle();
  const first = f.getAttribute('src');
  f.dispatchEvent(new win.Event('load') as unknown as Event);
  assert.equal(reloadHostFrame(f), true);
  assert.equal(isHostFrameReady(f), false);
  await settle();
  assert.notEqual(f.getAttribute('src'), first);
});

test('a reused frame drops the sandbox before the next app', async () => {
  const f = slotFrame('h3');
  setAppFrameUrl(f, '/api/proxy/com.x.notes/', 'com.x.notes');
  await settle();
  clearAppFrame(f);
  assert.equal(f.hasAttribute('sandbox'), false);
  assert.equal(f.getAttribute('src'), 'about:blank');
  setAppFrameUrl(f, '/api/proxy/com.x.other/', 'com.x.other');
  assert.equal(f.getAttribute('sandbox'), APP_FRAME_SANDBOX, 'the next app gets its own sandbox');
  assert.equal(f.getAttribute('src'), 'about:blank', 'and nothing before its handoff');
});

test('a late handoff cannot overwrite a newer navigation', async () => {
  let open: () => void = () => undefined;
  gate = new Promise((r) => { open = r; });
  const f = slotFrame('h4');
  setAppFrameUrl(f, '/api/proxy/com.x.notes/', 'com.x.notes');
  clearAppFrame(f);
  open();
  await settle();
  gate = Promise.resolve();
  assert.equal(f.getAttribute('src'), 'about:blank');
});

test('direct IP: the window stays, with no src and a notice', async () => {
  win.happyDOM.setURL('http://10.201.1.2:3000/');
  const f = slotFrame('h5');
  const before = codes;
  setAppFrameUrl(f, '/api/proxy/com.x.notes/', 'com.x.notes');
  await settle();
  assert.equal(f.getAttribute('src'), null);
  assert.equal(codes, before, 'no handoff code spent');
  assert.ok(f.parentElement?.querySelector('[data-aura-frame-notice]'));
  assert.ok(f.isConnected);
  win.happyDOM.setURL(`${SHELL}/`);
});

test('a host frame is marked system only when the handoff says its installation is', async () => {
  const { isSystemHostFrame } = await import('../src/lib/appFrame.ts');
  for (const [system, marked] of [[true, true], [false, false], [undefined, false]] as const) {
    handoffSystem = system;
    const f = slotFrame(`sys-${String(system)}`);
    setAppFrameUrl(f, '/api/proxy/com.x.notes/', 'com.x.notes');
    await settle();
    assert.equal(isSystemHostFrame(f), marked, String(system));
    if (marked) {
      // A reused frame loses the mark before the next app's handoff answers.
      handoffSystem = false;
      reloadHostFrame(f);
      assert.equal(isSystemHostFrame(f), false);
      await settle();
      assert.equal(isSystemHostFrame(f), false);
    }
  }
  handoffSystem = undefined;
});

test('the listener drops a forged lock message and accepts the verified Settings window', () => {
  const SETTINGS = 'http://settings1a2b3c4d--10-201-1-2.nip.io:3000';
  const frame = (id: string, appId: string, origin: string, system: boolean) => {
    const f = slotFrame(id, `${origin}/_aura/handoff?code=x`);
    Object.assign(f.dataset, { auraHostFrame: '1', auraFrameOrigin: origin, auraFrameReady: '1', auraAppId: appId, ...(system ? { auraSystemApp: '1' } : {}) });
    // happy-dom gives no contentWindow with page loading off.
    Object.defineProperty(f, 'contentWindow', { configurable: true, value: { parent: win } });
    return f;
  };
  const settings = frame('s1', 'com.aura.settings', SETTINGS, true);
  const other = frame('o1', 'com.x.notes', APP, false);
  let locks = 0;
  const off = onAuraChannel('aura.lockscreen.activate', () => { locks++; });
  const send = (source: unknown, origin: string) => win.dispatchEvent(new win.MessageEvent('message', {
    data: { type: 'aura.lockscreen.activate' }, source: source as never, origin,
  }));
  send(other.contentWindow, APP);
  send(other.contentWindow, SETTINGS);
  send(settings.contentWindow, 'http://evil.example');
  send(settings.contentWindow, SHELL);
  send(null, SETTINGS);
  assert.equal(locks, 0);
  send(settings.contentWindow, SETTINGS);
  assert.equal(locks, 1);
  off();
});
