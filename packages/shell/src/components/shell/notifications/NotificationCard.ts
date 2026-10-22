/**
 * NotificationCard — the ONE DOM renderer for a notification, shared by the
 * list (desktop drop-up and phone sheet) and the pop-ups.
 *
 * Safe by construction: every sender string goes into a text node or an
 * attribute via the DOM API; links come from `textSegments()` (http(s)
 * only); images only from `safeImageSrc()`. No innerHTML with sender data.
 *
 * Component semantics:
 *   input / options  — values are collected for buttons; an input submit
 *                      (Enter, Ctrl+Enter when multiline, or change) and an
 *                      options choice send an `interact` to the sender
 *   select / combobox — phase 6 (ChoiceField.ts): a dropdown and a searchable
 *                      select; a choice sends an `interact` (list / pop-up),
 *                      in a dialogue it is local form state like the others
 *   button           — action 'resolve' → resolve {buttonId, values}
 *                      (required inputs checked first); 'dismiss' → dismiss;
 *                      'link' → open href (http(s) only); none → interact
 *   progress         — determinate (0..1) or indeterminate (null)
 *
 * Locked (phase 4): no dismiss (no ✕, no Delete key, no 'dismiss' buttons),
 * a lock tag, and in the list a secondary ⋯ menu with "Force remove…" that
 * asks first (ConfirmInline: "Remove anyway? The sender will be told.").
 * Pop-ups of Locked notifications have no close ✕; they hide on their timer.
 *
 * Re-rendering (`updateNotificationCard`) keeps typed values, the checked
 * options and — only if focus was already inside the card — the focus and
 * caret. Rendering never calls focus() on its own, so pop-ups never steal
 * focus.
 *
 * Styles: NotificationStyles.astro (is:global; runtime nodes).
 */
import type {
  InteractionValue, InteractPayload, Notification,
} from '../../../lib/notifications/api.ts';
import type { ActionResult } from '../../../lib/notifications/actions.ts';
import {
  PRIORITY_LABEL, iconSpec, isoTime, relativeTime, safeHttpUrl, safeImageSrc, senderLabel, textSegments,
  type AppLookup,
} from '../../../lib/notifications/format.ts';
import { contextTarget, goToContext, type WindowHost } from '../../../lib/notifications/context.ts';
import { createConfirmInline, type ConfirmInline } from './ConfirmInline.ts';
import { CARD_CONTROL_SELECTOR, opensDialogOnActivate } from '../../../lib/notifications/dialogs.ts';
import { fieldErrorsFrom, missingRequired, planCardUpdate, sendsOnFieldChange } from '../../../lib/notifications/cardPatch.ts';
import { answerFor, behaviourValidates, planButtons, type PlannedButton } from '../../../lib/notifications/buttons.ts';
import { draftValuesFor, getDrafts } from '../../../lib/notifications/drafts.ts';
import { isLocked } from './placement.ts';
import { choiceValue, renderComboboxField, renderSelectField, setChoiceValue } from './ChoiceField.ts';
import { optionsDisplay } from '../../../lib/notifications/choices.ts';

/** The item each rendered card currently shows (for patch-in-place). */
const shown = new WeakMap<HTMLElement, Notification>();

type Component = NonNullable<Notification['components']>[number];

export interface CardActions {
  /** Phase 4 answers carry `outcome` ('submitted' | 'cancelled'). */
  resolve(id: string, answer: Record<string, unknown>): Promise<ActionResult>;
  dismiss(id: string): Promise<ActionResult>;
  interact(id: string, payload: InteractPayload): Promise<ActionResult>;
  /** Phase 4: user force-remove (Locked), after the inline confirm. */
  forceRemove(id: string): Promise<ActionResult>;
}

export interface CardOptions {
  /** 'dialog' (phase 4): the body of an open dialogue — always expanded, no ✕ / Answer / Go to task. */
  mode: 'list' | 'toast' | 'dialog';
  actions: CardActions;
  appLookup?: AppLookup;
  now?: number;
  /** Dialogue cards in the list start collapsed behind "Answer". */
  expanded?: boolean;
  /** Pop-up "Answer" / body click: open the list at this item. */
  onOpen?: (n: Notification) => void;
  /**
   * Phase 4: "Answer" on a dialogue opens it as a dialogue (over its window,
   * floating, or as a phone sheet). Return false to fall back to the inline
   * answer form (list) / `onOpen` (pop-up).
   */
  onAnswer?: (n: Notification) => boolean;
  /** Called after Go to task ran (e.g. to close the panel). */
  onNavigated?: (n: Notification) => void;
  /**
   * Phase 4 "Later" (role later / default): hide locally. The dialogue frame
   * passes it when the dialogue can be put off; without it a dialogue-mode
   * card shows no Later. Pop-ups fall back to `onClose`, the list collapses.
   */
  onLater?: (n: Notification) => void;
  /** Called when the card wants to be closed (toast close button). */
  onClose?: (n: Notification) => void;
  /** Window functions for Go to task (default: window). */
  host?: WindowHost;
}

const SPRITE = '/api/os/icons.svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

let uid = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function spriteIcon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'aura-icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${SPRITE}#${name}`);
  svg.appendChild(use);
  return svg;
}

function openExternal(href: string): void {
  const safe = safeHttpUrl(href);
  if (!safe) return;
  window.open(safe, '_blank', 'noopener,noreferrer');
}

// ── Drafts (phase 4): saved on every input / change, restored on render,
// kept in sync between two renderings of the same item in this tab. ──
let syncing = false;

