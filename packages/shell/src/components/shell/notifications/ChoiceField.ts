/**
 * ChoiceField — the `select` (dropdown) and `combobox` (searchable)
 * notification components (phase 6), in the shared `aura-ctl-*` style.
 *
 * ARIA (WAI-ARIA APG):
 *   select    "select-only combobox": a <button role="combobox"
 *             aria-haspopup="listbox"> + a listbox; focus stays on the button,
 *             the active option is `aria-activedescendant`.
 *             Closed: ↓ / ↑ / Enter / Space / Alt+↓ open; Home / End open at
 *             the first / last; typing jumps (typeahead) without opening.
 *             Open: ↑ ↓ Home End PageUp PageDown move, typing jumps, Enter /
 *             Space / Tab choose, Escape / Alt+↑ close without choosing.
 *   combobox  "editable combobox with list autocomplete": an <input
 *             role="combobox" aria-autocomplete="list">; typing filters,
 *             ↑ ↓ Home End move in the list, Enter chooses the active option
 *             (or keeps the typed text with `allowCustom`), Escape closes
 *             (a second Escape clears the text), Alt+↓ / Alt+↑ open / close.
 *             Leaving the field settles it (exact label → that option; free
 *             text only with `allowCustom`, else the last choice comes back).
 *
 * The popup list is a `position:fixed` panel appended to the nearest
 * `[data-ntf-popup-host]` (the desktop decision, whose siblings are inert)
 * or <body>, placed under the field (or above it when there is no room) in
 * body px (the shell zooms <body>), and re-placed every frame while open. So
 * it is never clipped by a window slot, a sheet or a dialogue's overflow.
 * While open the field carries `data-own-escape`, so Escape closes the list
 * and not the dialogue / panel around it. Navigation keys never propagate
 * (the notification list's arrow roving must not see them), and list clicks
 * don't either (they are not "outside clicks" for the list or pop-ups).
 *
 * Patch-in-place safe: the value lives on the field (`choiceValue` /
 * `setChoiceValue`); a re-render carries it over like any other field.
 * Every sender string goes through textContent.
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import {
  comboStateFor, comboValue, exactChoice, filterChoices, navigate, settleCombo, typeahead,
  type Choice, type ComboState, type NavKey,
} from '../../../lib/notifications/choices.ts';
import { bodyScale } from './placement.ts';

type Comp = NonNullable<Notification['components']>[number];
type SelectComp = Extract<Comp, { kind: 'select' }>;
type ComboComp = Extract<Comp, { kind: 'combobox' }>;

export interface ChoiceFieldOptions {
  /** Unique prefix for element ids. */
  base: string;
  /** A choice was made (select, or a combobox option / committed free text). */
  onChange: (value: string | undefined) => void;
}

interface FieldApi {
  get(): string | undefined;
  set(v: string | undefined): void;
  close(): void;
}
const apis = new WeakMap<HTMLElement, FieldApi>();

/** The field's current value (option id, or combobox free text). */
export function choiceValue(wrap: HTMLElement): string | undefined {
  return apis.get(wrap)?.get();
}
/** Set the value without firing onChange (drafts, re-render carry-over). */
export function setChoiceValue(wrap: HTMLElement, v: string | undefined): void {
  apis.get(wrap)?.set(v);
}

const NAV: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']);
const TYPEAHEAD_RESET_MS = 600;
const GAP = 4;
const MAX_LIST_PX = 280;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function labelFor(wrap: HTMLElement, c: SelectComp | ComboComp, fid: string): HTMLLabelElement {
  const label = el('label', 'aura-ntf-label aura-ctl-label', c.label ?? c.id);
  label.htmlFor = fid;
  label.id = `${fid}-label`;
  if (c.required) {
    const req = el('span', 'aura-ntf-req aura-ctl-req', ' *');
    req.setAttribute('aria-hidden', 'true');
    label.append(req, el('span', 'aura-sr-only', ' (required)'));
  }
  wrap.appendChild(label);
  return label;
}

