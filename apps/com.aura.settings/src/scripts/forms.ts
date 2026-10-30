/**
 * forms.ts — client-side driver for the themed `.aura-select` dropdown.
 *
 * Each select is marked up as:
 *   <div class="aura-select" data-select data-value="X">
 *     <input type="hidden" name="field" value="X" />
 *     <button class="aura-select-trigger" ...>…</button>
 *     <ul class="aura-select-list" role="listbox" hidden>
 *       <li class="aura-select-item" data-value="X" aria-selected="true">OPT</li>
 *       …
 *     </ul>
 *   </div>
 *
 * The driver flips open/closed, walks the list with the keyboard, and
 * fires a bubbling `change` event from the <div> when a value is picked
 * — so page scripts can `addEventListener('change', …)` just like with a
 * native `<select>`.
 */

type SelectRefs = {
  root:    HTMLElement;
  trigger: HTMLButtonElement;
  list:    HTMLUListElement;
  label:   HTMLElement;
  hidden:  HTMLInputElement | null;
};

function refs(root: HTMLElement): SelectRefs | null {
  const trigger = root.querySelector<HTMLButtonElement>('.aura-select-trigger');
  const list    = root.querySelector<HTMLUListElement>('.aura-select-list');
  const label   = root.querySelector<HTMLElement>('.aura-select-value');
  const hidden  = root.querySelector<HTMLInputElement>('input[type="hidden"]');
  if (!trigger || !list || !label) return null;
  return { root, trigger, list, label, hidden };
}

function items(list: HTMLUListElement): HTMLLIElement[] {
  return Array.from(list.querySelectorAll<HTMLLIElement>('.aura-select-item:not([aria-disabled="true"])'));
}

function setActive(list: HTMLUListElement, idx: number): void {
  const rows = items(list);
  rows.forEach((el, i) => { el.dataset['active'] = String(i === idx); });
  rows[idx]?.scrollIntoView({ block: 'nearest' });
}

function activeIndex(list: HTMLUListElement): number {
  return items(list).findIndex((el) => el.dataset['active'] === 'true');
}

function selectedIndex(list: HTMLUListElement): number {
  return items(list).findIndex((el) => el.getAttribute('aria-selected') === 'true');
}

function open(refs: SelectRefs): void {
  refs.list.hidden = false;
  refs.root.dataset['open'] = 'true';
  refs.trigger.setAttribute('aria-expanded', 'true');
  const start = Math.max(0, selectedIndex(refs.list));
  setActive(refs.list, start);
}

function close(refs: SelectRefs): void {
  refs.list.hidden = true;
  refs.root.dataset['open'] = 'false';
  refs.trigger.setAttribute('aria-expanded', 'false');
}

function isOpen(refs: SelectRefs): boolean { return !refs.list.hidden; }

function commit(refs: SelectRefs, value: string, label: string): void {
  refs.root.dataset['value'] = value;
  refs.label.textContent = label;
  for (const row of items(refs.list)) {
    row.setAttribute('aria-selected', row.dataset['value'] === value ? 'true' : 'false');
  }
  if (refs.hidden) refs.hidden.value = value;
  // Mirror the native `<select>` contract: a bubbling `change` event with
  // the current value readable from the root's `data-value`.
  refs.root.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));
  close(refs);
}

function wire(root: HTMLElement): void {
  if (root.dataset['selectReady'] === '1') return;
  root.dataset['selectReady'] = '1';
  const r = refs(root);
  if (!r) return;

  r.trigger.addEventListener('click', () => { isOpen(r) ? close(r) : open(r); });

  r.trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen(r)) { open(r); return; }
      const rows = items(r.list);
      if (!rows.length) return;
      const cur = activeIndex(r.list);
      const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      setActive(r.list, next);
    } else if (e.key === 'Home' && isOpen(r)) { e.preventDefault(); setActive(r.list, 0); }
    else if (e.key === 'End'  && isOpen(r))  { e.preventDefault(); setActive(r.list, items(r.list).length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isOpen(r)) { open(r); return; }
      const row = items(r.list)[activeIndex(r.list)];
      if (row) commit(r, row.dataset['value'] ?? '', row.textContent?.trim() ?? '');
    } else if (e.key === 'Escape' && isOpen(r)) {
      e.preventDefault(); e.stopPropagation(); close(r);
    }
  });

  r.list.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep focus on the trigger
    const row = (e.target as HTMLElement).closest<HTMLLIElement>('.aura-select-item[data-value]');
    if (row && row.getAttribute('aria-disabled') !== 'true') {
      commit(r, row.dataset['value'] ?? '', row.textContent?.trim() ?? '');
      r.trigger.focus();
    }
  });

  r.list.addEventListener('mousemove', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLLIElement>('.aura-select-item[data-value]');
    if (!row) return;
    const idx = items(r.list).indexOf(row);
    if (idx >= 0) setActive(r.list, idx);
  });

  // Click-outside closes without changing the value.
  document.addEventListener('mousedown', (e) => {
    if (!isOpen(r)) return;
    if (!root.contains(e.target as Node)) close(r);
  });
}

/** Auto-wire every `.aura-select` on the page. Safe to call multiple times. */
export function installSelects(scope: ParentNode = document): void {
  for (const el of scope.querySelectorAll<HTMLElement>('.aura-select[data-select]')) wire(el);
}

/** Programmatically set a themed select's value — the equivalent of
 *  `nativeSelect.value = x`. Updates data-value, the visible label, and
 *  the aria-selected flags on every option. Does NOT fire `change`, to
 *  mirror native `<select>.value =` semantics. */
export function setSelectValue(root: HTMLElement, value: string): void {
  if (!root.classList.contains('aura-select')) return;
  const r = refs(root);
  if (!r) return;
  const rows = Array.from(r.list.querySelectorAll<HTMLLIElement>('.aura-select-item'));
  const match = rows.find((el) => el.dataset['value'] === value) ?? null;
  for (const row of rows) row.setAttribute('aria-selected', row === match ? 'true' : 'false');
  root.dataset['value'] = value;
  if (r.hidden) r.hidden.value = value;
  r.label.textContent = match?.textContent?.trim() ?? value;
}

// Convenience global for `<script is:inline>` pages that cannot import this
// module directly. Kept side-by-side with the exports so TS consumers still
// use the named import.
(window as unknown as { auraForms?: { setSelectValue: typeof setSelectValue; installSelects: typeof installSelects } }).auraForms = {
  setSelectValue, installSelects,
};

installSelects();
