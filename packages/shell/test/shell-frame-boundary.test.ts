/**
 * The desktop's browser boundary: frame resolution on both routes, the sandbox,
 * AuraChannel origin + source checks, the IP setup bar and the badge layering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APP_FRAME_ALLOW, APP_FRAME_SANDBOX, AppFrameBlockedError, appIdFromProxySrc, assertAppHostOrigin,
  parseProxyFrameUrl, proxyFrameUrl, resolveAppFrame,
} from '../src/lib/appFrame.ts';
import { authorizeShellMessage, classifySender, isHostNestedSender, nestedFocusChange, senderAppId, type ChannelFrame } from '../src/lib/auraChannelShell.ts';
import { isWebKitBrowser, planSetupBar, probeAppHostAddress, settleSetupBar } from '../src/lib/desktop/setupBar.ts';
import { SHELL_FRAME_ANCESTORS, shellFramePolicy } from '../src/lib/desktop/frameRoutes.ts';
import { iframeHtml } from '../src/lib/desktop/slotMarkup.ts';

const SHELL = 'http://10-201-1-2.nip.io:3000';
const APP = 'http://notes1a2b3c4d--10-201-1-2.nip.io:3000';
const OTHER_APP = 'http://term1a2b3c4d--10-201-1-2.nip.io:3000';

// ── frame resolution ─────────────────────────────────────────────────────────

test('proxy route: the exact URLs the desktop has always used', () => {
  assert.equal(proxyFrameUrl({ appId: 'a', instanceId: 'com.x.a' }), '/api/proxy/com.x.a/');
  assert.equal(proxyFrameUrl({ appId: 'a', instanceId: 'com.x.a-2', path: '/' }), '/api/proxy/com.x.a-2/');
  assert.equal(
    proxyFrameUrl({ appId: 'a', instanceId: 'i', activityId: 'act 1', path: '//notes/1' }),
    '/api/proxy/i/notes/1?_aura_activity=act%201',
  );
});

test('proxy route: no handoff, no sandbox, no allow', async () => {
  let called = false;
  const f = await resolveAppFrame({ appId: 'a', instanceId: 'i', path: '/x' }, {
    shellOrigin: SHELL, route: 'proxy', fetch: (async () => { called = true; return new Response('{}'); }) as typeof fetch,
  });
  assert.equal(called, false);
  assert.deepEqual(f, { origin: SHELL, url: '/api/proxy/i/x', label: '', slot: 0, sandbox: '', allow: '' });
});

test('host route: resolves through the handoff with the shared attributes', async () => {
  let body: Record<string, unknown> = {};
  let url = '';
  const f = await resolveAppFrame({ appId: 'com.x.notes', instanceId: 'i', activityId: 'a1', path: '/doc' }, {
    shellOrigin: SHELL,
    route: 'host',
    fetch: (async (u: string, init: RequestInit) => {
      url = u; body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ code: 'c0de', origin: APP, slot: 2 }));
    }) as unknown as typeof fetch,
  });
  assert.equal(url, '/api/app-hosts/handoff');
  assert.equal(body['returnPath'], '/doc?_aura_activity=a1');
  assert.equal(f.origin, APP);
  assert.equal(f.url, `${APP}/_aura/handoff?code=c0de&next=${encodeURIComponent('/doc?_aura_activity=a1')}`);
  assert.equal(f.label, 'notes1a2b3c4d');
  assert.equal(f.slot, 2);
  assert.equal(f.sandbox, APP_FRAME_SANDBOX);
  assert.equal(f.allow, APP_FRAME_ALLOW);
});

test('host route: direct IP opens no frame and spends no code', async () => {
  let called = false;
  await assert.rejects(resolveAppFrame({ appId: 'a', instanceId: 'i' }, {
    shellOrigin: 'http://10.201.1.2:3000', route: 'host',
    fetch: (async () => { called = true; return new Response('{}'); }) as typeof fetch,
  }), AppFrameBlockedError);
  assert.equal(called, false);
});

test('a handoff can only point at an App Host of this desktop', () => {
  assert.equal(assertAppHostOrigin(APP, SHELL).label, 'notes1a2b3c4d');
  for (const bad of [
    SHELL,
    'http://evil.example',
    'http://notes--evil.example:3000',
    'https://notes1a2b3c4d--10-201-1-2.nip.io:3000',
    'http://notes1a2b3c4d--10-201-1-2.nip.io:3001',
    `${APP}/path`,
    null,
  ]) assert.throws(() => assertAppHostOrigin(bad, SHELL), String(bad));
});

test('a logical URL round-trips to its target', () => {
  assert.deepEqual(parseProxyFrameUrl('/api/proxy/i-2/a/b?_aura_activity=x%20y', 'app'), {
    appId: 'app', instanceId: 'i-2', path: '/a/b', activityId: 'x y',
  });
  assert.equal(parseProxyFrameUrl('https://elsewhere/', 'app'), null);
  assert.equal(appIdFromProxySrc('/api/proxy/com.x.a-3/'), 'com.x.a');
});

test('server markup: only a host frame holds back its src', () => {
  assert.match(iframeHtml('/api/proxy/i/', 'T'), /^<iframe src="\/api\/proxy\/i\/"/);
  const deferred = iframeHtml('/api/proxy/i/', 'T', true);
  assert.match(deferred, /data-src=/);
  assert.doesNotMatch(deferred, /\ssrc=/);
});

// ── sandbox ──────────────────────────────────────────────────────────────────

test('the sandbox has no way to navigate the desktop', () => {
  const flags = APP_FRAME_SANDBOX.split(' ');
  assert.ok(flags.includes('allow-scripts'));
  assert.ok(flags.includes('allow-same-origin'));
  for (const f of flags) assert.doesNotMatch(f, /top-navigation/);
  assert.ok(!flags.includes('allow-popups-to-escape-sandbox'));
  assert.match(APP_FRAME_ALLOW, /clipboard-write/);
});

// ── AuraChannel ──────────────────────────────────────────────────────────────

function worlds() {
  const shell = { name: 'shell' } as { parent?: unknown };
  shell.parent = shell;
  const hostWin = { parent: shell };
  const proxyWin = { parent: shell };
  const settingsWin = { parent: shell };
  const nestedApp = { parent: hostWin };
  const nestedForeign = { parent: hostWin };
  const proxyNested = { parent: proxyWin };
  const stranger = { parent: { parent: null } };
  const f = (window: unknown, origin: string, appId: string, route: 'host' | 'proxy'): ChannelFrame<unknown, string> =>
    ({ window, origin, appId, route, element: appId });
  const frames = [
    f(hostWin, APP, 'com.x.notes', 'host'),
    f(proxyWin, SHELL, 'com.x.proxy', 'proxy'),
    f(settingsWin, SHELL, 'com.aura.settings', 'proxy'),
  ];
  const from = (source: unknown, origin: string) =>
    classifySender({ source, origin, shellWindow: shell, shellOrigin: SHELL, frames });
  return { shell, hostWin, proxyWin, settingsWin, nestedApp, nestedForeign, proxyNested, stranger, from };
}

test('source AND origin must both match', () => {
  const w = worlds();
  assert.equal(w.from(w.hostWin, APP)?.endpoint, 'app');
  assert.equal(w.from(w.hostWin, OTHER_APP), null, 'right window, wrong origin');
  assert.equal(w.from(w.hostWin, SHELL), null, 'a host frame cannot claim the shell origin');
  assert.equal(w.from(w.stranger, APP), null, 'right origin, unknown window');
  assert.equal(w.from(null, APP), null);
  assert.equal(w.from(w.shell, SHELL)?.endpoint, 'shell');
  assert.equal(w.from(w.shell, APP), null);
});

test('nested senders are classed by their origin', () => {
  const w = worlds();
  assert.equal(w.from(w.nestedApp, APP)?.endpoint, 'app');
  assert.equal(w.from(w.nestedApp, APP)?.direct, false);
  assert.equal(w.from(w.nestedForeign, OTHER_APP)?.endpoint, 'embedded-app');
  assert.equal(w.from(w.nestedForeign, 'https://site.example')?.endpoint, 'app-subframe');
  assert.equal(w.from(w.proxyNested, SHELL)?.endpoint, 'app');
});

const allowed = (type: string, sender: ReturnType<ReturnType<typeof worlds>['from']>, data: Record<string, unknown> = {}, nativeRuntime = false) =>
  !!sender && authorizeShellMessage(type, sender, data, { nativeRuntime });

test('only the verified Settings window may trigger the lock message or admin unlock', () => {
  const w = worlds();
  for (const type of ['aura.lockscreen.activate', 'aura.admin.unlock.request']) {
    assert.equal(allowed(type, w.from(w.settingsWin, SHELL)), true, type);
    assert.equal(allowed(type, w.from(w.hostWin, APP)), false, type);
    assert.equal(allowed(type, w.from(w.proxyWin, SHELL)), false, type);
    assert.equal(allowed(type, w.from(w.nestedForeign, OTHER_APP)), false, type);
  }
});

test('a native-host message from a host frame needs the native runtime', () => {
  const w = worlds();
  for (const type of ['aura.host.url-changed', 'aura.host.needsTopLevel', 'aura.host.popup']) {
    assert.equal(allowed(type, w.from(w.hostWin, APP), { source: 'host' }, false), false, type);
    assert.equal(allowed(type, w.from(w.hostWin, APP), { source: 'host' }, true), true, type);
    assert.equal(allowed(type, w.from(w.hostWin, APP), {}, true), false, `${type} without the marker`);
    assert.equal(allowed(type, w.from(w.proxyWin, SHELL), { source: 'host' }), true, `${type} stays as it was on the proxy`);
  }
});

test('routes come from the registry', () => {
  const w = worlds();
  assert.equal(allowed('aura.key', w.from(w.hostWin, APP)), true);
  assert.equal(allowed('aura.not.a.type', w.from(w.hostWin, APP)), false);
  assert.equal(allowed('aura.key.synthetic', w.from(w.hostWin, APP)), false, 'an app cannot type into the shell');
  assert.equal(allowed('aura.system.lockScreen', w.from(w.nestedForeign, 'https://site.example')), false);
  assert.equal(allowed('aura.keyboard.field', w.from(w.nestedForeign, OTHER_APP)), true);
  assert.equal(allowed('aura.terminal.ready', w.from(w.nestedForeign, OTHER_APP)), false);
});

test('a host app cannot read the shell console backlog, except Console', () => {
  const w = worlds();
  assert.equal(allowed('aura.console.requestBacklog', w.from(w.hostWin, APP)), false);
  assert.equal(allowed('aura.console.requestBacklog', w.from(w.proxyWin, SHELL)), true);
});

test('a host frame cannot claim another app id', () => {
  const w = worlds();
  assert.equal(senderAppId(w.from(w.hostWin, APP)!, 'com.aura.settings'), 'com.x.notes');
  assert.equal(senderAppId(w.from(w.proxyWin, SHELL)!, 'com.x.proxy'), 'com.x.proxy');
});

test('keyboard focus: only a runtime document nested in a host frame can claim it', () => {
  const w = worlds();
  const focused = { focused: true };
  assert.equal(nestedFocusChange('aura.keyboard.hello', w.from(w.nestedApp, APP)!, focused), 'set');
  assert.equal(nestedFocusChange('aura.keyboard.hello', w.from(w.nestedForeign, OTHER_APP)!, focused), 'set');
  assert.equal(nestedFocusChange('aura.keyboard.hello', w.from(w.nestedForeign, OTHER_APP)!, {}), null, 'a plain hello is not focus');
  const thirdParty = w.from(w.nestedForeign, 'https://site.example')!;
  assert.equal(isHostNestedSender(thirdParty), false);
  assert.equal(nestedFocusChange('aura.keyboard.hello', thirdParty, focused), null);
  assert.equal(nestedFocusChange('aura.keyboard.hello', w.from(w.proxyNested, SHELL)!, focused), null, 'proxy keeps its relay');
});

test('keyboard focus returns to the window when its own document is used', () => {
  const w = worlds();
  assert.equal(nestedFocusChange('aura.pointerdown', w.from(w.hostWin, APP)!, {}), 'clear');
  assert.equal(nestedFocusChange('aura.keyboard.field', w.from(w.hostWin, APP)!, { focused: true }), 'clear');
  assert.equal(nestedFocusChange('aura.pointerdown', w.from(w.nestedApp, APP)!, {}), null, 'a tap in the nested frame keeps it');
  assert.equal(nestedFocusChange('aura.keyboard.field', w.from(w.nestedApp, APP)!, { focused: false }), 'clear-own');
});

// ── IP setup bar ─────────────────────────────────────────────────────────────

const bar = (host: string, hostRouteApps = 1, webkit = false) =>
  planSetupBar({ host, protocol: 'http:', pathname: '/', hostRouteApps, webkit });

test('the bar stays hidden until an app is on frameRoute: host', () => {
  for (const host of ['10.201.1.2:3000', '127.0.0.1:3000', 'localhost:3000', '[::1]:3000', '8.8.8.8']) {
    assert.deepEqual(bar(host, 0), { show: false }, host);
  }
});

test('the bar stays hidden on an address that already has App Hosts', () => {
  for (const host of ['10-201-1-2.nip.io:3000', 'os.aura.localhost:3000', 'box.aura.example.com']) {
    assert.deepEqual(bar(host), { show: false }, host);
  }
});

test('a LAN IP gets its nip.io link, built from the browser address', () => {
  const p = bar('10.201.1.2:3000');
  assert.ok(p.show && p.kind === 'link');
  assert.equal(p.href, 'http://10-201-1-2.nip.io:3000/');
  assert.equal(p.probeUrl, 'http://10-201-1-2.nip.io:3000/_aura/host-probe');
});

test('loopback gets os.aura.localhost, and WebKit gets the nip.io fallback', () => {
  const p = bar('127.0.0.1:3000');
  assert.ok(p.show && p.kind === 'link');
  assert.equal(p.address, 'http://os.aura.localhost:3000');
  const safari = bar('127.0.0.1:3000', 1, true);
  assert.ok(safari.show && safari.kind === 'link');
  assert.equal(safari.address, 'http://127-0-0-1.nip.io:3000');
});

test('public and other IPv6 addresses get the custom-domain guide', () => {
  assert.deepEqual(bar('8.8.8.8:3000'), { show: true, kind: 'guide' });
  assert.deepEqual(bar('[2001:db8::1]:3000'), { show: true, kind: 'guide' });
});

test('a failed probe falls back to the guide', async () => {
  const p = bar('10.201.1.2:3000');
  assert.equal(settleSetupBar(p, true), p);
  assert.deepEqual(settleSetupBar(p, false), { show: true, kind: 'guide' });
  assert.equal(await probeAppHostAddress('http://x/', (async () => new Response('')) as typeof fetch), true);
  assert.equal(await probeAppHostAddress('http://x/', (async () => { throw new TypeError('dns'); }) as typeof fetch), false);
});

test('WebKit detection does not catch Chromium', () => {
  assert.equal(isWebKitBrowser('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), true);
  assert.equal(isWebKitBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/120 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isWebKitBrowser('Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 Chrome/120 Safari/537.36'), false);
  assert.equal(isWebKitBrowser('Mozilla/5.0 (X11; rv:120.0) Gecko/20100101 Firefox/120.0'), false);
});

// ── shell frame-ancestors ────────────────────────────────────────────────────

test('frame-ancestors covers shell pages and leaves app content and login alone', () => {
  assert.equal(shellFramePolicy('/', 'text/html; charset=utf-8', null), SHELL_FRAME_ANCESTORS);
  assert.equal(shellFramePolicy('/launcher', 'text/html', null), SHELL_FRAME_ANCESTORS);
  assert.equal(shellFramePolicy('/api/proxy/x/', 'text/html', null), null);
  assert.equal(shellFramePolicy('/', 'application/json', null), null);
  assert.equal(shellFramePolicy('/login', 'text/html', "frame-ancestors 'none'"), null);
});

// ── badge layering ───────────────────────────────────────────────────────────

const css = (rel: string) => readFileSync(new URL(`../src/components/shell/${rel}`, import.meta.url), 'utf-8');
const zOf = (src: string, selector: string) => {
  const at = src.indexOf(`${selector} {`);
  assert.ok(at >= 0, selector);
  const m = src.slice(at).match(/z-index:\s*(\d+)/);
  assert.ok(m, selector);
  return Number(m[1]);
};

test('the auto-hide badge is above keyboard and launcher, below every trusted dialog', () => {
  const status = css('StatusBar.astro');
  const badge = zOf(status, '.bars-badge');
  const seg = zOf(status, '.bars-seg');
  assert.equal(badge, seg);
  const keyboard = Number(css('keyboard/KeyboardOverlay.astro').match(/z-index:\s*(\d+)/)?.[1]);
  const launcher = Math.max(...[...css('LauncherOverlay.astro').matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
  const trusted = zOf(css('notifications/NotificationStyles.astro'), '.aura-dlg-system');
  const lock = Number(css('LockScreenOverlay.astro').match(/z-index:\s*(2\d{3})/)?.[1]);
  assert.ok(badge > keyboard, 'above the keyboard');
  assert.ok(badge > launcher, 'above the launcher');
  assert.ok(badge < trusted, 'below system, approval and password dialogs');
  assert.ok(badge < lock, 'below the lock screen');
});

test('the admin unlock is a native modal, above every z-index', () => {
  const src = css('AdminUnlockDialog.astro');
  assert.match(src, /<dialog id="aura-admin-unlock"/);
  assert.match(src, /\.showModal\(\)/);
});