function saveDraft(card: HTMLElement, n: Notification, componentId: string): void {
  if (syncing) return;
  const v = collectValues(card, n)[componentId];
  const c = (n.components ?? []).find((x) => x.id === componentId);
  const value = v ?? (c?.kind === 'options' && c.multiple ? [] : c?.kind === 'select' || c?.kind === 'combobox' ? '' : undefined);
  if (value === undefined) return;
  getDrafts().set(n.id, componentId, value);
  syncing = true;
  try {
    document.querySelectorAll<HTMLElement>(`.aura-ntf[data-id="${CSS.escape(n.id)}"]`).forEach((other) => {
      if (other !== card) applyValues(other, n, { [componentId]: value });
    });
  } finally { syncing = false; }
}

/** Set field values in place (never replaces a control; skips the focused field). */
function applyValues(card: HTMLElement, n: Notification, values: Record<string, InteractionValue>): void {
  const was = syncing;
  syncing = true;
  try {
    for (const c of n.components ?? []) {
      const v = values[c.id ?? ''];
      if (v === undefined) continue;
      if (c.kind === 'input' && typeof v === 'string') {
        const f = card.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-ntf-input="${CSS.escape(c.id)}"]`);
        if (!f || f.value === v || document.activeElement === f) continue;
        f.value = v;
        f.dispatchEvent(new Event('input'));   // counter / auto-grow; the draft save is suppressed
      } else if (c.kind === 'options') {
        const want = new Set(Array.isArray(v) ? v : [v]);
        card.querySelectorAll<HTMLInputElement>(`input[data-ntf-options="${CSS.escape(c.id)}"]`).forEach((i) => { i.checked = want.has(i.value); });
      } else if ((c.kind === 'select' || c.kind === 'combobox') && typeof v === 'string') {
        const w = card.querySelector<HTMLElement>(`[data-ntf-choice="${CSS.escape(c.id)}"]`);
        if (!w || w.contains(document.activeElement)) continue;
        setChoiceValue(w, v || undefined);
      }
    }
  } finally { syncing = was; }
}

/** Current values of the card's input / options components, by component id. */
export function collectValues(card: HTMLElement, n: Notification): Record<string, InteractionValue> {
  const out: Record<string, InteractionValue> = {};
  for (const c of n.components ?? []) {
    if (c.kind === 'input') {
      const f = card.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-ntf-input="${CSS.escape(c.id)}"]`);
      if (f) out[c.id] = f.value;
    } else if (c.kind === 'options') {
      const checked = [...card.querySelectorAll<HTMLInputElement>(`input[data-ntf-options="${CSS.escape(c.id)}"]:checked`)]
        .map((i) => i.value);
      if (c.multiple) out[c.id] = checked;
      else if (checked[0] !== undefined) out[c.id] = checked[0];
    } else if (c.kind === 'select' || c.kind === 'combobox') {
      const w = card.querySelector<HTMLElement>(`[data-ntf-choice="${CSS.escape(c.id)}"]`);
      const v = w ? choiceValue(w) : undefined;
      if (v !== undefined) out[c.id] = v;
    }
  }
  return out;
}

function setStatus(card: HTMLElement, msg: string, kind: 'error' | 'info' = 'error'): void {
  const s = card.querySelector<HTMLElement>('.aura-ntf-status');
  if (!s) return;
  s.textContent = msg;
  s.dataset['kind'] = kind;
  s.hidden = !msg;
}

/**
 * Run an action with the card busy. With a pressed button: it spins and the
 * card's other buttons are disabled until the server answers. The surface
 * never closes here — it closes only when the store reports the item
 * resolved / removed (i.e. after a 2xx). On failure: the message in the
 * card, field errors inline (400 details), everything re-enabled, the
 * draft kept.
 */
async function runAction(card: HTMLElement, p: Promise<ActionResult>, busyEl?: HTMLElement): Promise<boolean> {
  card.setAttribute('aria-busy', 'true');
  const others: HTMLButtonElement[] = [];
  if (busyEl instanceof HTMLButtonElement) {
    busyEl.disabled = true; busyEl.dataset['loading'] = 'true'; busyEl.setAttribute('aria-busy', 'true');
    card.querySelectorAll<HTMLButtonElement>('.aura-ctl-btn').forEach((b) => { if (b !== busyEl && !b.disabled) { b.disabled = true; others.push(b); } });
  }
  try {
    const r = await p;
    if (!r.ok) {
      setStatus(card, r.error);
      markFieldErrors(card, r.details);
    } else setStatus(card, '');
    return r.ok;
  } finally {
    card.removeAttribute('aria-busy');
    for (const b of others) if (b.isConnected) b.disabled = false;
    if (busyEl instanceof HTMLButtonElement) { delete busyEl.dataset['loading']; busyEl.removeAttribute('aria-busy'); }
    if (busyEl instanceof HTMLButtonElement && busyEl.isConnected) busyEl.disabled = false;
  }
}

/** Server-side field errors (400 details) → inline, focus the first. */
function markFieldErrors(card: HTMLElement, details: unknown): void {
  const errs = fieldErrorsFrom(details, shown.get(card)?.components);
  let first: HTMLElement | null = null;
  for (const [id, msg] of Object.entries(errs)) {
    const f = card.querySelector<HTMLElement>(`[data-ntf-input="${CSS.escape(id)}"], [data-ntf-field="${CSS.escape(id)}"]`);
    f?.setAttribute('aria-invalid', 'true');
    const box = f?.closest('.aura-ctl-field') ?? card.querySelector(`[data-ntf-options="${CSS.escape(id)}"]`)?.closest('.aura-ctl-group');
    const m = box?.querySelector<HTMLElement>('.aura-ctl-error');
    if (m) { m.textContent = msg; m.hidden = false; }
    first ??= f;
  }
  first?.focus({ preventScroll: false });
}

