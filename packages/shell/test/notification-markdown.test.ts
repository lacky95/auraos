// Markdown component + dialogue maximize (phase 6): the DOM-free parser /
// preview, the renderer's safety (XSS corpus), every element, the toolbar
// (Rendered ⇄ Source, Copy with a mocked clipboard + fallback), patch in
// place (view + scroll kept), editable values / drafts / required, the
// list / pop-up preview with "Show", and Maximize (toggle, shortcut,
// persistence per tab, cleared memory, phone hides it, select popups follow).
//
//   cd packages/shell && npx tsx --test test/notification-markdown.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom, setRect } from './dom.ts';
import type { Notification } from '../src/lib/notifications/api.ts';
import { markdownPreview, parseMarkdown, safeLinkHref } from '../src/lib/notifications/markdown.ts';
import { missingRequired, needsDismissConfirm, planCardUpdate } from '../src/lib/notifications/cardPatch.ts';
import { draftValuesFor, getDrafts } from '../src/lib/notifications/drafts.ts';
import { CARD_CONTROL_SELECTOR, decidePlacement, hasFormFields, hasMarkdown, isComplex } from '../src/lib/notifications/dialogs.ts';
import { MAX_PREFIX, MaximizeMemory, getMaximizeMemory, isMaximizeShortcut } from '../src/lib/notifications/maximize.ts';

const { renderNotificationCard, updateNotificationCard, collectValues } = await import('../src/components/shell/notifications/NotificationCard.ts');
const { renderMarkdown, copyText } = await import('../src/components/shell/notifications/MarkdownField.ts');
const { buildDialogFrame } = await import('../src/components/shell/notifications/DialogFrame.ts');

const doc = dom.document as unknown as Document;
const desktopWidth = (w: number) => Object.defineProperty(doc.body, 'clientWidth', { configurable: true, get: () => w });
desktopWidth(1280);

let seq = 0;
const item = (components: Notification['components'], p: Partial<Notification> = {}): Notification => ({
  id: `ntf_00000000mdk${String(++seq).padStart(6, '0')}`, type: 'dialogue', title: 'Report', text: '', priority: 'normal', visibility: 'private',
  pinned: false, popup: true, blocking: false, scope: 'auto',
  caller: { kind: 'instance', appId: 'com.example.notes', instanceId: 'i1', verification: 'verified' },
  sender: { kind: 'app', id: 'com.example.notes', name: 'Notes', attribution: 'verified' }, senderKey: 'app:com.example.notes',
  state: 'active', createdAt: 1, updatedAt: 1, history: [], components, ...p,
} as Notification);

const ok = () => ({ ok: true as const });
function recorder() {
  const calls: unknown[][] = [];
  return {
    calls,
    actions: {
      resolve: async (id: string, a: Record<string, unknown>) => { calls.push(['resolve', id, a]); return ok(); },
      dismiss: async (id: string) => { calls.push(['dismiss', id]); return ok(); },
      interact: async (id: string, p: unknown) => { calls.push(['interact', id, p]); return ok(); },
      forceRemove: async (id: string) => { calls.push(['forceRemove', id]); return ok(); },
    },
  };
}
const key = (el: Element, k: string, init: Record<string, unknown> = {}) =>
  el.dispatchEvent(new dom.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init } as never) as unknown as Event);
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const md = (text: string, p: Record<string, unknown> = {}) => ({ kind: 'markdown' as const, id: 'r', text, ...p });

// ── Safety ──────────────────────────────────────────────────────────────────

const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<style>body{display:none}</style>',
  '<a href="javascript:alert(1)" onclick="alert(1)">raw</a>',
  '<svg onload=alert(1)><circle/></svg>',
  '[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [vb](vbscript:msgbox(1)) [rel](/api/admin) [esc](java&#115;cript:alert(1))',
  '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) <data:text/html,<script>alert(1)</script>>',
  '![x](javascript:alert(1)) ![y](data:image/svg+xml,<svg onload=alert(1)>) ![z](https://tracker.example/pixel.gif)',
  '[ok](https://example.com/a?b=1 "t") <https://auraos.dev> mailto <mailto:a@b.c> https://bare.example/x.',
  '```html\n<script>alert(1)</script>\n```',
  '| <b>h</b> | x |\n|---|---|\n| <img src=x onerror=alert(1)> | `<i>` |',
  '> <script>alert(2)</script>\n- <iframe></iframe>\n- [ ] <b onmouseover=alert(1)>t</b>',
  '[a](https://ok.example)<!-- <script>alert(1)</script> -->',
].join('\n\n');

