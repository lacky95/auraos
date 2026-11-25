/**
 * The desktop's browser boundary: frame resolution, the sandbox,
 * AuraChannel origin + source checks, the IP setup bar and the badge layering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  APP_FRAME_ALLOW, APP_FRAME_SANDBOX, AppFrameBlockedError, assertAppHostOrigin,
  logicalFrameUrl, parseLogicalFrameUrl, resolveAppFrame,
} from '../src/lib/appFrame.ts';
import { authorizeShellMessage, classifySender, isHostNestedSender, nestedFocusChange, senderAppId, type ChannelFrame } from '../src/lib/auraChannelShell.ts';
import {
  AUTO_SWITCH_SECONDS, autoSwitchTarget, shouldAutoSwitch,
  COOKIE_PROBE_LABEL, cookieProbeUrl, isWebKitBrowser, planCookieFallback, planSetupBar, probeAppHostAddress, probeAppHostCookie, settleSetupBar,
} from '../src/lib/desktop/setupBar.ts';
import { SHELL_FRAME_ANCESTORS, shellFramePolicy } from '../src/lib/desktop/shellFramePolicy.ts';
import { iframeHtml } from '../src/lib/desktop/slotMarkup.ts';

const SHELL = 'http://10-201-1-2.nip.io:3000';
const APP = 'http://notes1a2b3c4d--10-201-1-2.nip.io:3000';
const OTHER_APP = 'http://term1a2b3c4d--10-201-1-2.nip.io:3000';
const SETTINGS_APP = 'http://settings1a2b3c4d--10-201-1-2.nip.io:3000';
const SHADOW_APP = 'http://app9f8e7d6c--10-201-1-2.nip.io:3000';
const CONSOLE_APP = 'http://console1a2b3c4d--10-201-1-2.nip.io:3000';
const SHADOW_CONSOLE = 'http://app1f2e3d4c--10-201-1-2.nip.io:3000';

// ── frame resolution ─────────────────────────────────────────────────────────

test('a view keeps the logical address saved desktops already hold', () => {
  assert.equal(logicalFrameUrl({ appId: 'a', instanceId: 'com.x.a' }), '/api/proxy/com.x.a/');
  assert.equal(logicalFrameUrl({ appId: 'a', instanceId: 'com.x.a-2', path: '/' }), '/api/proxy/com.x.a-2/');
  assert.equal(
    logicalFrameUrl({ appId: 'a', instanceId: 'i', activityId: 'act 1', path: '//notes/1' }),
    '/api/proxy/i/notes/1?_aura_activity=act%201',
  );
});

test('every app resolves through the handoff with the shared attributes', async () => {
  let body: Record<string, unknown> = {};
  let url = '';
  const f = await resolveAppFrame({ appId: 'com.x.notes', instanceId: 'i', activityId: 'a1', path: '/doc' }, {
    shellOrigin: SHELL,
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

test('direct IP opens no frame and spends no code', async () => {
  let called = false;
  await assert.rejects(resolveAppFrame({ appId: 'a', instanceId: 'i' }, {
    shellOrigin: 'http://10.201.1.2:3000',
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
  assert.deepEqual(parseLogicalFrameUrl('/api/proxy/i-2/a/b?_aura_activity=x%20y', 'app'), {
    appId: 'app', instanceId: 'i-2', path: '/a/b', activityId: 'x y',
  });
  assert.equal(parseLogicalFrameUrl('https://elsewhere/', 'app'), null);
});

test('server markup: a frame holds back its src until the handoff', () => {
  const html = iframeHtml('/api/proxy/i/', 'T');
  assert.match(html, /data-src=/);
  assert.doesNotMatch(html, /\ssrc=/);
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
  const nestedApp = { parent: hostWin };
  const nestedForeign = { parent: hostWin };
  const stranger = { parent: { parent: null } };
  const hostSettingsWin = { parent: shell };
  const shadowSettingsWin = { parent: shell };
  const hostConsoleWin = { parent: shell };
  const shadowConsoleWin = { parent: shell };
  const f = (window: unknown, origin: string, appId: string, system = false): ChannelFrame<unknown, string> =>
    ({ window, origin, appId, system, element: appId });
  const frames = [
    f(hostWin, APP, 'com.x.notes'),
    f(hostSettingsWin, SETTINGS_APP, 'com.aura.settings', true),
    f(shadowSettingsWin, SHADOW_APP, 'com.aura.settings', false),
    f(hostConsoleWin, CONSOLE_APP, 'com.aura.console', true),
    f(shadowConsoleWin, SHADOW_CONSOLE, 'com.aura.console', false),
  ];
  const from = (source: unknown, origin: string) =>
    classifySender({ source, origin, shellWindow: shell, shellOrigin: SHELL, frames });
  return {
    shell, hostWin, nestedApp, nestedForeign, stranger, from,
    hostSettingsWin, shadowSettingsWin, hostConsoleWin, shadowConsoleWin,
  };
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
  assert.equal(w.from(w.nestedForeign, SHELL)?.endpoint, 'app-subframe', 'nothing nested speaks for the shell');
});

const SETTINGS_ONLY_TYPES = [
  'aura.lockscreen.activate', 'aura.account.password.request', 'aura.account.policy.request',
];

const allowed = (type: string, sender: ReturnType<ReturnType<typeof worlds>['from']>, data: Record<string, unknown> = {}, nativeRuntime = false) =>
  !!sender && authorizeShellMessage(type, sender, data, { nativeRuntime });

test('only the verified Settings window may trigger the lock message or the password dialog', () => {
  const w = worlds();
  for (const type of SETTINGS_ONLY_TYPES) {
    assert.equal(allowed(type, w.from(w.hostSettingsWin, SETTINGS_APP)), true, type);
    assert.equal(allowed(type, w.from(w.hostWin, APP)), false, type);
    assert.equal(allowed(type, w.from(w.nestedForeign, OTHER_APP)), false, type);
  }
});

test('only an App Host window itself may ask the owner to share a Terminal session', () => {
  const w = worlds();
  const type = 'aura.terminal.share.request';
  assert.equal(allowed(type, w.from(w.hostWin, APP)), true);
  assert.equal(allowed(type, w.from(w.nestedApp, APP)), false, 'its subframe');
  assert.equal(allowed(type, w.from(w.nestedForeign, OTHER_APP)), false, 'an embedded app');
  assert.equal(allowed(type, w.from(w.shell, SHELL)), false);
});

test('a native-host message from a host frame needs the native runtime', () => {
  const w = worlds();
  for (const type of ['aura.host.url-changed', 'aura.host.needsTopLevel', 'aura.host.popup']) {
    assert.equal(allowed(type, w.from(w.hostWin, APP), { source: 'host' }, false), false, type);
    assert.equal(allowed(type, w.from(w.hostWin, APP), { source: 'host' }, true), true, type);
    assert.equal(allowed(type, w.from(w.hostWin, APP), {}, true), false, `${type} without the marker`);
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
});

test('on App Hosts only the system installation of Settings or Console is trusted, never a same-id copy', () => {
  const w = worlds();
  for (const type of SETTINGS_ONLY_TYPES) {
    assert.equal(allowed(type, w.from(w.hostSettingsWin, SETTINGS_APP)), true, type);
    assert.equal(allowed(type, w.from(w.shadowSettingsWin, SHADOW_APP)), false, `${type} from a global/user copy`);
  }
  assert.equal(allowed('aura.console.requestBacklog', w.from(w.hostConsoleWin, CONSOLE_APP)), true);
  assert.equal(allowed('aura.console.requestBacklog', w.from(w.shadowConsoleWin, SHADOW_CONSOLE)), false);
  // The console's live stream follows the same mark.
  const layout = readFileSync(new URL('../src/layouts/OSLayout.astro', import.meta.url), 'utf8');
  assert.match(layout, /f\.dataset\.auraAppId === 'com\.aura\.console' && f\.dataset\.auraSystemApp === '1'/);
});

test('a host frame cannot claim another app id', () => {
  const w = worlds();
  assert.equal(senderAppId(w.from(w.hostWin, APP)!), 'com.x.notes');
  assert.equal(senderAppId(w.from(w.shell, SHELL)!), null);
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
});

test('keyboard focus returns to the window when its own document is used', () => {
  const w = worlds();
  assert.equal(nestedFocusChange('aura.pointerdown', w.from(w.hostWin, APP)!, {}), 'clear');
  assert.equal(nestedFocusChange('aura.keyboard.field', w.from(w.hostWin, APP)!, { focused: true }), 'clear');
  assert.equal(nestedFocusChange('aura.pointerdown', w.from(w.nestedApp, APP)!, {}), null, 'a tap in the nested frame keeps it');
  assert.equal(nestedFocusChange('aura.keyboard.field', w.from(w.nestedApp, APP)!, { focused: false }), 'clear-own');
});

// ── IP setup bar ─────────────────────────────────────────────────────────────

const bar = (host: string, webkit = false) =>
  planSetupBar({ host, protocol: 'http:', pathname: '/', webkit });

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
  const safari = bar('127.0.0.1:3000', true);
  assert.ok(safari.show && safari.kind === 'link');
  assert.equal(safari.address, 'http://127-0-0-1.nip.io:3000');
});

test('public and other IPv6 addresses get the custom-domain guide', () => {
  assert.deepEqual(bar('8.8.8.8:3000'), { show: true, kind: 'guide', reason: 'address' });
  assert.deepEqual(bar('[2001:db8::1]:3000'), { show: true, kind: 'guide', reason: 'address' });
});

test('a failed probe falls back to the guide', async () => {
  const p = bar('10.201.1.2:3000');
  assert.equal(settleSetupBar(p, true), p);
  assert.deepEqual(settleSetupBar(p, false), { show: true, kind: 'guide', reason: 'address' });
  assert.equal(await probeAppHostAddress('http://x/', (async () => new Response('')) as typeof fetch), true);
  assert.equal(await probeAppHostAddress('http://x/', (async () => { throw new TypeError('dns'); }) as typeof fetch), false);
});

test('the probe is a fetch browsers accept: no-cors with the default redirect', async () => {
  let init: RequestInit | undefined;
  await probeAppHostAddress('http://x/', (async (_u: unknown, i?: RequestInit) => { init = i; return new Response(''); }) as typeof fetch);
  assert.equal(init?.mode, 'no-cors');
  assert.ok(init?.redirect === undefined || init.redirect === 'follow', `redirect ${init?.redirect} is rejected with no-cors`);
});

// ── the cookie probe (D44) ───────────────────────────────────────────────────

const probeAt = (host: string, protocol = 'http:') => cookieProbeUrl({ host, protocol });

test('the cookie probe runs only where a browser may drop the App Host cookie', () => {
  assert.equal(probeAt('os.aura.localhost:3000'), 'http://hostprobe--os.aura.localhost:3000/_aura/host-probe?cookie=set');
  assert.equal(probeAt('box.aura.test', 'https:'), 'https://hostprobe--box.aura.test/_aura/host-probe?cookie=set');
  // Every tested browser keeps it on nip.io and a public suffix; no App Hosts on IP and localhost.
  for (const host of ['10-201-1-2.nip.io:3000', '127-0-0-1.nip.io:3000', 'box.aura.example.com', '10.201.1.2:3000', '127.0.0.1:3000', 'localhost:3000']) {
    assert.equal(probeAt(host), null, host);
  }
  assert.equal(COOKIE_PROBE_LABEL, 'hostprobe');
});

test('a dropped cookie on os.aura.localhost offers 127-0-0-1.nip.io on the same port, in every browser', () => {
  for (const webkit of [true, false]) {
    const p = planCookieFallback({ host: 'os.aura.localhost:3000', protocol: 'http:', pathname: '/desk', webkit });
    assert.ok(p.show && p.kind === 'link');
    assert.equal(p.reason, 'cookies');
    assert.equal(p.href, 'http://127-0-0-1.nip.io:3000/desk');
    assert.equal(p.probeUrl, 'http://127-0-0-1.nip.io:3000/_aura/host-probe');
    assert.deepEqual(settleSetupBar(p, false), { show: true, kind: 'guide', reason: 'cookies' });
  }
  // A custom domain on a non-public suffix has no other address: the guide.
  assert.deepEqual(planCookieFallback({ host: 'box.aura.test', protocol: 'https:', webkit: true }),
    { show: true, kind: 'guide', reason: 'cookies' });
});

/** Just enough of a window and document for the probe frame. */
function probeWorld() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const frameWin = {};
  const frame = {
    attrs: {} as Record<string, string>, style: { cssText: '' }, tabIndex: 0, src: '', removed: false,
    contentWindow: frameWin,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    remove() { this.removed = true; },
  };
  const appended: unknown[] = [];
  const doc = { createElement: () => frame, body: { appendChild: (el: unknown) => { appended.push(el); } } };
  const win = {
    addEventListener: (_t: string, fn: (e: MessageEvent) => void) => { listeners.add(fn); },
    removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => { listeners.delete(fn); },
  };
  const post = (data: unknown, origin: string, source: unknown = frameWin) => {
    for (const fn of [...listeners]) fn({ data, origin, source } as unknown as MessageEvent);
  };
  return { frame, frameWin, doc: doc as unknown as Document, win: win as unknown as Window, post, listeners, appended };
}