function renderIcon(n: Notification, lookup?: AppLookup): HTMLElement {
  const box = el('span', 'aura-ntf-icon');
  box.setAttribute('aria-hidden', 'true');
  const spec = iconSpec(n, lookup);
  if (spec.kind === 'image') {
    const img = el('img');
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = spec.src;
    img.addEventListener('error', () => { img.remove(); box.textContent = senderLabel(n, lookup).glyph; }, { once: true });
    box.appendChild(img);
  } else if (spec.kind === 'sprite') {
    box.appendChild(spriteIcon(spec.name));
  } else {
    box.textContent = spec.text;
    box.dataset['len'] = String([...spec.text].length);
  }
  return box;
}

function renderText(n: Notification): HTMLElement {
  const p = el('p', 'aura-ntf-text');
  for (const seg of textSegments(n.text)) {
    if (seg.kind === 'text') p.appendChild(document.createTextNode(seg.text));
    else {
      const a = el('a', 'aura-ntf-link', seg.text);
      a.href = seg.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.dataset['focusKey'] = `link:${seg.href}`;
      p.appendChild(a);
    }
  }
  return p;
}

function renderComponent(card: HTMLElement, n: Notification, c: Component, opts: CardOptions, base: string): HTMLElement | null {
  switch (c.kind) {
    case 'input': {
      const wrap = el('div', 'aura-ntf-field aura-ctl-field');
      const fid = `${base}-in-${c.id}`;
      const label = el('label', 'aura-ntf-label aura-ctl-label', c.label ?? c.id);
      label.htmlFor = fid;
      if (c.required) {
        const req = el('span', 'aura-ntf-req aura-ctl-req', ' *');
        req.setAttribute('aria-hidden', 'true');
        label.appendChild(req);
        label.appendChild(el('span', 'aura-sr-only', ' (required)'));
      }
      const field = c.multiline ? el('textarea', 'aura-ntf-input aura-ctl-input') : el('input', 'aura-ntf-input aura-ctl-input');
      field.id = fid;
      if (field instanceof HTMLInputElement) field.type = 'text';
      else field.rows = 3;
      field.dataset['ntfInput'] = c.id;
      field.dataset['focusKey'] = `in:${c.id}`;
      field.maxLength = 4000;
      if (c.placeholder) field.placeholder = c.placeholder;
      if (c.required) { field.required = true; field.setAttribute('aria-required', 'true'); }
      field.autocomplete = 'off';
      const submit = () => {
        const value = field.value;
        if (field.dataset['lastSent'] === value) return;
        field.dataset['lastSent'] = value;
        void runAction(card, opts.actions.interact(n.id, { componentId: c.id, value, values: collectValues(card, n) }));
      };
      // In a dialogue, fields are local form state: values go with a button.
      const live = sendsOnFieldChange(opts.mode);
      field.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key !== 'Enter' || ke.isComposing) return;
        if (!live) {
          // Enter in a single-line field presses the primary resolve button.
          if (c.multiline && !(ke.ctrlKey || ke.metaKey)) return;
          e.preventDefault();
          card.querySelector<HTMLButtonElement>('.aura-ntf-btn[data-variant="primary"]:not(:disabled)')?.click();
          return;
        }
        if (c.multiline && !(ke.ctrlKey || ke.metaKey)) return;
        e.preventDefault();
        submit();
      });
      if (live) field.addEventListener('change', submit);
      // Under the field: an error message and a counter near the limit.
      const foot = el('div', 'aura-ctl-field-foot');
      const err = el('p', 'aura-ctl-error');
      err.id = `${fid}-err`;
      err.hidden = true;
      const count = el('span', 'aura-ctl-count');
      count.setAttribute('aria-live', 'polite');
      count.hidden = true;
      foot.append(err, count);
      field.setAttribute('aria-describedby', err.id);
      const COUNT_FROM = Math.floor(field.maxLength * 0.8);
      const grow = () => {
        if (!(field instanceof HTMLTextAreaElement) || !field.isConnected) return;
        field.style.height = 'auto';
        field.style.height = `${Math.min(field.scrollHeight + 2, 220)}px`;
      };
      field.addEventListener('input', () => {
        field.removeAttribute('aria-invalid');
        err.hidden = true;
        err.textContent = '';
        const len = field.value.length;
        count.hidden = len < COUNT_FROM;
        if (!count.hidden) count.textContent = `${len} / ${field.maxLength}`;
        grow();
        saveDraft(card, n, c.id);
      });
      if (field instanceof HTMLTextAreaElement) requestAnimationFrame(grow);
      wrap.append(label, field, foot);
      return wrap;
    }
    case 'options': {
      // display (phase 6): 'segmented' — single choice as a row of chips
      // (native radios, visually hidden; description = tooltip); 'radio' — a
      // vertical list of round radios; 'checkbox' (multiple) — checkbox rows.
      // Lists show each option's description under its label. All of them
      // keep native semantics (arrow keys move within a radio group).
      const display = optionsDisplay(c);
      const fs = el('fieldset', 'aura-ntf-options aura-ctl-group');
      fs.dataset['multiple'] = String(!!c.multiple);
      fs.dataset['style'] = display === 'checkbox' ? 'list' : display;
      fs.dataset['display'] = display;
      fs.appendChild(el('legend', `aura-ntf-label aura-ctl-label${c.label ? '' : ' aura-sr-only'}`, c.label ?? (c.multiple ? 'Choose any' : 'Choose one')));
      const row = el('div', 'aura-ctl-choices');
      fs.appendChild(row);
      const name = `${base}-opt-${c.id}`;
      for (const o of c.options) {
        const lab = el('label', `aura-ntf-option ${display === 'segmented' ? 'aura-ctl-seg' : 'aura-ctl-choice'}`);
        const inp = el('input', c.multiple ? 'aura-ctl-check' : 'aura-ctl-radio');
        inp.type = c.multiple ? 'checkbox' : 'radio';
        inp.name = name;
        inp.value = o.id;
        inp.dataset['ntfOptions'] = c.id;
        inp.dataset['focusKey'] = `opt:${c.id}:${o.id}`;
        inp.addEventListener('change', () => {
          saveDraft(card, n, c.id);
          if (!sendsOnFieldChange(opts.mode)) return;   // dialogue: local form state
          const v = collectValues(card, n);
          const value = v[c.id] ?? (c.multiple ? [] : undefined);
          if (value === undefined) return;
          void runAction(card, opts.actions.interact(n.id, { componentId: c.id, value, values: v }));
        });
        const desc = (o as { description?: string }).description;
        if (display === 'segmented') {
          lab.append(inp, el('span', 'aura-ctl-choice-text', o.label));
          if (desc) lab.title = desc;
        } else {
          const body = el('span', 'aura-ctl-choice-body');
          body.appendChild(el('span', 'aura-ctl-choice-text', o.label));
          if (desc) {
            const d = el('span', 'aura-ctl-choice-desc', desc);
            d.id = `${name}-${o.id}-desc`;
            inp.setAttribute('aria-describedby', d.id);
            body.appendChild(d);
          }
          lab.append(inp, body);
        }
        row.appendChild(lab);
      }
      return fs;
    }
    case 'select':
    case 'combobox': {
      const onChange = (value: string | undefined) => {
        saveDraft(card, n, c.id);
        if (!sendsOnFieldChange(opts.mode) || value === undefined) return;   // dialogue: local form state
        void runAction(card, opts.actions.interact(n.id, { componentId: c.id, value, values: collectValues(card, n) }));
      };
      return c.kind === 'select'
        ? renderSelectField(c, { base, onChange })
        : renderComboboxField(c, { base, onChange });
    }
    case 'progress': {
      const wrap = el('div', 'aura-ntf-progress');
      const bar = el('div', 'aura-ntf-progress-track');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', c.label ?? 'Progress');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const fill = el('div', 'aura-ntf-progress-fill');
      if (typeof c.value === 'number') {
        const pct = Math.round(Math.max(0, Math.min(1, c.value)) * 100);
        bar.setAttribute('aria-valuenow', String(pct));
        bar.setAttribute('aria-valuetext', `${pct}%`);
        fill.style.width = `${pct}%`;
      } else {
        wrap.dataset['indeterminate'] = 'true';
        bar.setAttribute('aria-valuetext', 'In progress');
      }
      bar.appendChild(fill);
      const row = el('div', 'aura-ntf-progress-row');
      if (c.label) row.appendChild(el('span', 'aura-ntf-progress-label', c.label));
      if (typeof c.value === 'number') row.appendChild(el('span', 'aura-ntf-progress-pct', `${Math.round(c.value * 100)}%`));
      wrap.append(row, bar);
      return wrap;
    }
    default:
      return null;
  }
}

