/**
 * The one schema-form renderer of AuraOS (D36, D108 decision W2): a form
 * rendered from the one field model (core config/schema.ts). One row per
 * field, by type — boolean (checkbox), string with `enum` (select), string
 * (text, with its `pattern`), integer (number), string[] (comma-separated
 * text) and secret (the credential picker: a vault handle, never a value) —
 * with its title, description, `required` marker and field error. No
 * hand-written fields: a runtime or an app that adds a field gets its control
 * here without a UI change.
 *
 * Two inputs, one renderer:
 *   - a runtime's settings schema (ARI §9.8; Settings → Runtimes):
 *     `renderSchemaForm(root, schema, values)`, unchanged in output since it
 *     moved here from Settings;
 *   - an app's setup fields as the setup API presents them (`FieldView[]`,
 *     core setup/contracts.ts; the setup wizard, Settings → Apps →
 *     Configuration): `renderFieldViews(root, fields)`.
 *
 * `when` conditions are evaluated on the form's current values (and the
 * selected profile): a field whose condition is false is hidden and not read.
 * That is presentation only; the kernel evaluates them again on what is sent.
 *
 * Plain DOM, no framework, no fetch: the caller renders it at runtime and
 * sends `read()` itself. Styles are the caller's (Settings' runtimes page) or
 * `@aura/ui/styles/setup.css` (rows inside `.su-form`). Hooks are `data-*`
 * attributes.
 */
import type { ConfigField, FieldCondition, FieldView, SettingsField } from '@aura/core';
import { el } from './dom.js';
import { buildSecretPicker, type SecretPickerProps } from './secretPicker.js';

/**
 * `readOnlySource: 'env'`: the value comes from the environment (e.g.
 * `AURA_USE_PROOT`, set on the container); shown read-only and never sent.
 */
export type SchemaField = (SettingsField | ConfigField) & { readOnlySource?: 'env' };

export interface SettingsSchemaLike {
  type: 'object';
  properties: Record<string, SchemaField>;
}

export interface SchemaForm {
  /** The current values of the visible, non-secret, writable fields, typed by the schema (an empty integer is left out). */
  read(): Record<string, unknown>;
  /** The picked vault handle of each visible secret field (field → handle); a field left to `generate` is absent. */
  secrets(): Record<string, string>;
  /** Did anything change from the values the form was rendered with? */
  dirty(): boolean;
}

/** How secret fields render: the existing vault handles and the shell's credential dialog (D56). */
export type SecretFieldOptions = Omit<SecretPickerProps, 'field' | 'name' | 'title' | 'bound'> & {
  /** field → the handle bound now (the desired record's `secrets`). */
  bound?: Record<string, string>;
};

export interface SchemaFormOptions {
  /** Render it read-only (a disabled runtime, no owner). */
  disabled?: boolean;
  /** The text when there are no fields. */
  emptyText?: string;
  /** field → why its value is invalid (never the value). */
  errors?: Record<string, string>;
  /** The selected operating profile, for `when: { profile }`. */
  profile?: string | null;
  /** Leave an empty text field out of `read()` (setup values: an absent optional field, not an empty string). */
  omitEmpty?: boolean;
  /** Secret fields (setup): how the credential picker offers handles. Without it a secret field shows no control. */
  secrets?: SecretFieldOptions;
  /** Called with `read()` after every change of a control. */
  onChange?: (values: Record<string, unknown>) => void;
}

/**
 * Does a `when` condition hold? The same rule as core `conditionHolds`
 * (config/schema.ts; parity tested): a missing or list value compares as
 * absent. Kept here because the UI package does not load core at runtime.
 */
export function whenHolds(when: FieldCondition | undefined, values: Readonly<Record<string, unknown>>, profile: string | null): boolean {
  if (!when) return true;
  if ('profile' in when) return profile !== null && when.profile.includes(profile);
  const v = values[when.field];
  if (v === undefined || v === null || Array.isArray(v)) return false;
  return 'equals' in when ? v === when.equals : when.in.includes(v as string | number | boolean);
}

function control(doc: Document, key: string, f: Exclude<SchemaField, { type: 'secret' }>, value: unknown): HTMLElement {
  if (f.type === 'boolean') {
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
    input.dataset['setting'] = key;
    return input;
  }
  if (f.type === 'string' && f.enum) {
    const select = doc.createElement('select');
    select.className = 'sf-select';
    select.dataset['setting'] = key;
    for (const v of f.enum) {
      const o = doc.createElement('option');
      o.value = v;
      o.textContent = f.enumTitles?.[v] ?? v;
      o.selected = v === value;
      select.append(o);
    }
    return select;
  }
  const input = doc.createElement('input');
  input.className = 'sf-input';
  input.dataset['setting'] = key;
  if (f.type === 'integer') {
    input.type = 'number';
    input.step = '1';
    if (f.minimum !== undefined) input.min = String(f.minimum);
    if (f.maximum !== undefined) input.max = String(f.maximum);
    input.value = typeof value === 'number' ? String(value) : '';
  } else {
    input.type = 'text';
    input.value = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '';
    if (f.type === 'array') input.placeholder = 'comma-separated';
    if (f.type === 'string' && 'pattern' in f && f.pattern) input.pattern = f.pattern;
  }
  return input;
}