test('safety: an XSS corpus renders as text — no script/style/iframe/img/svg, no on* attributes, only http(s)/mailto links', () => {
  resetDom();
  const host = doc.createElement('div');
  host.appendChild(renderMarkdown(XSS));
  doc.body.appendChild(host);
  for (const tag of ['script', 'style', 'iframe', 'img', 'svg', 'object', 'embed', 'link', 'meta', 'form', 'b', 'i', 'circle']) {
    assert.equal(host.querySelectorAll(tag).length, 0, `no <${tag}>`);
  }
  for (const e of host.querySelectorAll('*')) {
    for (const a of Array.from(e.attributes)) {
      assert.ok(!/^on/i.test(a.name), `no ${a.name} on <${e.tagName}>`);
      if (a.name === 'href') assert.match(a.value, /^(https?:|mailto:)/, `href ${a.value}`);
      if (a.name === 'style') assert.match(a.value, /^text-align: (left|right|center);?$/, `style ${a.value}`);
    }
  }
  const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['https://tracker.example/pixel.gif', 'https://example.com/a?b=1', 'https://auraos.dev/', 'mailto:a@b.c', 'https://bare.example/x', 'https://ok.example/']);
  for (const a of host.querySelectorAll('a')) {
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  }
  // The raw HTML is visible as text, the blocked links are marked.
  assert.match(host.textContent!, /<script>alert\(1\)<\/script>/);
  assert.match(host.textContent!, /<img src=x onerror="alert\(1\)">/);
  const bad = [...host.querySelectorAll('.aura-ntf-md-badlink')].map((s) => s.textContent);
  assert.ok(['js', 'JS', 'vb', 'rel', 'data'].every((t) => bad.includes(t)), `blocked: ${bad.join(',')}`);
  assert.ok(bad.some((t) => t?.includes('x')), 'an unsafe image is text');
  assert.ok(host.querySelector('a.aura-ntf-md-img')?.textContent?.includes('z'), 'an http(s) image is a link, never loaded');
  assert.equal(safeLinkHref(' javascript:alert(1)'), null);
  assert.equal(safeLinkHref('https://x\u0000y'), null);
  assert.equal(safeLinkHref('http://'), null);
});