function renderButton(card: HTMLElement, n: Notification, c: PlannedButton, opts: CardOptions): HTMLButtonElement {
  const b = el('button', 'aura-ntf-btn aura-ctl-btn');
  b.appendChild(el('span', 'aura-ctl-btn-label', c.label));
  b.type = 'button';
  b.dataset['variant'] = c.variant;
  b.dataset['behaviour'] = c.behaviour;
  if (c.source?.role ?? (c.behaviour === 'submit' || c.behaviour === 'cancel' || c.behaviour === 'later' ? c.behaviour : undefined)) {
    b.dataset['role'] = c.behaviour;
  }
  b.dataset['focusKey'] = `btn:${c.id}`;
  if (c.behaviour === 'link') {
    const href = safeHttpUrl(c.href);
    if (!href) {
      b.disabled = true;
      b.title = 'This link is not an http(s) address';
    } else {
      b.title = href;
      b.appendChild(spriteIcon('lucide-external-link'));
      b.addEventListener('click', () => openExternal(href));
    }
    return b;
  }
  if (c.behaviour === 'dismiss' && n.type === 'locked') {
    // A Locked notification cannot be dismissed — only its sender removes it.
    b.disabled = true;
    b.title = 'Locked: only the sender can remove this';
    return b;
  }
  if (c.behaviour === 'later') b.title = 'Answer later — it stays in the notification list';
  b.addEventListener('click', () => {
    if (c.behaviour === 'later') { laterFor(card, n, opts); return; }
    if (c.behaviour === 'dismiss') {
      void runAction(card, opts.actions.dismiss(n.id), b);
      return;
    }
    if (c.behaviour === 'cancel') {
      // No validation, no values: the sender learns it was cancelled.
      void runAction(card, opts.actions.resolve(n.id, answerFor(c, {})!), b)
        .then((ok) => { if (ok) getDrafts().clear(n.id); });
      return;
    }
    const values = collectValues(card, n);
    // Submitting buttons (submit / resolve / no action) check required fields first.
    if (behaviourValidates(c.behaviour)) {
      const missing = missingRequired(n.components, values);
      if (missing.length) {
        for (const m of missing) {
          const f = card.querySelector<HTMLElement>(`[data-ntf-input="${CSS.escape(m.id)}"], [data-ntf-field="${CSS.escape(m.id)}"]`);
          f?.setAttribute('aria-invalid', 'true');
          const msg = f?.closest('.aura-ctl-field')?.querySelector<HTMLElement>('.aura-ctl-error');
          if (msg) { msg.textContent = 'Required'; msg.hidden = false; }
        }
        setStatus(card, `Please fill in: ${missing.map((m) => m.label || m.id).join(', ')}`);
        card.querySelector<HTMLElement>(`[data-ntf-input="${CSS.escape(missing[0]!.id)}"], [data-ntf-field="${CSS.escape(missing[0]!.id)}"]`)?.focus();
        return;
      }
    }
    if (c.behaviour === 'submit' || c.behaviour === 'resolve') {
      void runAction(card, opts.actions.resolve(n.id, answerFor(c, values)!), b)
        .then((ok) => { if (ok) getDrafts().clear(n.id); });
      return;
    }
    void runAction(card, opts.actions.interact(n.id, { componentId: c.id, values }), b).then((ok) => {
      if (ok && b.isConnected) setStatus(card, `Sent "${c.label}"`, 'info');
    });
  });
  return b;
}

