// format.ts / context.ts / anchor.ts: safe linking, image rules, sender
// labels, relative time, Go to task, anchors.
//
//   cd packages/shell && npx tsx --test test/notification-format.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, iconSpec, relativeTime, safeHttpUrl, safeImageSrc, segmentsToHtml, senderLabel, textSegments,
} from '../src/lib/notifications/format.ts';
import { contextTarget, goToContext } from '../src/lib/notifications/context.ts';
import { getAnchor, registerAnchor, watchAnchor } from '../src/lib/notifications/anchor.ts';

test('textSegments: only http(s) becomes a link; trailing punctuation and unbalanced brackets stay text', () => {
  assert.deepEqual(textSegments('see https://a.example/x?y=1, then (https://b.example/p) and javascript:alert(1) or ftp://c'), [
    { kind: 'text', text: 'see ' },
    { kind: 'link', text: 'https://a.example/x?y=1', href: 'https://a.example/x?y=1' },
    { kind: 'text', text: ', then (' },
    { kind: 'link', text: 'https://b.example/p', href: 'https://b.example/p' },
    { kind: 'text', text: ') and javascript:alert(1) or ftp://c' },
  ]);
  assert.deepEqual(textSegments('wiki https://en.wikipedia.org/wiki/Foo_(bar).'), [
    { kind: 'text', text: 'wiki ' },
    { kind: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(textSegments(''), []);
  assert.deepEqual(textSegments(undefined), []);
});

test('markup is never interpreted: escaped text, quotes cannot break out of href', () => {
  const html = segmentsToHtml(textSegments('<img src=x onerror=alert(1)> https://x.example/"onmouseover="alert(1) <b>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<a href="https://x.example/" target="_blank" rel="noopener noreferrer">https://x.example/</a>'));
  assert.ok(html.includes('&quot;onmouseover=&quot;alert(1)'));
  assert.equal(escapeHtml(`a&<>"'`), 'a&amp;&lt;&gt;&quot;&#39;');
});

test('safeHttpUrl / safeImageSrc', () => {
  assert.equal(safeHttpUrl('https://x.example/a b'), 'https://x.example/a%20b');
  assert.equal(safeHttpUrl('HTTP://X.example'), 'http://x.example/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', 'ftp://x', '', '   ', 'https://']) {
    assert.equal(safeHttpUrl(bad), null, bad);
  }
  assert.equal(safeImageSrc('/api/os/icons/app.png'), '/api/os/icons/app.png');
  assert.equal(safeImageSrc('https://img.example/a.png'), 'https://img.example/a.png');
  for (const bad of ['//evil.example/a.png', '/\\evil', 'data:image/png;base64,AAAA', 'javascript:x', '/a"b']) {
    assert.equal(safeImageSrc(bad), null, bad);
  }
});

test('relativeTime', () => {
  const now = 10_000_000_000;
  assert.equal(relativeTime(now - 1000, now), 'now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5m');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h');
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2d');
  assert.match(relativeTime(now - 30 * 86_400_000, now), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(relativeTime(now + 5000, now), 'now');
});

test('senderLabel: app name lookup, agent with actor, rest, auraos, unverified marker', () => {
  const lookup = (id: string) => (id === 'com.example.notes' ? { name: 'Notes', glyph: 'NO' } : id === 'com.aura.aurashelld' ? { name: 'Shell Daemon' } : undefined);
  assert.deepEqual(senderLabel({ sender: { kind: 'app', id: 'com.example.notes', attribution: 'verified' } }, lookup),
    { label: 'Notes', glyph: 'NO', unverified: false, title: 'Notes' });
  const agent = senderLabel({ sender: { kind: 'agent', id: 'com.aura.aurashelld', attribution: 'verified', actor: { name: 'tester', attribution: 'declared' } } }, lookup);
  assert.equal(agent.label, 'Agent tester');
  assert.equal(agent.detail, 'via Shell Daemon');
  assert.equal(agent.unverified, false);
  const hinted = senderLabel({ sender: { kind: 'app', id: 'com.example.notes', attribution: 'unverified' } }, lookup);
  assert.equal(hinted.unverified, true);
  assert.match(hinted.title, /unverified/);
  assert.equal(senderLabel({ sender: { kind: 'rest', attribution: 'unverified' } }).label, 'REST API');
  assert.equal(senderLabel({ sender: { kind: 'rest', id: 'k1', name: 'CI', attribution: 'verified' } }).detail, 'REST API');
  assert.deepEqual(senderLabel({ sender: { kind: 'auraos', id: 'auraos', name: 'AuraOS', attribution: 'internal' } }).unverified, false);
  assert.equal(senderLabel({ sender: { kind: 'unknown', attribution: 'unverified' } }).label, 'Unknown sender');
});

test('iconSpec: sprite names, safe images, short glyphs, else the sender glyph', () => {
  const s = { kind: 'app', id: 'x', name: 'Xylo', attribution: 'unverified' } as const;
  assert.deepEqual(iconSpec({ icon: 'lucide-bell', sender: s }), { kind: 'sprite', name: 'lucide-bell' });
  assert.deepEqual(iconSpec({ icon: 'https://i.example/a.png', sender: s }), { kind: 'image', src: 'https://i.example/a.png' });
  assert.deepEqual(iconSpec({ icon: 'NB', sender: s }), { kind: 'glyph', text: 'NB' });
  assert.deepEqual(iconSpec({ icon: 'javascript:alert(1)', sender: s }), { kind: 'glyph', text: 'X' });
  assert.deepEqual(iconSpec({ icon: '<b>', sender: s }), { kind: 'glyph', text: 'X' });
});

test('contextTarget / goToContext', async () => {
  const calls: string[] = [];
  const host = {
    auraHasWindow: (i: string, a?: string) => a === 'act-1' || i === 'inst-1',
    auraRevealInstance: async (i: string, a?: string) => { calls.push(`reveal:${i}:${a ?? ''}`); },
    auraLaunchApp: async (id: string) => { calls.push(`launch:${id}`); },
  };
  assert.equal(await goToContext({ kind: 'activity', id: 'act-1', appId: 'com.x' }, host), 'revealed');
  assert.equal(await goToContext({ kind: 'activity', id: 'act-closed', appId: 'com.x' }, host), 'launched');
  assert.equal(await goToContext({ kind: 'instance', id: 'inst-1' }, host), 'revealed');
  assert.equal(await goToContext({ kind: 'instance', id: 'inst-2' }, host), 'none');
  assert.equal(await goToContext({ kind: 'app', id: 'com.y' }, host), 'launched');
  assert.equal(await goToContext({ kind: 'task', id: 't1', label: 'Build' }, host), 'none');
  assert.deepEqual(calls, ['reveal::act-1', 'launch:com.x', 'reveal:inst-1:', 'launch:com.y']);
  assert.deepEqual(contextTarget({ kind: 'task', id: 't1', label: 'Build' }), { actionable: false, label: 'Build' });
  assert.equal(contextTarget({ kind: 'activity', id: 'a', appId: 'com.x' })?.actionable, true);
  assert.equal(contextTarget(undefined), null);
});

test('anchors: register, watch, unregister only by the owner', () => {
  const seen: Array<unknown> = [];
  const off = watchAnchor<{ n: number }>('t-anchor', (el) => seen.push(el));
  const a = { n: 1 };
  const b = { n: 2 };
  const unA = registerAnchor('t-anchor', a);
  const unB = registerAnchor('t-anchor', b);
  unA();                          // stale owner: no effect
  assert.equal(getAnchor('t-anchor'), b);
  unB();
  assert.equal(getAnchor('t-anchor'), null);
  off();
  registerAnchor('t-anchor', a);
  assert.deepEqual(seen, [null, a, b, null]);
});

import { admitToast, toastDuration, MAX_TOASTS, DEFAULT_TOAST_MS } from '../src/lib/notifications/toasts.ts';

test('toast policy: max three, sticky high/urgent push out, low/medium go to the list when full', () => {
  const v = (id: string, priority: string) => ({ id, priority } as never);
  assert.equal(MAX_TOASTS, 3);
  assert.deepEqual(admitToast([], v('a', 'low')), { admit: true });
  const full = [v('a', 'medium'), v('b', 'high'), v('c', 'low')];
  assert.deepEqual(admitToast(full, v('d', 'medium')), { admit: false });
  assert.deepEqual(admitToast(full, v('d', 'urgent')), { admit: true, evict: 'a' });
  const allSticky = [v('a', 'high'), v('b', 'urgent'), v('c', 'high')];
  assert.deepEqual(admitToast(allSticky, v('d', 'high')), { admit: true, evict: 'a' });
  assert.deepEqual(admitToast(allSticky, v('d', 'low')), { admit: false });
  assert.deepEqual(admitToast([v('a', 'low')], v('a', 'low')), { admit: false });
});

test('toast duration: own expiry, else 8 s for low/medium, sticky for high/urgent', () => {
  assert.equal(toastDuration({ priority: 'low' }, 0), DEFAULT_TOAST_MS);
  assert.equal(toastDuration({ priority: 'medium' }, 0), DEFAULT_TOAST_MS);
  assert.equal(toastDuration({ priority: 'high' }, 0), null);
  assert.equal(toastDuration({ priority: 'urgent' }, 0), null);
  assert.equal(toastDuration({ priority: 'urgent', timeoutMs: 5000, expiresAt: 5000 }, 1000), 4000);
  assert.equal(toastDuration({ priority: 'low', timeoutMs: 100, expiresAt: 100 }, 0), 1500);
});

test('popupDurationMs: default, positive, 0 and -1; sticky pop-ups hold their slot', async () => {
  const { isStickyPopup } = await import('../src/lib/notifications/toasts.ts');
  // duration
  assert.equal(toastDuration({ priority: 'low' }, 0), DEFAULT_TOAST_MS, 'absent → default');
  assert.equal(toastDuration({ priority: 'urgent' }, 0), null, 'absent → high/urgent stay');
  assert.equal(toastDuration({ priority: 'low', popupDurationMs: 2500 }, 0), 2500);
  assert.equal(toastDuration({ priority: 'urgent', popupDurationMs: 2500 }, 0), 2500, 'explicit wins over the priority default');
  assert.equal(toastDuration({ priority: 'low', popupDurationMs: 2500, timeoutMs: 60000, expiresAt: 60000 }, 0), 2500, 'separate from the lifetime');
  assert.equal(toastDuration({ priority: 'low', popupDurationMs: 0 }, 0), null, '0 → sticky');
  assert.equal(toastDuration({ priority: 'low', popupDurationMs: -1 }, 0), null, '-1 → sticky');
  assert.equal(isStickyPopup({ popupDurationMs: 0 }), true);
  assert.equal(isStickyPopup({ popupDurationMs: -1 }), true);
  assert.equal(isStickyPopup({ popupDurationMs: 10 }), false);
  assert.equal(isStickyPopup({}), false);

  const v = (id: string, priority: 'low' | 'medium' | 'high' | 'urgent', popupDurationMs?: number) => ({ id, priority, ...(popupDurationMs !== undefined ? { popupDurationMs } : {}) });
  // A sticky low pop-up is skipped as a victim; the oldest non-sticky goes.
  assert.deepEqual(admitToast([v('s', 'low', -1), v('a', 'low'), v('b', 'medium')], v('n', 'urgent')), { admit: true, evict: 'a' });
  // Non-sticky high ones are still evictable when no low / medium is left.
  assert.deepEqual(admitToast([v('s', 'low', 0), v('h1', 'high'), v('h2', 'high')], v('n', 'urgent')), { admit: true, evict: 'h1' });
  // Three sticky pop-ups: new items go to the list only, even urgent.
  const allSticky = [v('a', 'low', -1), v('b', 'medium', 0), v('c', 'high', -1)];
  assert.deepEqual(admitToast(allSticky, v('n', 'urgent')), { admit: false });
  assert.deepEqual(admitToast(allSticky, v('n', 'low')), { admit: false });
  // Free slots: sticky or not, admitted.
  assert.deepEqual(admitToast([v('a', 'low', -1)], v('n', 'low', 0)), { admit: true });
});