test('safety: pathological input stays fast (64 KB of delimiters / nesting)', () => {
  const t0 = Date.now();
  for (const s of ['*'.repeat(65_536), '['.repeat(65_536), '`'.repeat(30_000) + 'a' + '`'.repeat(30_001), '> '.repeat(8000) + 'x',
    '_a '.repeat(20_000), '**a '.repeat(15_000), '[a](' .repeat(15_000), Array.from({ length: 3000 }, (_, k) => `${' '.repeat(k % 40)}- x`).join('\n')]) {
    parseMarkdown(s);
  }
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

// ── Elements ────────────────────────────────────────────────────────────────

const SAMPLE = [
  '# Title', '', 'Para with **bold**, *em*, ~~strike~~, `code` and a [link](https://e.x).', 'Line two  ', 'hard break',
  '', '## Sub', '### Third', '', '- a', '- b', '  - nested', '    - deeper', '- [x] done', '- [ ] open',
  '', '3. three', '4. four', '', '> quoted **x**', '> more', '', '| L | C | R |', '|:--|:-:|--:|', '| 1 | 2 | 3 |',
  '', '```ts', 'const x = 1;', '```', '', '---', '', 'Setext', '======', '', '    indented code',
].join('\n');

test('elements: headings, paragraphs, inline marks, lists (nested, tasks, start), quote, table (alignment, scroll box), code, hr', () => {
  resetDom();
  const h = doc.createElement('div');
  h.appendChild(renderMarkdown(SAMPLE));
  assert.deepEqual([...h.querySelectorAll('h1, h2, h3')].map((e) => `${e.tagName}:${e.textContent}`), ['H1:Title', 'H2:Sub', 'H3:Third', 'H1:Setext']);
  const p = h.querySelector('p')!;
  assert.equal(p.querySelector('strong')!.textContent, 'bold');
  assert.equal(p.querySelector('em')!.textContent, 'em');
  assert.equal(p.querySelector('del')!.textContent, 'strike');
  assert.equal(p.querySelector('code')!.textContent, 'code');
  assert.equal(p.querySelector('a')!.getAttribute('href'), 'https://e.x/');
  assert.equal(p.querySelectorAll('br').length, 1, 'two trailing spaces = hard break');
  const ul = h.querySelector('ul')!;
  assert.ok(ul.querySelector(':scope > li > ul > li > ul > li'), 'nested twice');
  const tasks = [...h.querySelectorAll<HTMLInputElement>('li[data-task] > input[type="checkbox"]')];
  assert.deepEqual(tasks.map((t) => [t.checked, t.disabled]), [[true, true], [false, true]], 'read-only checkboxes');
  const ol = h.querySelector('ol')!;
  assert.equal(ol.getAttribute('start'), '3');
  assert.equal(h.querySelector('blockquote strong')!.textContent, 'x');
  const tbl = h.querySelector('.aura-ntf-md-table')!;
  assert.equal(tbl.getAttribute('tabindex'), '0', 'the scroll box is keyboard-reachable');
  assert.deepEqual([...tbl.querySelectorAll('th')].map((th) => (th as HTMLElement).style.textAlign), ['left', 'center', 'right']);
  assert.equal(tbl.querySelectorAll('tbody td').length, 3);
  const codes = [...h.querySelectorAll('.aura-ntf-md-code')];
  assert.equal(codes.length, 2);
  assert.equal((codes[0] as HTMLElement).dataset['lang'], 'ts');
  assert.equal(codes[0]!.querySelector('pre > code')!.textContent, 'const x = 1;');
  assert.ok(codes[0]!.querySelector('button.aura-ntf-md-copy-code'), 'per-block copy');
  assert.equal(codes[1]!.querySelector('code')!.textContent, 'indented code');
  assert.equal(h.querySelectorAll('hr').length, 1);
});

test('preview: plain text in order, clamped with "…"', () => {
  const p = markdownPreview('# Report\n\nAll **good**.\n\n- [x] built\n- tests\n\n```sh\nnpm t\n```\n\n| a | b |\n|-|-|\n| 1 | 2 |');
  assert.equal(p.text, 'Report · All good. · ☑ built · • tests · [sh code] · [table: a · b]');
  assert.equal(p.truncated, false);
  const long = markdownPreview('word '.repeat(400), 60);
  assert.equal(long.truncated, true);
  assert.ok(long.text.endsWith('…') && long.text.length <= 61);
});

// ── The field in a dialogue ────────────────────────────────────────────────

test('dialogue: toolbar — Source toggle (aria-pressed) shows the read-only source; back to Rendered', () => {
  resetDom();
  const n = item([md('# Hi\n\nthere', { label: 'Report' })]);
  const card = renderNotificationCard(n, { mode: 'dialog', actions: recorder().actions });
  doc.body.appendChild(card);
  const w = card.querySelector<HTMLElement>('[data-ntf-md="r"]')!;
  const tools = w.querySelector('[role="toolbar"]')!;
  assert.ok(tools.closest(CARD_CONTROL_SELECTOR), 'the toolbar counts as a control (no click-to-open)');
  const toggle = w.querySelector<HTMLButtonElement>('[data-md-action="view"]')!;
  const area = w.querySelector<HTMLElement>('.aura-ntf-md-area')!;
  const src = w.querySelector<HTMLTextAreaElement>('.aura-ntf-md-source')!;
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(area.hidden, false);
  assert.equal(src.hidden, true);
  assert.equal(area.querySelector('h1')!.textContent, 'Hi');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(w.dataset['view'], 'source');
  assert.equal(area.hidden, true);
  assert.equal(src.hidden, false);
  assert.equal(src.readOnly, true);
  assert.equal(src.value, '# Hi\n\nthere');
  assert.equal(src.dataset['ntfField'], undefined, 'read-only: not a form field');
  toggle.click();
  assert.equal(w.dataset['view'], 'rendered');
  assert.equal(collectValues(card, n)['r'], undefined, 'read-only markdown sends no value');
  // view:'source' starts in the source.
  const n2 = item([md('x', { view: 'source' })]);
  const c2 = renderNotificationCard(n2, { mode: 'dialog', actions: recorder().actions });
  assert.equal(c2.querySelector<HTMLElement>('[data-ntf-md]')!.dataset['view'], 'source');
});

test('dialogue: Copy writes the raw markdown (Clipboard API), shows "Copied ✓"; fallback via execCommand', async () => {
  resetDom();
  const n = item([md('**raw** text')]);
  const card = renderNotificationCard(n, { mode: 'dialog', actions: recorder().actions });
  doc.body.appendChild(card);
  const copied: string[] = [];
  const nav = dom.navigator as unknown as { clipboard?: unknown };
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard');
  Object.defineProperty(nav, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { copied.push(t); } } });
  try {
    const btn = card.querySelector<HTMLButtonElement>('[data-md-action="copy"]')!;
    btn.click();
    await flush();
    assert.deepEqual(copied, ['**raw** text']);
    assert.equal(btn.textContent, 'Copied ✓');
    // Per code block too.
    const n2 = item([md('```\ncode here\n```')]);
    const c2 = renderNotificationCard(n2, { mode: 'dialog', actions: recorder().actions });
    doc.body.appendChild(c2);
    c2.querySelector<HTMLButtonElement>('.aura-ntf-md-copy-code')!.click();
    await flush();
    assert.equal(copied[1], 'code here');
    // No Clipboard API: the hidden-textarea fallback.
    Object.defineProperty(nav, 'clipboard', { configurable: true, value: undefined });
    const d = doc as unknown as { execCommand?: (c: string) => boolean };
    const prevExec = d.execCommand;
    const execs: string[] = [];
    d.execCommand = (c: string) => { execs.push(c); return true; };
    try {
      assert.equal(await copyText('fallback'), true);
      assert.deepEqual(execs, ['copy']);
      assert.equal(doc.querySelectorAll('body > textarea').length, 0, 'the helper textarea is removed');
    } finally { d.execCommand = prevExec; }
  } finally {
    if (had) Object.defineProperty(nav, 'clipboard', had); else delete nav.clipboard;
  }
});

