/**
 * A runtime's settings schema (ARI §2.1 `settingsSchema`): a small JSON
 * Schema subset that Settings → Runtimes renders as a form (ARI §9.8) and
 * the kernel validates writes against. Supported field types: `boolean`,
 * `integer`, `string` (optionally an `enum`) and `string[]`.
 *
 * The field model itself is the one of config/schema.ts (D108 decision 6,
 * D36: one field model for runtime settings and app setup fields); this file
 * keeps the runtime API and its error.
 */
import { fieldDefaults, fieldValue, type SettingsSchema } from '../config/schema.js';
import type { RuntimeSettings } from './types.js';

export type { SettingsField, SettingsSchema } from '../config/schema.js';

export class RuntimeSettingsError extends Error {
  override readonly name = 'RuntimeSettingsError';
  readonly code = 'invalid-settings' as const;
}

/** Every field at its default. */
export function settingsDefaults(schema: SettingsSchema): RuntimeSettings {
  return fieldDefaults(schema.properties);
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
