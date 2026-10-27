/**
 * MarkdownField — the `markdown` notification component (phase 6), in the
 * shared `aura-ctl-*` style.
 *
 *   dialogue   the full area: a toolbar (Rendered ⇄ Source toggle with
 *              aria-pressed, Copy of the raw markdown), the rendered view
 *              (scrolls inside its area, `maxHeight` caps it) and the source
 *              — a monospace textarea, read-only unless `editable`. An
 *              editable field is a form field: its value is the textarea
 *              text (answer.values[id]), drafts and `required` work like an
 *              input. Switching back to Rendered re-renders the edited text.
 *   list / pop-up  a short plain-text preview clamped with "…" and a "Show"
 *              action that opens the dialogue (`renderMarkdownPreview`).
 *
 * Safety: the parser (lib/notifications/markdown.ts) has no HTML node, and
 * this renderer only uses createElement / textContent / setAttribute with
 * fixed names — never innerHTML. Links: absolute http(s) / mailto only,
 * opened like the card's text links (target _blank, noopener noreferrer,
 * no referrer; the host WebView turns that into a VIEW intent). Images are
 * never loaded: an http(s) image becomes a link with its alt text.
 *
 * Patch in place (`patchMarkdownField`): a new text from the sender updates
 * the source (unless the user has edited an editable field) and re-renders
 * the view — the view mode and the scroll position stay.
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import { markdownPreview, parseMarkdown, type Block, type Inline } from '../../../lib/notifications/markdown.ts';

type MarkdownComp = Extract<NonNullable<Notification['components']>[number], { kind: 'markdown' }>;

export const DEFAULT_MD_MAX_HEIGHT = 320;
const COPIED_MS = 1500;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderInline(nodes: Inline[], parent: Node): void {
  for (const n of nodes) {
    switch (n.t) {
      case 'text': parent.appendChild(document.createTextNode(n.v)); break;
      case 'br': parent.appendChild(el('br')); break;
      case 'code': parent.appendChild(el('code', 'aura-ntf-md-icode', n.v)); break;
      case 'strong': case 'em': case 'del': {
        const e = el(n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 'del');
        renderInline(n.c, e);
        parent.appendChild(e);
        break;
      }
      case 'link': {
        if (!n.href) {
          // Not http(s) / mailto: the text only, visibly not a link.
          const s = el('span', 'aura-ntf-md-badlink');
          s.title = 'Link removed (only http, https and mailto links open)';
          renderInline(n.c, s);
          parent.appendChild(s);
          break;
        }
        const a = el('a', 'aura-ntf-md-link');
        a.href = n.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.referrerPolicy = 'no-referrer';
        if (n.title) a.title = n.title;
        renderInline(n.c, a);
        parent.appendChild(a);
        break;
      }
      case 'image': {
        const label = `🖼 ${n.alt || 'image'}`;
        if (!n.href) { parent.appendChild(el('span', 'aura-ntf-md-badlink', `[${label}]`)); break; }
        const a = el('a', 'aura-ntf-md-link aura-ntf-md-img', label);
        a.href = n.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.referrerPolicy = 'no-referrer';
        a.title = `Image (not loaded in notifications): ${n.href}`;
        parent.appendChild(a);
        break;
      }
    }
  }
}

function renderBlocks(blocks: Block[], parent: Node, tight = false): void {
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': {
        const h = el(`h${b.level}` as 'h1', `aura-ntf-md-h aura-ntf-md-h${b.level}`);
        renderInline(b.c, h);
        parent.appendChild(h);
        break;
      }
      case 'paragraph': {
        if (tight) { renderInline(b.c, parent); break; }
        const p = el('p');
        renderInline(b.c, p);
        parent.appendChild(p);
        break;
      }
      case 'code': {
        const wrap = el('div', 'aura-ntf-md-code');
        if (b.lang) wrap.dataset['lang'] = b.lang;
        const pre = el('pre');
        pre.tabIndex = 0;   // scrolls horizontally with the keyboard
        const code = el('code', undefined, b.v);
        pre.appendChild(code);
        const copy = el('button', 'aura-ntf-md-btn aura-ntf-md-copy-code', 'Copy');
        copy.type = 'button';
        copy.setAttribute('aria-label', b.lang ? `Copy ${b.lang} code` : 'Copy code');
        copy.addEventListener('click', (e) => { e.stopPropagation(); void flashCopy(copy, b.v, 'Copy'); });
        wrap.append(copy, pre);
        parent.appendChild(wrap);
        break;
      }
      case 'list': {
        const list = el(b.ordered ? 'ol' : 'ul');
        if (b.ordered && b.start !== 1) list.setAttribute('start', String(b.start));
        if (b.items.some((it) => it.task !== null)) list.classList.add('aura-ntf-md-tasks');
        for (const it of b.items) {
          const li = el('li');
          if (it.task !== null) {
            li.dataset['task'] = it.task ? 'done' : 'open';
            const box = el('input');
            box.type = 'checkbox';
            box.checked = it.task;
            box.disabled = true;
            box.tabIndex = -1;
            box.className = 'aura-ntf-md-check';
            box.setAttribute('aria-label', it.task ? 'Done' : 'Not done');
            li.appendChild(box);
          }
          renderBlocks(it.c, li, !b.loose);
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
      case 'quote': {
        const q = el('blockquote');
        renderBlocks(b.c, q);
        parent.appendChild(q);
        break;
      }
      case 'table': {
        const wrap = el('div', 'aura-ntf-md-table');
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', 'Table');
        const table = el('table');
        const thead = el('thead');
        const hr = el('tr');
        b.head.forEach((c, k) => {
          const th = el('th');
          th.scope = 'col';
          const a = b.align[k];
          if (a) th.style.textAlign = a;
          renderInline(c, th);
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        if (b.rows.length) {
          const tbody = el('tbody');
          for (const row of b.rows) {
            const tr = el('tr');
            row.forEach((c, k) => {
              const td = el('td');
              const a = b.align[k];
              if (a) td.style.textAlign = a;
              renderInline(c, td);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
        }
        wrap.appendChild(table);
        parent.appendChild(wrap);
        break;
      }
      case 'hr': parent.appendChild(el('hr')); break;
    }
  }
}

/** Markdown → DOM (safe subset; see markdown.ts). */
export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  renderBlocks(parseMarkdown(src), frag);
  return frag;
}