function valueOf(el: HTMLElement, f: SchemaField, omitEmpty: boolean): unknown {
  if (f.type === 'boolean') return (el as HTMLInputElement).checked;
  const raw = (el as HTMLInputElement | HTMLSelectElement).value;
  if (f.type === 'integer') return raw.trim() === '' ? undefined : Number(raw);
  if (f.type === 'array') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (omitEmpty && raw === '') return undefined;
  return raw;
}

const isConfig = (f: SchemaField): f is ConfigField & { readOnlySource?: 'env' } =>
  f.type === 'secret' || 'required' in f || 'when' in f || 'scope' in f || 'pattern' in f;

/**
 * Render the form for `schema` into `root` (replacing its children) with
 * `values`. `opts.disabled` renders it read-only.
 */
export function renderSchemaForm(
  root: HTMLElement, schema: SettingsSchemaLike, values: Record<string, unknown>, opts: SchemaFormOptions = {},
): SchemaForm {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const fields = Object.entries(schema.properties);
  const omitEmpty = opts.omitEmpty === true;
  const profile = opts.profile ?? null;
  const pickers = new Map<string, () => string | null>();
  if (!fields.length) root.append(el(doc, 'p', 'sf-empty', opts.emptyText ?? 'There are no settings.'));

  const rows = new Map<string, HTMLElement>();
  for (const [key, f] of fields) {
    const config = isConfig(f);
    // A secret row holds several controls: a <div>, since a <label> would forward clicks to the first.
    const row = doc.createElement(f.type === 'secret' ? 'div' : 'label');
    row.className = 'sf-row';
    const title = doc.createElement('span');
    title.className = 'sf-title';
    title.textContent = f.title;
    if (config && f.required) {
      row.dataset['required'] = '';
      title.append(' ', el(doc, 'span', 'sf-required', 'required'));
    }
    if (config && f.when) row.dataset['when'] = '';
    row.append(title);
    if (f.type === 'secret') {
      // Never a value: the picker holds handle names only, whatever `values` carries.
      const { bound, ...pick } = opts.secrets ?? { handles: [] };
      const picker = buildSecretPicker(doc, {
        ...pick, name: key, field: f, title: f.title,
        ...(bound?.[key] ? { bound: bound[key] } : {}),
        disabled: opts.disabled === true || !opts.secrets,
      });
      pickers.set(key, picker.selected);
      row.append(picker.element);
    } else {
      const ctl = control(doc, key, f, values[key] ?? f.default);
      if (opts.disabled || f.readOnlySource) (ctl as HTMLInputElement).disabled = true;
      if (f.readOnlySource) ctl.dataset['readOnlySource'] = f.readOnlySource;
      ctl.addEventListener('change', () => changed());
      ctl.addEventListener('input', () => changed());
      row.append(ctl);
    }
    if (f.description) row.append(el(doc, 'span', 'sf-desc', f.description));
    if (f.readOnlySource === 'env') row.append(el(doc, 'span', 'sf-desc', 'Set in the environment of the AuraOS container: read-only here.'));
    const error = opts.errors?.[key];
    if (error) {
      row.dataset['invalid'] = '';
      const e = el(doc, 'span', 'sf-error', error);
      e.dataset['fieldError'] = key;
      row.append(e);
    }
    rows.set(key, row);
    root.append(row);
  }

  const rawValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, f] of fields) {
      if (f.type === 'secret') continue;
      const ctl = root.querySelector<HTMLElement>(`[data-setting="${key}"]`);
      if (ctl) out[key] = valueOf(ctl, f, omitEmpty);
    }
    return out;
  };
  const visible = (key: string): boolean => !rows.get(key)?.hidden;
  const applyWhen = (): void => {
    const current = rawValues();
    for (const [key, f] of fields) {
      const when = isConfig(f) ? f.when : undefined;
      if (when) rows.get(key)!.hidden = !whenHolds(when, current, profile);
    }
  };
  const read = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const raw = rawValues();
    for (const [key, f] of fields) {
      if (f.readOnlySource || f.type === 'secret' || !visible(key)) continue;
      const v = raw[key];
      if (v !== undefined) out[key] = v;
    }
    return out;
  };
  const secrets = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, pick] of pickers) {
      const h = visible(key) ? pick() : null;
      if (h) out[key] = h;
    }
    return out;
  };
  function changed(): void {
    applyWhen();
    opts.onChange?.(read());
  }
  applyWhen();
  const initial = JSON.stringify([read(), secrets()]);
  return { read, secrets, dirty: () => JSON.stringify([read(), secrets()]) !== initial };
}

/**
 * Render the setup API's fields (`SetupPlan.fields`, `SetupValuesView.fields`)
 * with their values and errors. A secret field's view carries no value
 * (`hasSecret` only); any value it did carry is ignored.
 */
export function renderFieldViews(root: HTMLElement, fields: readonly FieldView[], opts: SchemaFormOptions = {}): SchemaForm {
  const properties: Record<string, SchemaField> = {};
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = { ...(opts.errors ?? {}) };
  for (const v of fields) {
    properties[v.name] = v.field;
    if (v.field.type !== 'secret' && v.value !== undefined) values[v.name] = v.value;
    if (v.error && !(v.name in errors)) errors[v.name] = v.error;
  }
  root.classList.add('su-form');
  return renderSchemaForm(root, { type: 'object', properties }, values, {
    emptyText: 'This app has nothing to fill in.', omitEmpty: true, ...opts, errors,
  });
}
