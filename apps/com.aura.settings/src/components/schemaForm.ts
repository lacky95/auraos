/**
 * A settings form rendered from a runtime's settings schema (ARI §9.8;
 * core runtimes/settingsSchema.ts): one row per property, by type —
 * boolean (checkbox), string with `enum` (select), string (text), integer
 * (number) and string[] (comma-separated text) — with its title and
 * description. No hand-written fields: a runtime that adds a setting gets
 * its control here without a Settings change.
 *
 * Plain DOM, no framework: the Runtimes page builds it at runtime for the
 * runtime picked in its dropdown. Styles are the page's (`is:global`, the
 * rows are not Astro-rendered). Hooks are `data-*` attributes.
 */

/**
 * `readOnlySource: 'env'`: the value comes from the environment (e.g.
 * `AURA_USE_PROOT`, set on the container); shown read-only and never sent.
 */
type FieldBase = { title: string; description?: string; readOnlySource?: 'env' };
export type SchemaField =
  | FieldBase & { type: 'boolean'; default?: boolean }
  | FieldBase & { type: 'integer'; default?: number; minimum?: number; maximum?: number }
  | FieldBase & { type: 'string'; default?: string; enum?: string[]; enumTitles?: Record<string, string> }
  | FieldBase & { type: 'array'; items: { type: 'string' }; default?: string[] };

export interface SettingsSchemaLike {
  type: 'object';
  properties: Record<string, SchemaField>;
}

export interface SchemaForm {
  /** The current values, typed by the schema (an empty integer is left out). */
  read(): Record<string, unknown>;
  /** Did anything change from the values the form was rendered with? */
  dirty(): boolean;
}

function control(doc: Document, key: string, f: SchemaField, value: unknown): HTMLElement {
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
  }
  return input;
}

function valueOf(el: HTMLElement, f: SchemaField): unknown {
  if (f.type === 'boolean') return (el as HTMLInputElement).checked;
  const raw = (el as HTMLInputElement | HTMLSelectElement).value;
  if (f.type === 'integer') return raw.trim() === '' ? undefined : Number(raw);
  if (f.type === 'array') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

/**
 * Render the form for `schema` into `root` (replacing its children) with
 * `values`. `disabled` renders it read-only (a disabled runtime, no owner).
 */
export function renderSchemaForm(
  root: HTMLElement, schema: SettingsSchemaLike, values: Record<string, unknown>, opts: { disabled?: boolean } = {},
): SchemaForm {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const fields = Object.entries(schema.properties);
  if (!fields.length) {
    const p = doc.createElement('p');
    p.className = 'sf-empty';
    p.textContent = 'This runtime has no settings.';
    root.append(p);
  }
  for (const [key, f] of fields) {
    const row = doc.createElement('label');
    row.className = 'sf-row';
    const title = doc.createElement('span');
    title.className = 'sf-title';
    title.textContent = f.title;
    const el = control(doc, key, f, values[key] ?? f.default);
    if (opts.disabled || f.readOnlySource) (el as HTMLInputElement).disabled = true;
    if (f.readOnlySource) el.dataset['readOnlySource'] = f.readOnlySource;
    row.append(title, el);
    if (f.description) {
      const d = doc.createElement('span');
      d.className = 'sf-desc';
      d.textContent = f.description;
      row.append(d);
    }
    if (f.readOnlySource === 'env') {
      const d = doc.createElement('span');
      d.className = 'sf-desc';
      d.textContent = 'Set in the environment of the AuraOS container: read-only here.';
      row.append(d);
    }
    root.append(row);
  }
  const read = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, f] of fields) {
      if (f.readOnlySource) continue;
      const el = root.querySelector<HTMLElement>(`[data-setting="${key}"]`);
      if (!el) continue;
      const v = valueOf(el, f);
      if (v !== undefined) out[key] = v;
    }
    return out;
  };
  const initial = JSON.stringify(read());
  return { read, dirty: () => JSON.stringify(read()) !== initial };
}