// ── Clipboard ──────────────────────────────────────────────────────────

/** Clipboard API, else the hidden-textarea + execCommand fallback. Focus is kept. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = (window.navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    if (clip && typeof clip.writeText === 'function') { await clip.writeText(text); return true; }
  } catch { /* fall back */ }
  const active = document.activeElement as HTMLElement | null;
  try {
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch {
    return false;
  } finally {
    try { active?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }
}

async function flashCopy(btn: HTMLButtonElement, text: string, idle: string): Promise<void> {
  const ok = await copyText(text);
  btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
  btn.dataset['copied'] = ok ? 'true' : 'false';
  const t = (btn as HTMLButtonElement & { __t?: ReturnType<typeof setTimeout> }).__t;
  if (t) clearTimeout(t);
  (btn as HTMLButtonElement & { __t?: ReturnType<typeof setTimeout> }).__t = setTimeout(() => {
    btn.textContent = idle;
    delete btn.dataset['copied'];
  }, COPIED_MS);
}

// ── The field ──────────────────────────────────────────────────────────

interface FieldState {
  c: MarkdownComp;
  /** The sender's text the source last showed (edits are compared to it). */
  base: string;
  /** The text the rendered view shows. */
  rendered: string;
  view: 'rendered' | 'source';
}

type FieldEl = HTMLElement & { __md?: FieldState };

export interface MarkdownFieldOptions {
  base: string;
  /** Editable source changed (drafts). */
  onInput?: () => void;
}

function parts(w: HTMLElement) {
  return {
    area: w.querySelector<HTMLElement>(':scope > .aura-ntf-md-area')!,
    src: w.querySelector<HTMLTextAreaElement>(':scope > .aura-ntf-md-source')!,
    toggle: w.querySelector<HTMLButtonElement>('[data-md-action="view"]')!,
  };
}

function applyView(w: FieldEl): void {
  const st = w.__md!;
  const { area, src, toggle } = parts(w);
  const source = st.view === 'source';
  w.dataset['view'] = st.view;
  area.hidden = source;
  src.hidden = !source;
  toggle.setAttribute('aria-pressed', String(source));
  toggle.title = source ? 'Show the rendered view' : st.c.editable ? 'Edit the markdown source' : 'Show the markdown source';
  if (!source && st.rendered !== src.value) {
    const top = area.scrollTop;
    st.rendered = src.value;
    area.replaceChildren(renderMarkdown(src.value));
    area.scrollTop = top;
  }
}

function setMax(w: HTMLElement, c: MarkdownComp): void {
  if (c.maxHeight === 'auto') { w.dataset['max'] = 'auto'; w.style.removeProperty('--md-max'); return; }
  delete w.dataset['max'];
  w.style.setProperty('--md-max', `${typeof c.maxHeight === 'number' ? c.maxHeight : DEFAULT_MD_MAX_HEIGHT}px`);
}

export function renderMarkdownField(c: MarkdownComp, opts: MarkdownFieldOptions): HTMLElement {
  const w = el('div', 'aura-ntf-md aura-ctl-field') as FieldEl;
  const fid = `${opts.base}-md-${c.id}`;
  w.dataset['ntfMd'] = c.id;
  w.dataset['editable'] = String(!!c.editable);
  setMax(w, c);

  const head = el('div', 'aura-ntf-md-head');
  const label = el('label', `aura-ntf-label aura-ctl-label${c.label ? '' : ' aura-sr-only'}`, c.label ?? 'Markdown');
  label.htmlFor = `${fid}-src`;
  label.id = `${fid}-label`;
  if (c.editable && c.required) {
    const req = el('span', 'aura-ntf-req aura-ctl-req', ' *');
    req.setAttribute('aria-hidden', 'true');
    label.append(req, el('span', 'aura-sr-only', ' (required)'));
  }
  const tools = el('div', 'aura-ntf-md-tools');
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', `${c.label ?? 'Markdown'} tools`);
  const toggle = el('button', 'aura-ntf-md-btn', c.editable ? 'Edit' : 'Source');
  toggle.type = 'button';
  toggle.dataset['mdAction'] = 'view';
  toggle.dataset['focusKey'] = `md-view:${c.id}`;
  const copy = el('button', 'aura-ntf-md-btn', 'Copy');
  copy.type = 'button';
  copy.dataset['mdAction'] = 'copy';
  copy.dataset['focusKey'] = `md-copy:${c.id}`;
  copy.title = 'Copy the markdown';
  copy.setAttribute('aria-label', `Copy the markdown${c.label ? ` of ${c.label}` : ''}`);
  const live = el('span', 'aura-sr-only');
  live.setAttribute('aria-live', 'polite');
  tools.append(toggle, copy, live);
  head.append(label, tools);

  const area = el('div', 'aura-ntf-md-area');
  area.tabIndex = 0;   // keyboard scrolling
  area.setAttribute('role', 'region');
  area.setAttribute('aria-labelledby', label.id);
  area.dataset['focusKey'] = `md-area:${c.id}`;

  const src = el('textarea', 'aura-ntf-md-source aura-ctl-input');
  src.id = `${fid}-src`;
  src.value = c.text;
  src.spellcheck = false;
  src.autocomplete = 'off';
  src.wrap = 'off';
  src.dataset['focusKey'] = `md-src:${c.id}`;
  src.maxLength = 65_536;
  if (c.editable) {
    src.dataset['ntfField'] = c.id;
    if (c.required) { src.required = true; src.setAttribute('aria-required', 'true'); }
  } else {
    src.readOnly = true;
  }
  const err = el('p', 'aura-ctl-error');
  err.id = `${fid}-err`;
  err.hidden = true;
  src.setAttribute('aria-describedby', err.id);
  src.addEventListener('input', () => {
    src.removeAttribute('aria-invalid');
    err.hidden = true;
    err.textContent = '';
    opts.onInput?.();
  });

  w.append(head, area, src, err);
  w.__md = { c, base: c.text, rendered: '', view: c.view === 'source' ? 'source' : 'rendered' };
  // The rendered view is built even when Source shows first (cheap, and the toggle is instant).
  w.__md.rendered = c.text;
  area.appendChild(renderMarkdown(c.text));

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    w.__md!.view = w.__md!.view === 'source' ? 'rendered' : 'source';
    applyView(w);
  });
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    void flashCopy(copy, src.value, 'Copy').then(() => { live.textContent = copy.dataset['copied'] === 'true' ? 'Copied' : 'Copy failed'; });
  });
  applyView(w);
  return w;
}