test('dialogue: patch in place — new text re-renders, the card and field stay, view mode and scroll are kept', () => {
  resetDom();
  const n = item([md('# One\n\nfirst', { label: 'Log' }), { kind: 'button', id: 'ok', label: 'OK', action: 'resolve', variant: 'primary' }]);
  const opts = { mode: 'dialog' as const, actions: recorder().actions };
  const card = renderNotificationCard(n, opts);
  doc.body.appendChild(card);
  const w = card.querySelector<HTMLElement>('[data-ntf-md="r"]')!;
  const area = w.querySelector<HTMLElement>('.aura-ntf-md-area')!;
  area.scrollTop = 40;
  const n2 = { ...n, updatedAt: 2, components: [md('# Two\n\nsecond', { label: 'Log', view: 'source' }), n.components![1]!] } as Notification;
  assert.equal(planCardUpdate(n, n2), 'patch', 'markdown text / view are patched, not rebuilt');
  const same = updateNotificationCard(card, n2, opts);
  assert.ok(same === card, 'same card');
  assert.ok(card.querySelector('[data-ntf-md="r"]') === w, 'same field');
  assert.equal(w.dataset['view'], 'rendered', "the sender's view does not flip the user's mode");
  assert.equal(area.querySelector('h1')!.textContent, 'Two');
  assert.equal(area.scrollTop, 40, 'scroll kept');
  // In source view, a patch updates the source and keeps the source view.
  w.querySelector<HTMLButtonElement>('[data-md-action="view"]')!.click();
  const n3 = { ...n2, components: [md('# Three', { label: 'Log' }), n.components![1]!] } as Notification;
  updateNotificationCard(card, n3, opts);
  assert.equal(w.dataset['view'], 'source');
  assert.equal(w.querySelector<HTMLTextAreaElement>('.aura-ntf-md-source')!.value, '# Three');
  // A label change is structural: rebuilt, but the view mode is carried over.
  const n4 = { ...n3, components: [md('# Three', { label: 'Other' }), n.components![1]!] } as Notification;
  assert.equal(planCardUpdate(n3, n4), 'rebuild');
  const next = updateNotificationCard(card, n4, opts);
  assert.ok(next !== card);
  assert.equal(next.querySelector<HTMLElement>('[data-ntf-md="r"]')!.dataset['view'], 'source');
});

