/**
 * The secret / credential picker (D56, D108 §5.6): a secret field takes a
 * vault HANDLE, never a value. Three ways, by the field's `secret.source`:
 *
 *   generate   AuraOS's vault generates it when the setup is applied (the default choice; or pick a stored one)
 *   vault      pick a stored handle
 *   ask        the owner types it into the shell's own credential dialog
 *              (`onAsk`, D56 `credential.store`); the caller re-renders with
 *              the new handle bound
 *
 * There is no text input here and no value in props or the DOM: the picker
 * holds handle names only.
 */
import type { ConfigField } from '@aura/core';
import { button, el } from './dom.js';

/** One stored vault handle the owner may pick (a name, never the value). */
export interface VaultHandleOption {
  handle: string;
  /** Shown instead of the handle, e.g. the credential's name. */
  label?: string;
}

export interface SecretPickerProps {
  /** The field name (`setup.fields.<name>`). */
  name: string;
  title?: string;
  field: Extract<ConfigField, { type: 'secret' }>;
  /** The stored handles the owner may pick. */
  handles: readonly VaultHandleOption[];
  /** The handle bound now (the desired record), if any. */
  bound?: string;
  disabled?: boolean;
  /** Hand off to the shell's credential dialog (the value never passes through this component). */
  onAsk?: (name: string) => void;
  /** The owner picked a handle (null: generate / none). */
  onChange?: (name: string, handle: string | null) => void;
}

export interface SecretPicker {
  element: HTMLElement;
  /** The picked handle, or null (generate, or nothing picked). */
  selected(): string | null;
}

const SOURCE_TEXT: Record<'generate' | 'vault' | 'ask', string> = {
  generate: 'AuraOS generates this secret in your vault when you apply. The app gets a handle, not the value.',
  vault: 'Pick a secret stored in your vault. The app gets a handle, not the value.',
  ask: 'Enter it in AuraOS\'s own secure dialog; this form never sees it. The app gets a handle, not the value.',
};

export function buildSecretPicker(doc: Document, p: SecretPickerProps): SecretPicker {
  const box = el(doc, 'div', 'su-secret');
  box.dataset['secretField'] = p.name;
  const source = p.field.secret.source;
  const select = el(doc, 'select', 'sf-select');
  select.dataset['secret'] = p.name;
  const none = el(doc, 'option', undefined, source === 'generate' ? 'Generate a new secret' : 'Pick a stored secret…');
  none.value = '';
  select.append(none);
  const handles = [...p.handles];
  if (p.bound && !handles.some((h) => h.handle === p.bound)) handles.unshift({ handle: p.bound });
  for (const h of handles) {
    const o = el(doc, 'option', undefined, h.handle === p.bound ? `${h.label ?? h.handle} (in use)` : (h.label ?? h.handle));
    o.value = h.handle;
    o.selected = h.handle === p.bound;
    select.append(o);
  }
  if (!p.bound) none.selected = true;
  select.disabled = p.disabled === true;
  select.addEventListener('change', () => p.onChange?.(p.name, select.value || null));
  box.append(select);
  if (p.onAsk && source !== 'generate') {
    const ask = button(doc, 'btn', 'ENTER SECRET…', () => p.onAsk?.(p.name));
    ask.dataset['action'] = 'ask-secret';
    ask.dataset['field'] = p.name;
    ask.disabled = p.disabled === true;
    box.append(ask);
  }
  box.append(el(doc, 'span', 'sf-desc', SOURCE_TEXT[source]));
  return { element: box, selected: () => select.value || null };
}

/** Render one picker into `root` (replacing its children), outside a form. */
export function renderSecretPicker(root: HTMLElement, props: SecretPickerProps): SecretPicker {
  root.replaceChildren();
  const picker = buildSecretPicker(root.ownerDocument, props);
  if (props.title) {
    const row = el(root.ownerDocument, 'div', 'sf-row');
    row.append(el(root.ownerDocument, 'span', 'sf-title', props.title), picker.element);
    root.append(row);
  } else root.append(picker.element);
  return picker;
}