/** The field's value (the source text). */
export function markdownFieldValue(w: HTMLElement): string {
  return w.querySelector<HTMLTextAreaElement>(':scope > .aura-ntf-md-source')?.value ?? '';
}

/** Set the source text (drafts / carried values); re-renders when the rendered view shows. */
export function setMarkdownFieldValue(w: HTMLElement, v: string): void {
  const f = w as FieldEl;
  const { src } = parts(w);
  if (!f.__md || src.value === v) return;
  src.value = v;
  applyView(f);
}

/**
 * View mode, scroll positions and the user's edit (carried over a rebuild).
 * `edited` is the source text only when the user changed an editable field —
 * otherwise the new render shows the sender's (possibly new) text.
 */
export interface MarkdownFieldState { view: 'rendered' | 'source'; areaTop: number; srcTop: number; edited: string | null }
export function markdownFieldState(w: HTMLElement): MarkdownFieldState | null {
  const f = w as FieldEl;
  if (!f.__md) return null;
  const { area, src } = parts(w);
  const edited = f.__md.c.editable && src.value !== f.__md.base ? src.value : null;
  return { view: f.__md.view, areaTop: area.scrollTop, srcTop: src.scrollTop, edited };
}
export function applyMarkdownFieldState(w: HTMLElement, s: MarkdownFieldState): void {
  const f = w as FieldEl;
  if (!f.__md) return;
  f.__md.view = s.view;
  if (s.edited !== null && f.__md.c.editable) parts(w).src.value = s.edited;
  applyView(f);
  const { area, src } = parts(w);
  area.scrollTop = s.areaTop;
  src.scrollTop = s.srcTop;
}

