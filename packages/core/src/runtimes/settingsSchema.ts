/**
 * A runtime's settings schema (ARI §2.1 `settingsSchema`): a small JSON
 * Schema subset that Settings → Runtimes renders as a form (ARI §9.8) and
 * the kernel validates writes against. Supported field types: `boolean`,
 * `integer`, `string` (optionally an `enum`) and `string[]`.
 */
import type { RuntimeSettings } from './types.js';

export type SettingsField =
  | { type: 'boolean'; title: string; description?: string; default?: boolean }
  | { type: 'integer'; title: string; description?: string; default?: number; minimum?: number; maximum?: number }
  | { type: 'string'; title: string; description?: string; default?: string; enum?: string[]; enumTitles?: Record<string, string> }
  | { type: 'array'; items: { type: 'string' }; title: string; description?: string; default?: string[] };

export interface SettingsSchema {
  type: 'object';
  properties: Record<string, SettingsField>;
}

export class RuntimeSettingsError extends Error {
  override readonly name = 'RuntimeSettingsError';
  readonly code = 'invalid-settings' as const;
}

/** Every field at its default. */
export function settingsDefaults(schema: SettingsSchema): RuntimeSettings {
  const out: RuntimeSettings = {};
  for (const [k, f] of Object.entries(schema.properties)) if (f.default !== undefined) out[k] = f.default;
  return out;
}

/** One field's value from untrusted input (form strings included), or undefined when invalid. */
function fieldValue(f: SettingsField, raw: unknown): unknown {
  switch (f.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      return undefined;
    case 'integer': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
      if (!Number.isInteger(n)) return undefined;
      if ((f.minimum !== undefined && n < f.minimum) || (f.maximum !== undefined && n > f.maximum)) return undefined;
      return n;
    }
    case 'string':
      if (typeof raw !== 'string') return undefined;
      return f.enum && !f.enum.includes(raw) ? undefined : raw;
    case 'array': {
      const list = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
      return Array.isArray(list) && list.every((s) => typeof s === 'string') ? list : undefined;
    }
  }
}

/**
 * The complete settings from untrusted input: known keys only, each valid,
 * missing ones at their default. Throws `RuntimeSettingsError` naming the
 * first bad key.
 */
export function validateSettings(schema: SettingsSchema, input: unknown): RuntimeSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeSettingsError('settings must be an object');
  const out = settingsDefaults(schema);
  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    const f = schema.properties[k];
    if (!f) throw new RuntimeSettingsError(`unknown setting: ${k}`);
    const v = fieldValue(f, raw);
    if (v === undefined) {
      const allowed = f.type === 'string' && f.enum ? ` (one of: ${f.enum.join(', ')})` : '';
      throw new RuntimeSettingsError(`invalid value for ${k}${allowed}`);
    }
    out[k] = v;
  }
  return out;
}