/** "Later": hide locally — the dialogue frame, the pop-up, or the inline form. */
function laterFor(card: HTMLElement, n: Notification, opts: CardOptions): void {
  if (opts.onLater) { opts.onLater(n); return; }
  if (opts.mode === 'toast') { opts.onClose?.(n); return; }
  const body = card.querySelector<HTMLElement>(':scope > .aura-ntf-body');
  if (body) {
    body.hidden = true;
    card.dataset['collapsed'] = 'true';
    card.dataset['expanded'] = 'false';
    card.focus({ preventScroll: true });
  }
}

/**
 * The secondary ⋯ menu of a Locked card: one item, "Force remove…", which
 * turns into an inline confirm. Escape / Cancel / an outside click close it
 * and focus returns to ⋯. The menu carries `data-own-escape`, so an
 * enclosing panel does not close on that Escape.
 */
function renderOverflowMenu(card: HTMLElement, n: Notification, opts: CardOptions): HTMLElement {
  const wrap = el('div', 'aura-ntf-more');
  const btn = el('button', 'aura-ntf-icon-btn');
  btn.type = 'button';
  btn.dataset['focusKey'] = 'act:more';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', `More actions for ${n.title}`);
  btn.title = 'More';
  btn.appendChild(spriteIcon('lucide-ellipsis'));
  const menu = el('div', 'aura-ntf-menu');
  menu.dataset['ownEscape'] = 'true';
  menu.hidden = true;
  wrap.append(btn, menu);

  let confirm: ConfirmInline | null = null;
  let outside: ((e: Event) => void) | null = null;

  const close = (refocus = true) => {
    if (menu.hidden) return;
    confirm?.dispose();
    confirm = null;
    menu.replaceChildren();
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    card.removeAttribute('data-menu-open');
    if (outside) { document.removeEventListener('pointerdown', outside, true); outside = null; }
    if (refocus && btn.isConnected) btn.focus({ preventScroll: true });
  };
  const showConfirm = () => {
    menu.replaceChildren();
    menu.removeAttribute('role');
    confirm = createConfirmInline({
      message: 'Remove anyway? The sender will be told.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        const r = await opts.actions.forceRemove(n.id);
        if (!r.ok) { confirm?.setError(r.error); return false; }
        close(false);
        return true;
      },
      onCancel: () => close(),
    });
    menu.appendChild(confirm.el);
    confirm.focus();
  };
  const openMenu = () => {
    menu.replaceChildren();
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Notification actions');
    const item = el('button', 'aura-ntf-menu-item', 'Force remove…');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.dataset['focusKey'] = 'act:force-remove';
    item.addEventListener('click', (e) => { e.stopPropagation(); showConfirm(); });
    menu.appendChild(item);
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    card.dataset['menuOpen'] = 'true';
    item.focus({ preventScroll: true });
    outside = (e: Event) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (!path.includes(wrap)) close(false);
    };
    document.addEventListener('pointerdown', outside, true);
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else close();
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  // (A detached card's outside listener removes itself on the next pointerdown.)
  return wrap;
}