/**
 * The sender changed the text (patch in place): the source follows unless
 * the user edited it; the rendered view re-renders keeping its scroll; the
 * view mode stays.
 */
export function patchMarkdownField(w: HTMLElement, c: MarkdownComp): void {
  const f = w as FieldEl;
  const st = f.__md;
  if (!st) return;
  const { src } = parts(w);
  const edited = !!c.editable && src.value !== st.base;
  st.c = c;
  setMax(w, c);
  if (c.text === st.base) return;
  st.base = c.text;
  if (!edited) {
    const top = src.scrollTop;
    const focused = document.activeElement === src;
    const sel = focused ? [src.selectionStart, src.selectionEnd] as const : null;
    src.value = c.text;
    src.scrollTop = top;
    if (sel) { try { src.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ } }
  }
  applyView(f);
}

// ── Preview (list / pop-up) ────────────────────────────────────────────

export const PREVIEW_CHARS = 240;

export function renderMarkdownPreview(c: MarkdownComp, onShow: () => void): HTMLElement {
  const w = el('div', 'aura-ntf-md-preview');
  w.dataset['ntfMdPreview'] = c.id;
  if (c.label) w.appendChild(el('span', 'aura-ntf-md-preview-label', c.label));
  const p = el('p', 'aura-ntf-md-preview-text');
  w.appendChild(p);
  const show = el('button', 'aura-ntf-link-btn aura-ntf-md-show', 'Show');
  show.type = 'button';
  show.dataset['focusKey'] = `md-show:${c.id}`;
  show.setAttribute('aria-haspopup', 'dialog');
  show.setAttribute('aria-label', `Show ${c.label ?? 'the full text'}`);
  show.addEventListener('click', (e) => { e.stopPropagation(); onShow(); });
  w.appendChild(show);
  patchMarkdownPreview(w, c);
  return w;
}

export function patchMarkdownPreview(w: HTMLElement, c: MarkdownComp): void {
  const p = w.querySelector<HTMLElement>('.aura-ntf-md-preview-text');
  if (!p) return;
  const { text, truncated } = markdownPreview(c.text, PREVIEW_CHARS);
  if (p.textContent !== text) p.textContent = text;
  w.dataset['truncated'] = String(truncated);
}