test('dialogue: editable markdown is a form field — value, drafts, required, edits survive sender patches', async () => {
  resetDom();
  const comp = md('- item', { editable: true, required: true, label: 'Notes' });
  const n = item([comp]);
  const r = recorder();
  const opts = { mode: 'dialog' as const, actions: r.actions };
  const card = renderNotificationCard(n, opts);
  doc.body.appendChild(card);
  assert.equal(hasFormFields(n), true);
  assert.equal(needsDismissConfirm(n, null).confirm, true);
  const w = card.querySelector<HTMLElement>('[data-ntf-md="r"]')!;
  const toggle = w.querySelector<HTMLButtonElement>('[data-md-action="view"]')!;
  assert.equal(toggle.textContent, 'Edit');
  toggle.click();
  const src = w.querySelector<HTMLTextAreaElement>('.aura-ntf-md-source')!;
  assert.equal(src.readOnly, false);
  assert.equal(src.dataset['ntfField'], 'r');
  assert.equal(collectValues(card, n)['r'], '- item', 'the value starts as the text');
  src.value = '- edited\n- **two**';
  src.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  assert.deepEqual(plain(getDrafts().get(n.id)), { r: '- edited\n- **two**' }, 'draft saved');
  assert.deepEqual(draftValuesFor(n, { r: 'x' }), { r: 'x' });
  assert.deepEqual(draftValuesFor(item([md('t')]), { r: 'x' }), {}, 'no drafts for read-only markdown');
  // Back to Rendered: the edit is rendered.
  toggle.click();
  assert.equal(w.querySelector('.aura-ntf-md-area strong')!.textContent, 'two');
  // A sender patch keeps the user's edit.
  const n2 = { ...n, components: [{ ...comp, text: '- server' }] } as Notification;
  updateNotificationCard(card, n2, opts);
  assert.equal(src.value, '- edited\n- **two**');
  // A new rendering restores the draft.
  const again = renderNotificationCard(n2, opts);
  assert.equal(again.querySelector<HTMLTextAreaElement>('.aura-ntf-md-source')!.value, '- edited\n- **two**');
  // Required: empty → missing; submit sends the edited text.
  assert.deepEqual(missingRequired(n.components, { r: '  ' }).map((c) => c.id), ['r']);
  assert.deepEqual(missingRequired(n.components, { r: 'x' }), []);
  card.querySelector<HTMLButtonElement>('[data-behaviour="submit"]')!.click();
  await flush();
  assert.deepEqual(plain(r.calls), [['resolve', n.id, { outcome: 'submitted', buttonId: 'submit', values: { r: '- edited\n- **two**' } }]]);
});