/** Build a card element for `n`. */
export function renderNotificationCard(n: Notification, opts: CardOptions): HTMLElement {
  const base = `ntf${++uid}`;
  const now = opts.now ?? Date.now();
  const card = el('article', 'aura-ntf');
  card.dataset['id'] = n.id;
  card.dataset['mode'] = opts.mode;
  card.dataset['type'] = n.type;
  card.dataset['priority'] = n.priority;
  card.dataset['unseen'] = String(n.seenAt === undefined);
  card.dataset['pinned'] = String(!!n.pinned);
  card.tabIndex = -1;
  card.dataset['focusKey'] = 'card';
  card.setAttribute('aria-labelledby', `${base}-title`);
  card.setAttribute('aria-describedby', `${base}-meta`);

  const sender = senderLabel(n, opts.appLookup);
  const isDialogue = n.type === 'dialogue';
  const collapsed = opts.mode === 'list' && isDialogue && !opts.expanded;
  const dialogMode = opts.mode === 'dialog';
  card.dataset['collapsed'] = String(collapsed);

  // ── head: icon · sender / time · tags · close ──
  const head = el('div', 'aura-ntf-head');
  head.appendChild(renderIcon(n, opts.appLookup));
  const meta = el('div', 'aura-ntf-meta');
  meta.id = `${base}-meta`;
  const who = el('span', 'aura-ntf-sender', sender.label);
  who.title = sender.title;
  meta.appendChild(who);
  if (sender.detail) meta.appendChild(el('span', 'aura-ntf-sender-detail', sender.detail));
  if (sender.unverified) {
    const u = el('span', 'aura-ntf-tag', 'unverified');
    u.dataset['tag'] = 'unverified';
    u.title = 'The sender identity is not verified';
    meta.appendChild(u);
  }
  const time = el('time', 'aura-ntf-time', relativeTime(n.createdAt, now));
  time.dateTime = isoTime(n.createdAt);
  time.title = new Date(n.createdAt).toLocaleString();
  meta.appendChild(time);
  head.appendChild(meta);

  const tags = el('div', 'aura-ntf-tags');
  if (n.pinned) { const t = el('span', 'aura-ntf-tag', 'pinned'); t.dataset['tag'] = 'pinned'; tags.appendChild(t); }
  if (n.priority === 'high' || n.priority === 'urgent') {
    const t = el('span', 'aura-ntf-tag', PRIORITY_LABEL[n.priority] ?? n.priority);
    t.dataset['tag'] = n.priority;
    tags.appendChild(t);
  }
  if (n.type === 'locked') {
    const t = el('span', 'aura-ntf-tag');
    t.dataset['tag'] = 'locked';
    t.title = 'Locked: only the sender can remove it';
    t.append(spriteIcon('lucide-lock'), document.createTextNode('locked'));
    tags.appendChild(t);
  }
  if (isDialogue) { const t = el('span', 'aura-ntf-tag', 'question'); t.dataset['tag'] = 'question'; tags.appendChild(t); }
  if (n.seenAt === undefined) {
    const dot = el('span', 'aura-ntf-unseen-dot');
    dot.title = 'New';
    tags.appendChild(dot);
    const sr = el('span', 'aura-sr-only', 'New');
    tags.appendChild(sr);
  }
  head.appendChild(tags);

  if (dialogMode) {
    // The dialogue frame has its own Later / collapse controls.
  } else if (opts.mode === 'toast') {
    // Every pop-up (Locked too) has a ✕ that ONLY hides it: no seen, no
    // dismiss — the item stays unread in the list. It stops propagation, so
    // the pop-up's "click marks seen" rule never sees it.
    const close = el('button', 'aura-ntf-icon-btn aura-dlg-close');
    close.type = 'button';
    close.dataset['focusKey'] = 'act:close';
    close.dataset['action'] = 'hide';
    close.setAttribute('aria-label', 'Hide (keep unread)');
    close.title = 'Hide — keep unread';
    close.appendChild(spriteIcon('lucide-x'));
    close.addEventListener('click', (e) => { e.stopPropagation(); opts.onClose?.(n); });
    head.appendChild(close);
  } else if (n.type !== 'locked') {
    const dismiss = el('button', 'aura-ntf-icon-btn');
    dismiss.type = 'button';
    dismiss.dataset['focusKey'] = 'act:dismiss';
    dismiss.dataset['ntfAction'] = 'dismiss';
    dismiss.setAttribute('aria-label', `Dismiss ${n.title}`);
    dismiss.title = 'Dismiss';
    dismiss.appendChild(spriteIcon('lucide-x'));
    dismiss.addEventListener('click', () => { void runAction(card, opts.actions.dismiss(n.id), dismiss); });
    head.appendChild(dismiss);
  }
  if (opts.mode === 'list' && n.type === 'locked') head.appendChild(renderOverflowMenu(card, n, opts));
  card.appendChild(head);
  if (opts.mode === 'list') {
    // Delete on the focused card dismisses it — never a Locked one.
    card.addEventListener('keydown', (e) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.target !== card) return;
      e.preventDefault();
      if (n.type === 'locked') { setStatus(card, 'Locked: use ⋯ → Force remove…', 'info'); return; }
      void runAction(card, opts.actions.dismiss(n.id));
    });
  }

  // ── body ──
  const title = el('h3', 'aura-ntf-title', n.title);
  title.id = `${base}-title`;
  card.appendChild(title);
  if (n.text) card.appendChild(renderText(n));
  const img = opts.mode === 'list' ? safeImageSrc(n.image) : null;
  if (img) {
    const im = el('img', 'aura-ntf-image');
    im.alt = '';
    im.loading = 'lazy';
    im.decoding = 'async';
    im.referrerPolicy = 'no-referrer';
    im.src = img;
    im.addEventListener('error', () => im.remove(), { once: true });
    card.appendChild(im);
  }

  const comps = n.components ?? [];
  const body = el('div', 'aura-ntf-body');
  body.hidden = collapsed;
  // Progress is status, not a question: always visible.
  for (const c of comps) {
    if (c.kind === 'progress') {
      const node = renderComponent(card, n, c, opts, base);
      if (node) card.appendChild(node);
    }
  }
  for (const c of comps) {
    if (c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox') {
      const node = renderComponent(card, n, c, opts, base);
      if (node) body.appendChild(node);
    }
  }
  // Phase 4: standard buttons (submit / cancel / later) + the sender's own.
  const buttons = planButtons(n, { canPutOff: opts.mode === 'dialog' ? !!opts.onLater : true });
  if (buttons.length) {
    const row = el('div', 'aura-ntf-buttons aura-ctl-actions');
    for (const b of buttons) row.appendChild(renderButton(card, n, b, opts));
    body.appendChild(row);
  }
  if (body.childNodes.length) card.appendChild(body);

  // ── footer: context · Answer · Go to task ──
  const foot = el('div', 'aura-ntf-foot');
  const target = contextTarget(n.context);
  if (target) {
    const ctx = el('span', 'aura-ntf-context', target.label);
    ctx.title = `About: ${target.label}`;
    foot.appendChild(ctx);
  }
  const hasQuestion = isDialogue || comps.some((c) => c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox');
  if (opts.mode === 'toast' && hasQuestion && (comps.length || isDialogue)) {
    const ans = el('button', 'aura-ntf-link-btn', 'Answer');
    ans.type = 'button';
    ans.dataset['focusKey'] = 'act:answer';
    ans.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isDialogue && opts.onAnswer?.(n)) return;
      opts.onOpen?.(n);
    });
    foot.appendChild(ans);
  } else if (opts.mode === 'list' && isDialogue && opts.onAnswer) {
    // Phase 4: Answer opens the dialogue itself (over its window / floating).
    const ans = el('button', 'aura-ntf-link-btn', 'Answer');
    ans.type = 'button';
    ans.dataset['focusKey'] = 'act:answer';
    ans.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opts.onAnswer?.(n)) return;
      // No dialogue layer: fall back to the inline form.
      body.hidden = false;
      card.dataset['collapsed'] = 'false';
      card.dataset['expanded'] = 'true';
      body.querySelector<HTMLElement>('input, textarea, button')?.focus();
    });
    foot.appendChild(ans);
  } else if (opts.mode === 'list' && isDialogue && body.childNodes.length) {
    // Pending question: the answer form sits behind "Answer" until opened.
    const ans = el('button', 'aura-ntf-link-btn', collapsed ? 'Answer' : 'Hide answer');
    ans.type = 'button';
    ans.dataset['focusKey'] = 'act:answer';
    ans.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) card.dataset['expanded'] = 'true';
    ans.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      card.dataset['collapsed'] = String(!open);
      card.dataset['expanded'] = String(open);
      ans.setAttribute('aria-expanded', String(open));
      ans.textContent = open ? 'Hide answer' : 'Answer';
      if (open) body.querySelector<HTMLElement>('input, textarea, button')?.focus();
    });
    foot.appendChild(ans);
  }
  if (target?.actionable && !dialogMode) {
    const go = el('button', 'aura-ntf-link-btn', 'Go to task');
    go.type = 'button';
    go.dataset['focusKey'] = 'act:goto';
    go.title = `Go to ${target.label}`;
    go.addEventListener('click', async (e) => {
      e.stopPropagation();
      const host = opts.host ?? (window as unknown as WindowHost);
      const r = await goToContext(n.context, host);
      if (r === 'none') setStatus(card, 'That window is not open any more');
      else opts.onNavigated?.(n);
    });
    foot.appendChild(go);
  }
  if (foot.childNodes.length) card.appendChild(foot);

  const status = el('p', 'aura-ntf-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  card.appendChild(status);

  shown.set(card, n);
  // Phase 4: restore the user's draft (never while the screen is locked).
  if (!isLocked()) {
    const draft = draftValuesFor(n, getDrafts().get(n.id));
    if (Object.keys(draft).length) applyValues(card, n, draft);
  }

  // Phase 4: the whole Dialogue card opens its dialogue (same path as Answer).
  if ((opts.mode === 'list' || opts.mode === 'toast') && opts.onAnswer && opensDialogOnActivate(n)) {
    card.dataset['activatable'] = 'true';
    card.setAttribute('aria-haspopup', 'dialog');
    card.title = 'Open to answer';
    const activate = () => {
      if (opts.onAnswer?.(n)) return;
      if (opts.mode === 'toast') opts.onOpen?.(n);
    };
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement | null)?.closest(CARD_CONTROL_SELECTOR)) return;
      e.stopPropagation();
      activate();
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      activate();
    });
  }

  return card;
}