const PROBE = 'http://hostprobe--os.aura.localhost:3000/_aura/host-probe?cookie=set';
const PROBE_ORIGIN = 'http://hostprobe--os.aura.localhost:3000';

test('the probe frame has the app frames\' sandbox and trusts only its own answer', async () => {
  const w = probeWorld();
  const kept = probeAppHostCookie(PROBE, { sandbox: APP_FRAME_SANDBOX, doc: w.doc, win: w.win, timeoutMs: 1000 });
  assert.equal(w.frame.src, PROBE);
  assert.equal(w.frame.attrs['sandbox'], APP_FRAME_SANDBOX);
  assert.deepEqual(w.appended, [w.frame]);
  // Forgeries: another origin, another window, another type.
  w.post({ type: 'aura.hostprobe.cookie', cookie: false }, 'http://evil--os.aura.localhost:3000');
  w.post({ type: 'aura.hostprobe.cookie', cookie: false }, PROBE_ORIGIN, {});
  w.post({ type: 'aura.key', cookie: false }, PROBE_ORIGIN);
  w.post({ type: 'aura.hostprobe.cookie', cookie: false }, PROBE_ORIGIN);
  assert.equal(await kept, false);
  assert.equal(w.frame.removed, true);
  assert.equal(w.listeners.size, 0);

  const w2 = probeWorld();
  const ok = probeAppHostCookie(PROBE, { sandbox: APP_FRAME_SANDBOX, doc: w2.doc, win: w2.win, timeoutMs: 1000 });
  w2.post({ type: 'aura.hostprobe.cookie', cookie: true }, PROBE_ORIGIN);
  assert.equal(await ok, true);
});

