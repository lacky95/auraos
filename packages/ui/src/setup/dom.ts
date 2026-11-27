/**
 * DOM helpers of the setup components (internal; not exported from the
 * package). The components are plain DOM, no framework: the shell's Activity
 * window and Settings build them at runtime, like the schema form.
 */
import type { SetupErrorBody } from '@aura/core';

export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(doc: Document, cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el(doc, 'button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** A section with its heading; the component's root child. */
export function section(doc: Document, kind: string, title: string): HTMLElement {
  const s = el(doc, 'section', 'su-section');
  s.dataset['setup'] = kind;
  s.append(el(doc, 'h3', 'su-heading', title));
  return s;
}

/**
 * The D105 reasons of a refusal as a list: message, hint, what is missing,
 * what else could work (named, never picked). Never a value: bodies carry
 * none (setup/contracts.ts `SetupErrorBody`).
 */
export function reasonList(doc: Document, reasons: readonly SetupErrorBody[]): HTMLUListElement {
  const ul = el(doc, 'ul', 'su-reasons');
  for (const r of reasons) {
    const li = el(doc, 'li', 'su-reason');
    li.dataset['reason'] = r.error;
    li.append(el(doc, 'span', 'su-reason-text', r.message));
    if (r.hint) li.append(el(doc, 'span', 'su-reason-hint', r.hint));
    if (r.missing?.length) li.append(el(doc, 'span', 'su-reason-hint', `Missing: ${r.missing.join(', ')}`));
    if (r.suggest?.length) li.append(el(doc, 'span', 'su-reason-hint', `Could work instead: ${r.suggest.join(', ')}`));
    ul.append(li);
  }
  return ul;
}