/** Patch title, text, progress, time and the seen state of a rendered card. */
function patchCard(card: HTMLElement, n: Notification, opts: CardOptions): void {
  const prev = shown.get(card);
  const title = card.querySelector<HTMLElement>(':scope > .aura-ntf-title');
  if (title && title.textContent !== n.title) title.textContent = n.title;
  if (!prev || prev.text !== n.text) {
    const old = card.querySelector<HTMLElement>(':scope > .aura-ntf-text');
    const fresh = n.text ? renderText(n) : null;
    if (old && fresh) old.replaceWith(fresh);
    else if (old) old.remove();
    else if (fresh && title) title.after(fresh);
  }
  const bars = [...card.querySelectorAll<HTMLElement>(':scope > .aura-ntf-progress')];
  const progs = (n.components ?? []).filter((c): c is Extract<Component, { kind: 'progress' }> => c.kind === 'progress');
  progs.forEach((c, i) => {
    const wrap = bars[i];
    if (!wrap) return;
    const fresh = renderComponent(card, n, c, opts, 'p');
    if (!fresh || wrap.outerHTML === fresh.outerHTML) return;
    // Same determinate shape: move the existing fill (smooth width transition).
    const oldFill = wrap.querySelector<HTMLElement>('.aura-ntf-progress-fill');
    const newFill = fresh.querySelector<HTMLElement>('.aura-ntf-progress-fill');
    const sameShape = wrap.dataset['indeterminate'] === fresh.dataset['indeterminate']
      && wrap.querySelector('.aura-ntf-progress-label')?.textContent === fresh.querySelector('.aura-ntf-progress-label')?.textContent;
    if (sameShape && oldFill && newFill && typeof c.value === 'number') {
      oldFill.style.width = newFill.style.width;
      const tr = wrap.querySelector<HTMLElement>('[role="progressbar"]');
      const ntr = fresh.querySelector<HTMLElement>('[role="progressbar"]');
      for (const a of ['aria-valuenow', 'aria-valuetext']) { const v = ntr?.getAttribute(a); if (v !== null && v !== undefined) tr?.setAttribute(a, v); }
      const pct = wrap.querySelector('.aura-ntf-progress-pct');
      const npct = fresh.querySelector('.aura-ntf-progress-pct');
      if (pct && npct) pct.textContent = npct.textContent;
      return;
    }
    wrap.replaceWith(fresh);   // progress holds no user state
  });
  const time = card.querySelector<HTMLTimeElement>('.aura-ntf-time');
  if (time) time.textContent = relativeTime(n.createdAt, opts.now ?? Date.now());
  if (n.seenAt !== undefined) {
    card.querySelectorAll('.aura-ntf-unseen-dot').forEach((e) => e.remove());
    card.querySelectorAll('.aura-ntf-tags > .aura-sr-only').forEach((e) => e.remove());
    // The list keeps its own highlight until it closes (it sets data-unseen itself).
    if (opts.mode !== 'list') card.dataset['unseen'] = 'false';
  }
}

