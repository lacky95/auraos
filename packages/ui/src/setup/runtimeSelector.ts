/**
 * The runtime selector (ARI-3 owner override, D108 operator override
 * `overrides.sandbox`): the installed runtimes with the dry-run answer for
 * this app (`RuntimeCheck`, `POST /api/admin/runtimes/check`), fetched by the
 * caller. Only a runtime that can run it is selectable; the others say why.
 * Nothing is auto-picked (Q17): `suggest` only names the runtimes that could
 * run it. `checkText` is the wording Settings → Apps → Runtime uses too.
 */
import { el, section } from './dom.js';

/** A runtime dry run for one app (the shape of `POST /api/admin/runtimes/check`). */
export interface RuntimeCheck {
  ok: boolean; missing: string[]; suggest?: string[]; enabled?: boolean; unavailable?: string;
}

/** What a dry run says, for people. */
export function checkText(c: RuntimeCheck): string {
  if (c.ok) return 'ok: it can run there';
  const why: string[] = [];
  if (c.missing.length) {
    why.push(`missing ${c.missing.join(', ')}`);
    if (c.suggest) why.push(c.suggest.length ? `it could run on: ${c.suggest.join(', ')}` : 'no installed runtime can run it');
  }
  if (c.enabled === false) why.push('the runtime is disabled');
  if (c.unavailable) why.push(`unavailable: ${c.unavailable}`);
  return `no: ${why.join('; ') || 'refused'}`;
}

/** One runtime as the selector lists it. */
export interface RuntimeChoice {
  id: string;
  title?: string;
  /** The runtime AuraOS uses when nothing names one (Runtime Settings). */
  isDefault?: boolean;
  check: RuntimeCheck;
}

export interface RuntimeSelectorProps {
  runtimes: readonly RuntimeChoice[];
  /** The override chosen (desired `overrides.sandbox`); null: the app's own or the default runtime. */
  selected: string | null;
  /** What the app runs on without an override, and why (e.g. "container · named by the app"). */
  effective?: string;
  disabled?: boolean;
}

export interface RuntimeSelectorCallbacks {
  /** A runtime the dry run accepted, or null to drop the override. */
  onSelect(runtimeId: string | null): void;
}

export function renderRuntimeSelector(root: HTMLElement, props: RuntimeSelectorProps, on: RuntimeSelectorCallbacks): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const s = section(doc, 'runtime', 'Runtime');
  if (props.effective) s.append(el(doc, 'p', 'su-note', `Without a choice: ${props.effective}`));
  const list = el(doc, 'div', 'su-options');
  list.setAttribute('role', 'radiogroup');
  const choice = (id: string | null, title: string, ok: boolean, note: string): void => {
    const opt = el(doc, 'label', ok ? 'su-option' : 'su-option su-unavailable');
    opt.dataset['runtime'] = id ?? '';
    opt.dataset['available'] = String(ok);
    const radio = el(doc, 'input');
    radio.type = 'radio';
    radio.name = 'su-runtime';
    radio.value = id ?? '';
    radio.disabled = !ok || props.disabled === true;
    radio.checked = ok && props.selected === id;
    radio.addEventListener('change', () => { if (radio.checked && ok) on.onSelect(id); });
    opt.append(radio, el(doc, 'span', 'su-option-title', title), el(doc, 'span', ok ? 'su-option-desc' : 'su-option-desc su-no', note));
    list.append(opt);
  };
  choice(null, 'No override', true, 'The app\'s own runtime, or the default runtime.');
  for (const r of props.runtimes) {
    choice(r.id, `${r.title ?? r.id}${r.isDefault ? ' (default)' : ''}`, r.check.ok, checkText(r.check));
  }
  s.append(list);
  root.append(s);
}