test('list / pop-up: a clamped preview + "Show" (opens the dialogue), never the full area', () => {
  resetDom();
  const long = `# Weekly report\n\n${'Lots of words here. '.repeat(40)}`;
  const n = item([md(long, { label: 'Report' })], { type: 'simple' });
  const shown: string[] = [];
  for (const mode of ['list', 'toast'] as const) {
    const card = renderNotificationCard(n, { mode, actions: recorder().actions, onShowFull: (x) => { shown.push(`${mode}:${x.id}`); return true; } });
    doc.body.appendChild(card);
    assert.equal(card.querySelector('.aura-ntf-md-area'), null, 'no full area');
    const pv = card.querySelector<HTMLElement>('[data-ntf-md-preview="r"]')!;
    assert.equal(pv.dataset['truncated'], 'true');
    assert.ok(pv.querySelector('.aura-ntf-md-preview-text')!.textContent!.endsWith('…'));
    assert.ok(pv.querySelector('.aura-ntf-md-preview-text')!.textContent!.startsWith('Weekly report · Lots of words'));
    pv.querySelector<HTMLButtonElement>('.aura-ntf-md-show')!.click();
  }
  assert.deepEqual(shown, [`list:${n.id}`, `toast:${n.id}`]);
  // A Simple item with markdown opens as a floating dialogue when the user asks (not on its own).
  assert.equal(hasMarkdown(n), true);
  assert.equal(isComplex(n), true, 'phone: a full view');
  assert.deepEqual(decidePlacement(n, { intent: 'user', view: null, phone: false, suppressed: false }), { kind: 'floating', layout: 'panel' });
  assert.equal(decidePlacement(n, { intent: 'auto', view: null, phone: false, suppressed: false }).kind, 'none');
  // The preview follows a patch.
  const card = renderNotificationCard(n, { mode: 'list', actions: recorder().actions });
  const n2 = { ...n, components: [md('short now', { label: 'Report' })] } as Notification;
  updateNotificationCard(card, n2, { mode: 'list', actions: recorder().actions });
  assert.equal(card.querySelector('.aura-ntf-md-preview-text')!.textContent, 'short now');
  // An editable one in a pop-up still submits its value (the draft, else the text).
  const e = item([md('base', { editable: true })]);
  const ec = renderNotificationCard(e, { mode: 'toast', actions: recorder().actions });
  assert.equal(collectValues(ec, e)['r'], 'base');
  getDrafts().set(e.id, 'r', 'drafted');
  assert.equal(collectValues(ec, e)['r'], 'drafted');
});

// ── Maximize ────────────────────────────────────────────────────────────────

test('maximize: header button (aria-pressed, tooltip), Alt+Shift+Enter, remembered per item for the tab, survives updates + re-mounts', () => {
  resetDom();
  try { dom.sessionStorage.clear(); } catch { /* ignore */ }
  const n = item([md('# Big report')]);
  const f = buildDialogFrame(n, { actions: recorder().actions, takeFocus: false, onLater: () => {} });
  doc.body.appendChild(f.root);
  assert.equal(f.root.dataset['hasMarkdown'], 'true', 'a larger default with markdown');
  const btn = f.root.querySelector<HTMLButtonElement>('.aura-dlg-bar .aura-dlg-max')!;
  assert.ok(btn.nextElementSibling?.classList.contains('aura-dlg-close'), 'next to the ✕');
  assert.equal(btn.hidden, false);
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.match(btn.title, /^Maximize \(Alt\+Shift\+Enter\)$/);
  assert.equal(btn.getAttribute('aria-keyshortcuts'), 'Alt+Shift+Enter');
  btn.click();
  assert.equal(f.root.dataset['maximized'], 'true');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.match(btn.title, /^Restore/);
  assert.equal(dom.sessionStorage.getItem(`${MAX_PREFIX}${n.id}`), '1');
  // Survives a patch and a rebuild of the card.
  f.update({ ...n, title: 'Renamed' });
  f.update({ ...n, title: 'Renamed', components: [md('# Big report', { label: 'New label' })] });
  assert.equal(f.root.dataset['maximized'], 'true');
  // A re-mount (another frame for the same item) starts maximized.
  const g = buildDialogFrame(n, { actions: recorder().actions, takeFocus: false });
  assert.equal(g.root.dataset['maximized'], 'true');
  g.dispose();
  // The shortcut (focus inside) restores; plain Enter / Alt+Enter do not toggle.
  const field = f.root.querySelector<HTMLElement>('[data-md-action="view"]')!;
  key(field, 'Enter', { altKey: true });
  assert.equal(f.root.dataset['maximized'], 'true');
  key(field, 'Enter', { altKey: true, shiftKey: true });
  assert.equal(f.root.dataset['maximized'], undefined);
  assert.equal(dom.sessionStorage.getItem(`${MAX_PREFIX}${n.id}`), null);
  assert.equal(isMaximizeShortcut({ key: 'Enter', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false }), true);
  assert.equal(isMaximizeShortcut({ key: 'Enter', altKey: true, shiftKey: true, ctrlKey: true, metaKey: false }), false);
  f.dispose();
  // Every dialogue kind gets it (a plain question too), but not when not maximizable.
  const plainQ = buildDialogFrame(item([]), { actions: recorder().actions, takeFocus: false });
  assert.ok(plainQ.root.querySelector('.aura-dlg-max'));
  assert.equal(plainQ.root.dataset['hasMarkdown'], undefined);
  const sheet = buildDialogFrame(item([]), { actions: recorder().actions, takeFocus: false, maximizable: false });
  assert.equal(sheet.root.querySelector('.aura-dlg-max'), null);
});