/**
 * Re-render `old` for the new state of `n`, keeping typed values, checked
 * options, the expanded state and — only if focus was inside — the focus.
 * Returns the new element (already swapped into the DOM).
 */
export function updateNotificationCard(old: HTMLElement, n: Notification, opts: CardOptions): HTMLElement {
  // The ⋯ menu / force-remove confirm is open: don't pull it away from the
  // user for a background update (seen, displayed, text). The next update
  // after it closes re-renders.
  if (old.dataset['menuOpen'] === 'true' && old.isConnected) return old;
  // Patch in place whenever the structure is unchanged: inputs, options and
  // buttons are never replaced, so values, selection, focus, caret and scroll stay.
  const plan = planCardUpdate(shown.get(old), n);
  if (plan === 'none') { shown.set(old, n); return old; }
  if (plan === 'patch') { patchCard(old, n, opts); shown.set(old, n); return old; }
  const prevN = { components: n.components } as Notification;
  const values = collectValues(old, prevN);
  const expanded = old.dataset['expanded'] === 'true';
  const active = document.activeElement as HTMLElement | null;
  const hadFocus = !!active && old.contains(active);
  const focusKey = hadFocus ? active!.closest<HTMLElement>('[data-focus-key]')?.dataset['focusKey'] : undefined;
  const sel = hadFocus && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
    ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const lastSent = new Map<string, string>();
  old.querySelectorAll<HTMLElement>('[data-ntf-input]').forEach((f) => {
    if (f.dataset['lastSent'] !== undefined) lastSent.set(f.dataset['ntfInput']!, f.dataset['lastSent']);
  });
  const status = old.querySelector<HTMLElement>('.aura-ntf-status');

  const next = renderNotificationCard(n, { ...opts, expanded: expanded || opts.expanded });
  for (const c of n.components ?? []) {
    if (c.kind !== 'input' && c.kind !== 'options' && c.kind !== 'select' && c.kind !== 'combobox') continue;
    const v = values[c.id];
    if (v === undefined) continue;
    if (c.kind === 'select' || c.kind === 'combobox') {
      const w = next.querySelector<HTMLElement>(`[data-ntf-choice="${CSS.escape(c.id)}"]`);
      if (w && typeof v === 'string') setChoiceValue(w, v);
      continue;
    }
    if (c.kind === 'input') {
      const f = next.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-ntf-input="${CSS.escape(c.id)}"]`);
      if (f && typeof v === 'string') {
        f.value = v;
        const ls = lastSent.get(c.id);
        if (ls !== undefined) f.dataset['lastSent'] = ls;
      }
    } else if (c.kind === 'options') {
      const want = new Set(Array.isArray(v) ? v : [v]);
      next.querySelectorAll<HTMLInputElement>(`input[data-ntf-options="${CSS.escape(c.id)}"]`).forEach((i) => { i.checked = want.has(i.value); });
    }
  }
  if (expanded) {
    const body = next.querySelector<HTMLElement>('.aura-ntf-body');
    if (body) body.hidden = false;
    next.dataset['collapsed'] = 'false';
    next.dataset['expanded'] = 'true';
    const ans = next.querySelector<HTMLElement>('[data-focus-key="act:answer"]');
    if (ans) { ans.setAttribute('aria-expanded', 'true'); ans.textContent = 'Hide answer'; }
  }
  if (status && !status.hidden) {
    const ns = next.querySelector<HTMLElement>('.aura-ntf-status');
    if (ns) { ns.textContent = status.textContent; ns.dataset['kind'] = status.dataset['kind'] ?? 'error'; ns.hidden = false; }
  }
  old.replaceWith(next);
  if (hadFocus) {
    const target = (focusKey && next.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)) || next;
    target.focus({ preventScroll: true });
    if (sel && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      try { target.setSelectionRange(sel.start, sel.end); } catch { /* ignore */ }
    }
  }
  return next;
}