function footFor(wrap: HTMLElement, control: HTMLElement, fid: string): void {
  const foot = el('div', 'aura-ctl-field-foot');
  const err = el('p', 'aura-ctl-error');
  err.id = `${fid}-err`;
  err.hidden = true;
  foot.appendChild(err);
  control.setAttribute('aria-describedby', err.id);
  wrap.appendChild(foot);
}

function clearError(control: HTMLElement, wrap: HTMLElement): void {
  control.removeAttribute('aria-invalid');
  const err = wrap.querySelector<HTMLElement>('.aura-ctl-error');
  if (err) { err.hidden = true; err.textContent = ''; }
}

/**
 * The listbox popup shared by both kinds: open / close / place / render.
 * `owner` gets aria-expanded / aria-activedescendant.
 */
function createPopup(wrap: HTMLElement, owner: HTMLElement, anchor: HTMLElement, listId: string, labelledBy: string) {
  const list = el('ul', 'aura-ctl-listbox');
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', labelledBy);
  list.tabIndex = -1;
  // Keep focus in the field while the mouse picks an option.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  // The list lives outside the card / panel: its clicks must not count as an
  // "outside click" for the notification list or a pop-up.
  list.addEventListener('click', (e) => e.stopPropagation());
  let open = false;
  let raf = 0;
  let outside: ((e: Event) => void) | null = null;
  let onClose: (() => void) | null = null;

  const place = () => {
    if (!open) return;
    if (!anchor.isConnected) { close(); return; }
    const s = bodyScale() || 1;
    const br = document.body.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const below = vh - r.bottom - GAP;
    const above = r.top - GAP;
    const want = Math.min(MAX_LIST_PX * s, list.scrollHeight * s || MAX_LIST_PX * s);
    const up = below < Math.min(want, 160 * s) && above > below;
    const room = Math.max(80 * s, (up ? above : below) - 8);
    list.style.maxHeight = `${Math.floor(Math.min(MAX_LIST_PX * s, room) / s)}px`;
    list.style.left = `${Math.round((r.left - br.left) / s)}px`;
    list.style.minWidth = `${Math.round(r.width / s)}px`;
    list.style.maxWidth = `${Math.max(Math.round(r.width / s), 320)}px`;
    if (up) {
      list.style.top = '';
      list.style.bottom = `${Math.round((br.bottom - r.top + GAP) / s)}px`;
      list.dataset['placement'] = 'top';
    } else {
      list.style.bottom = '';
      list.style.top = `${Math.round((r.bottom - br.top + GAP) / s)}px`;
      list.dataset['placement'] = 'bottom';
    }
    raf = requestAnimationFrame(place);
  };

  function show(closed: () => void): void {
    if (open) return;
    open = true;
    onClose = closed;
    const host = wrap.closest<HTMLElement>('[data-ntf-popup-host]') ?? document.body;
    host.appendChild(list);
    owner.setAttribute('aria-expanded', 'true');
    wrap.dataset['open'] = 'true';
    wrap.dataset['ownEscape'] = 'true';
    place();
    outside = (e: Event) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (!path.includes(wrap) && !path.includes(list)) close();
    };
    document.addEventListener('pointerdown', outside, true);
  }

  function close(): void {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    list.remove();
    owner.setAttribute('aria-expanded', 'false');
    owner.removeAttribute('aria-activedescendant');
    delete wrap.dataset['open'];
    delete wrap.dataset['ownEscape'];
    if (outside) { document.removeEventListener('pointerdown', outside, true); outside = null; }
    const cb = onClose;
    onClose = null;
    cb?.();
  }

  function setActive(i: number): void {
    const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    items.forEach((it, k) => { it.dataset['active'] = String(k === i); });
    const cur = items[i];
    if (cur) {
      owner.setAttribute('aria-activedescendant', cur.id);
      // Keep the active option in view (the list scrolls, the page does not).
      const top = cur.offsetTop;
      const bottom = top + cur.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    } else {
      owner.removeAttribute('aria-activedescendant');
    }
  }

  return { list, show, close, setActive, isOpen: () => open };
}