test('maximize: Alt+Shift+Enter in a single-line input toggles maximize, never presses the primary button', async () => {
  resetDom();
  const r = recorder();
  const n = item([{ kind: 'input', id: 'q', label: 'Name' }]);
  const f = buildDialogFrame(n, { actions: r.actions, takeFocus: false });
  doc.body.appendChild(f.root);
  const input = f.root.querySelector<HTMLInputElement>('[data-ntf-input="q"]')!;
  key(input, 'Enter', { altKey: true, shiftKey: true });
  await flush();
  assert.equal(f.root.dataset['maximized'], 'true');
  assert.deepEqual(r.calls, []);
  f.setMaximized(false);
  f.dispose();
});

test('maximize: the phone hides the button and never applies the state', () => {
  resetDom();
  const n = item([md('x')]);
  getMaximizeMemory().set(n.id, true);
  desktopWidth(390);
  try {
    const f = buildDialogFrame(n, { actions: recorder().actions, takeFocus: false });
    const btn = f.root.querySelector<HTMLButtonElement>('.aura-dlg-max')!;
    assert.equal(btn.hidden, true);
    assert.equal(f.root.dataset['phone'], 'true');
    assert.equal(f.root.dataset['maximized'], undefined);
    key(f.root, 'Enter', { altKey: true, shiftKey: true });
    assert.equal(f.root.dataset['maximized'], undefined);
    // Back on the desktop (resize): the remembered state applies.
    desktopWidth(1280);
    dom.dispatchEvent(new dom.Event('resize'));
    assert.equal(btn.hidden, false);
    assert.equal(f.root.dataset['maximized'], 'true');
    f.dispose();
  } finally { desktopWidth(1280); getMaximizeMemory().clear(n.id); }
});

test('maximize: memory is per id, survives a storage error, and clears; a select popup re-anchors after the resize', async () => {
  const store = new Map<string, string>();
  const m = new MaximizeMemory({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => { store.delete(k); } });
  m.set('a', true);
  assert.equal(m.get('a'), true);
  assert.equal(m.get('b'), false);
  m.clear('a');
  assert.equal(m.get('a'), false);
  assert.equal(store.size, 0);
  const broken = new MaximizeMemory({ getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } });
  broken.set('a', true);
  assert.equal(broken.get('a'), true, 'memory fallback');

  resetDom();
  const n = item([{ kind: 'select', id: 'city', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, md('x')]);
  const f = buildDialogFrame(n, { actions: recorder().actions, takeFocus: false });
  doc.body.appendChild(f.root);
  const t = f.root.querySelector<HTMLElement>('[role="combobox"]')!;
  setRect(t, { left: 100, top: 100, width: 200, height: 24 });
  t.click();
  const lb = doc.querySelector<HTMLElement>('.aura-ctl-listbox')!;
  const before = lb.style.top;
  let resized = 0;
  doc.addEventListener('aura:dialog-resize', () => { resized++; });
  f.setMaximized(true);
  assert.equal(resized, 1, 'tells whoever positions against it');
  setRect(t, { left: 40, top: 300, width: 600, height: 24 });   // the field moved with the bigger dialogue
  await flush();
  await flush();
  assert.notEqual(lb.style.top, before);
  assert.equal(lb.style.left, '40px');
  f.setMaximized(false);
  f.dispose();
});