test('a probe that never answers does not show the bar', async () => {
  const w = probeWorld();
  assert.equal(await probeAppHostCookie(PROBE, { sandbox: APP_FRAME_SANDBOX, doc: w.doc, win: w.win, timeoutMs: 20 }), true);
  assert.equal(w.frame.removed, true);
  assert.equal(w.listeners.size, 0);
});

test('WebKit detection does not catch Chromium', () => {
  assert.equal(isWebKitBrowser('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), true);
  assert.equal(isWebKitBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/120 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isWebKitBrowser('Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 Chrome/120 Safari/537.36'), false);
  assert.equal(isWebKitBrowser('Mozilla/5.0 (X11; rv:120.0) Gecko/20100101 Firefox/120.0'), false);
});

// ── shell frame-ancestors ────────────────────────────────────────────────────

test('frame-ancestors: no one may frame the shell\'s pages', () => {
  assert.equal(SHELL_FRAME_ANCESTORS, "frame-ancestors 'none'");
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

test('the owner dialog is a native modal, mounted, and gives the requester only the outcome', () => {
  const src = css('OwnerPasswordDialog.astro');
  assert.match(src, /<dialog id="aura-owner-password"/);
  assert.match(src, /\.showModal\(\)/);
  assert.match(src, /autocomplete="current-password"/);
  assert.match(src, /autocomplete="new-password"/);
  // The reply carries {ok, error?} only, never a field value. An approval's
  // answer is built by approvalReply() alone (approvals.test.ts pins it).
  const literal = [...src.matchAll(/replyTo\([\w.]+, \{([^}]*)\}/g)].length;
  const approval = [...src.matchAll(/replyTo\([\w.]+, approvalReply\(/g)].length;
  assert.ok(approval > 0, 'approvals answer through approvalReply');
  assert.equal([...src.matchAll(/replyTo\(/g)].length, literal + approval);
  for (const reply of src.matchAll(/replyTo\([\w.]+, \{([^}]*)\}/g)) assert.doesNotMatch(reply[1]!, /value|password:|current:|next:/, reply[0]);
  const layout = readFileSync(new URL('../src/layouts/OSLayout.astro', import.meta.url), 'utf8');
  assert.match(layout, /<OwnerPasswordDialog \/>/);
});

test('D50: the shared admin unlock is gone: no dialog, no channel message', () => {
  const layout = readFileSync(new URL('../src/layouts/OSLayout.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(layout, /AdminUnlock/);
  assert.equal(existsSync(new URL('../src/components/shell/AdminUnlockDialog.astro', import.meta.url)), false);
  const w = worlds();
  assert.equal(allowed('aura.admin.unlock.request', w.from(w.hostSettingsWin, SETTINGS_APP)), false, 'not a channel message any more');
});

test('IP mode moves to the App Hosts address on its own, unless the owner stays or the probe failed', () => {
  const plan = planSetupBar({ host: '10.0.0.5:3000', protocol: 'http:', pathname: '/', webkit: false });
  assert.ok(plan.show && plan.kind === 'link');
  assert.equal(shouldAutoSwitch(settleSetupBar(plan, true), false), true);
  assert.equal(shouldAutoSwitch(settleSetupBar(plan, true), true), false, 'Stay on this address');
  assert.equal(shouldAutoSwitch(settleSetupBar(plan, false), false), false, 'the guide never moves');
  assert.equal(shouldAutoSwitch(planSetupBar({ host: 'os.aura.localhost:3000', protocol: 'http:', pathname: '/', webkit: false }), false), false);
  assert.equal(autoSwitchTarget('http://10-0-0-5.nip.io:3000/', '?a=1', '#x'), 'http://10-0-0-5.nip.io:3000/?a=1#x');
  assert.ok(AUTO_SWITCH_SECONDS > 0 && AUTO_SWITCH_SECONDS <= 5);
});