function optionItem(id: string, label: string, selected: boolean): HTMLLIElement {
  const li = el('li', 'aura-ctl-option');
  li.id = id;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(selected));
  li.appendChild(el('span', 'aura-ctl-option-text', label));
  return li;
}

// ── select ────────────────────────────────────────────────────────────────

export function renderSelectField(c: SelectComp, opts: ChoiceFieldOptions): HTMLElement {
  const wrap = el('div', 'aura-ntf-field aura-ctl-field aura-ctl-choicefield');
  wrap.dataset['ntfChoice'] = c.id;
  wrap.dataset['kind'] = 'select';
  const fid = `${opts.base}-sel-${c.id}`;
  const label = labelFor(wrap, c, fid);
  const trigger = el('button', 'aura-ctl-select');
  trigger.type = 'button';
  trigger.id = fid;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${fid}-list`);
  trigger.setAttribute('aria-labelledby', `${label.id} ${fid}`);
  trigger.dataset['ntfField'] = c.id;
  trigger.dataset['focusKey'] = `sel:${c.id}`;
  if (c.required) trigger.setAttribute('aria-required', 'true');
  const shown = el('span', 'aura-ctl-select-value');
  const chev = el('span', 'aura-ctl-select-chev');
  chev.setAttribute('aria-hidden', 'true');
  trigger.append(shown, chev);
  wrap.appendChild(trigger);
  footFor(wrap, trigger, fid);

  const options: Choice[] = c.options;
  let value: string | undefined = options.some((o) => o.id === c.default) ? c.default : undefined;
  let active = -1;
  let buffer = '';
  let bufferTimer: ReturnType<typeof setTimeout> | null = null;
  const pop = createPopup(wrap, trigger, trigger, `${fid}-list`, label.id);

  const render = () => {
    const o = options.find((x) => x.id === value);
    shown.textContent = o ? o.label : (c.placeholder ?? 'Choose…');
    trigger.dataset['empty'] = String(!o);
    trigger.title = o ? o.label : '';
  };
  const renderList = () => {
    pop.list.replaceChildren(...options.map((o, i) => {
      const li = optionItem(`${fid}-opt-${i}`, o.label, o.id === value);
      li.addEventListener('click', () => { choose(i); trigger.focus({ preventScroll: true }); });
      li.addEventListener('mousemove', () => { if (active !== i) { active = i; pop.setActive(i); } });
      return li;
    }));
  };
  const choose = (i: number, keepBuffer = false) => {
    const o = options[i];
    if (!keepBuffer) buffer = '';
    pop.close();
    if (!o) return;
    clearError(trigger, wrap);
    if (o.id === value) return;
    value = o.id;
    render();
    opts.onChange(value);
  };
  const openAt = (i: number) => {
    renderList();
    pop.show(() => {});
    active = i >= 0 ? i : Math.max(0, options.findIndex((o) => o.id === value));
    pop.setActive(active);
  };
  const typeChar = (ch: string) => {
    buffer += ch;
    if (bufferTimer) clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => { buffer = ''; }, TYPEAHEAD_RESET_MS);
    const from = pop.isOpen() ? active : options.findIndex((o) => o.id === value);
    const hit = typeahead(options, buffer, from);
    if (hit < 0) return;
    if (pop.isOpen()) { active = hit; pop.setActive(hit); }
    else choose(hit, true);   // closed select: typeahead changes the value (APG)
  };

  trigger.addEventListener('click', () => {
    if (pop.isOpen()) pop.close();
    else openAt(-1);
  });
  trigger.addEventListener('keydown', (e) => {
    const k = e.key;
    const open = pop.isOpen();
    // Arrow / Home / End / Page keys belong to this field (not the list's roving).
    if (NAV.has(k)) e.stopPropagation();
    if (e.altKey && (k === 'ArrowDown' || k === 'ArrowUp')) {
      e.preventDefault();
      if (k === 'ArrowDown' && !open) openAt(-1);
      else if (k === 'ArrowUp' && open) choose(active);
      return;
    }
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); openAt(-1); return; }
      if (k === 'Home') { e.preventDefault(); openAt(0); return; }
      if (k === 'End') { e.preventDefault(); openAt(options.length - 1); return; }
      if (k.length === 1 && !e.ctrlKey && !e.metaKey && k !== ' ') { e.preventDefault(); typeChar(k); }
      return;
    }
    if (NAV.has(k)) { e.preventDefault(); active = navigate(k as NavKey, active, options.length); pop.setActive(active); return; }
    if (k === 'Enter' || (k === ' ' && !buffer)) { e.preventDefault(); choose(active); return; }
    if (k === 'Tab') { choose(active); return; }   // APG: Tab picks and moves on
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); buffer = ''; pop.close(); return; }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); typeChar(k); }
  });
  trigger.addEventListener('blur', () => { if (pop.isOpen()) pop.close(); });

  render();
  apis.set(wrap, {
    get: () => value,
    set: (v) => { value = options.some((o) => o.id === v) ? v : undefined; render(); },
    close: () => pop.close(),
  });
  return wrap;
}

// ── combobox ──────────────────────────────────────────────────────────────

export function renderComboboxField(c: ComboComp, opts: ChoiceFieldOptions): HTMLElement {
  const wrap = el('div', 'aura-ntf-field aura-ctl-field aura-ctl-choicefield');
  wrap.dataset['ntfChoice'] = c.id;
  wrap.dataset['kind'] = 'combobox';
  const fid = `${opts.base}-cmb-${c.id}`;
  const label = labelFor(wrap, c, fid);
  const box = el('div', 'aura-ctl-combo');
  const input = el('input', 'aura-ntf-input aura-ctl-input aura-ctl-combo-input');
  input.type = 'text';
  input.id = fid;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 200;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${fid}-list`);
  input.dataset['ntfField'] = c.id;
  input.dataset['focusKey'] = `cmb:${c.id}`;
  if (c.placeholder) input.placeholder = c.placeholder;
  else input.placeholder = c.allowCustom ? 'Type or choose…' : 'Type to search…';
  if (c.required) { input.setAttribute('aria-required', 'true'); }
  const toggle = el('button', 'aura-ctl-combo-toggle');
  toggle.type = 'button';
  toggle.tabIndex = -1;
  toggle.setAttribute('aria-label', `Show options for ${c.label ?? c.id}`);
  toggle.setAttribute('aria-controls', `${fid}-list`);
  toggle.setAttribute('aria-expanded', 'false');
  box.append(input, toggle);
  wrap.appendChild(box);
  footFor(wrap, input, fid);
  const status = el('span', 'aura-sr-only');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  wrap.appendChild(status);

  const options: Choice[] = c.options;
  let state: ComboState = comboStateFor(options, c.default, c.allowCustom);
  let committed: string | undefined = comboValue(state, c.allowCustom);
  /** The last settled state (what a strict combobox falls back to). */
  let settled: ComboState = { ...state };
  let shownList: Array<{ kind: 'opt'; o: Choice } | { kind: 'custom'; text: string }> = [];
  let active = -1;
  const pop = createPopup(wrap, input, box, `${fid}-list`, label.id);

  const syncToggle = () => toggle.setAttribute('aria-expanded', String(pop.isOpen()));
  const commit = () => {
    const v = comboValue(state, c.allowCustom);
    if (v === committed) return;
    committed = v;
    clearError(input, wrap);
    opts.onChange(v);
  };
  const renderList = (query: string) => {
    const hits = filterChoices(options, query);
    const t = query.trim();
    shownList = hits.map((o) => ({ kind: 'opt' as const, o }));
    if (c.allowCustom && t && !exactChoice(options, t)) shownList.unshift({ kind: 'custom', text: t });
    const items = shownList.map((x, i) => {
      const li = x.kind === 'opt'
        ? optionItem(`${fid}-opt-${i}`, x.o.label, state.selected === x.o.id)
        : optionItem(`${fid}-opt-${i}`, `Use “${x.text}”`, false);
      if (x.kind === 'custom') li.dataset['custom'] = 'true';
      li.addEventListener('click', () => pick(i));
      li.addEventListener('mousemove', () => { if (active !== i) { active = i; pop.setActive(i); } });
      return li;
    });
    if (!items.length) {
      const empty = el('li', 'aura-ctl-listbox-empty', 'No matches');
      empty.setAttribute('role', 'presentation');
      pop.list.replaceChildren(empty);
    } else {
      pop.list.replaceChildren(...items);
    }
    status.textContent = items.length ? `${hits.length} option${hits.length === 1 ? '' : 's'}` : 'No matches';
  };
  const open = (query: string, at = -1) => {
    renderList(query);
    pop.show(syncToggle);
    syncToggle();
    active = at >= 0 ? Math.min(at, shownList.length - 1) : -1;
    pop.setActive(active);
  };
  const pick = (i: number) => {
    const x = shownList[i];
    if (!x) return;
    state = x.kind === 'opt' ? { selected: x.o.id, text: x.o.label } : { text: x.text };
    settled = { ...state };
    input.value = state.text;
    pop.close();
    commit();
  };
  const settle = () => {
    state = settleCombo(options, input.value, c.allowCustom, settled);
    settled = { ...state };
    input.value = state.text;
    commit();
  };

  input.addEventListener('input', () => {
    // Typing un-chooses the option unless the text still is its label.
    const exact = exactChoice(options, input.value);
    state = exact && state.selected === exact.id ? state : { text: input.value };
    open(input.value);
  });
  input.addEventListener('keydown', (e) => {
    const k = e.key;
    const isOpen = pop.isOpen();
    if (NAV.has(k)) e.stopPropagation();
    if (e.altKey && k === 'ArrowDown') { e.preventDefault(); if (!isOpen) open(''); return; }
    if (e.altKey && k === 'ArrowUp') { e.preventDefault(); if (isOpen) pop.close(); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) { open(state.selected !== undefined ? '' : input.value, k === 'ArrowDown' ? 0 : Number.MAX_SAFE_INTEGER); active = k === 'ArrowDown' ? 0 : shownList.length - 1; pop.setActive(active); return; }
      active = navigate(k, active, shownList.length);
      pop.setActive(active);
      return;
    }
    if (isOpen && (k === 'PageDown' || k === 'PageUp' || ((k === 'Home' || k === 'End') && (e.ctrlKey || active >= 0)))) {
      e.preventDefault();
      active = navigate(k as NavKey, active, shownList.length);
      pop.setActive(active);
      return;
    }
    if (k === 'Enter') {
      if (isComposing(e)) return;
      if (isOpen && active >= 0) { e.preventDefault(); e.stopPropagation(); pick(active); return; }
      if (isOpen) { e.preventDefault(); e.stopPropagation(); pop.close(); settle(); return; }
      settle();   // closed: settle, and let Enter reach the dialogue (presses Submit)
      return;
    }
    if (k === 'Escape') {
      if (isOpen) { e.preventDefault(); e.stopPropagation(); pop.close(); return; }
      if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; state = { text: '' }; settled = { text: '' }; commit(); }
      return;
    }
    if (k === 'Tab' && isOpen) { pop.close(); }
  });
  input.addEventListener('blur', () => { pop.close(); settle(); });
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', () => {
    if (pop.isOpen()) pop.close();
    else { input.focus({ preventScroll: true }); open(''); }
  });

  input.value = state.text;
  apis.set(wrap, {
    get: () => comboValue(state, c.allowCustom),
    set: (v) => { state = comboStateFor(options, v, c.allowCustom); settled = { ...state }; input.value = state.text; committed = comboValue(state, c.allowCustom); },
    close: () => pop.close(),
  });
  return wrap;
}

function isComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
