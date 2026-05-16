/**
 * Canonical-combo serialization. Pure functions, no DOM types in the signatures
 * so this module is testable under plain Node.
 *
 * Canonical form:
 *   - Modifiers in order: Ctrl, Alt, Shift, Super  (Meta == Super)
 *   - Non-modifier key uses `KeyboardEvent.code` (physical position) so the
 *     binding is independent of the user's layout (Dvorak/Colemak/AZERTY).
 *   - `+` separator, no spaces. Example: `"Ctrl+Alt+Shift+Super+ArrowUp"`.
 *
 * The bare-key form (`"Escape"`, `"KeyJ"`) is also canonical — it's a combo
 * with zero modifiers.
 */

export interface KeyEventLike {
  /** `KeyboardEvent.code` — physical key position. */
  code:     string;
  /** `KeyboardEvent.key` — logical layout-translated value (used only for
   *  modifier detection; not part of the canonical output). */
  key?:     string;
  ctrlKey:  boolean;
  altKey:   boolean;
  shiftKey: boolean;
  metaKey:  boolean;
}

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight',
  'AltLeft',     'AltRight',
  'ShiftLeft',   'ShiftRight',
  'MetaLeft',    'MetaRight',
  'OSLeft',      'OSRight',
]);

/**
 * Whether a `KeyboardEvent.code` names a modifier key (left/right variants of
 * Ctrl/Alt/Shift/Meta). The dispatcher uses this to skip lone-modifier
 * keydown events when there is no non-modifier yet.
 */
export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/**
 * Build a canonical combo string from a KeyboardEvent-like object. Returns
 * `null` if the event is a lone modifier press (no non-modifier key) — those
 * shouldn't trigger a combo dispatch on their own.
 */
export function comboFromEvent(e: KeyEventLike): string | null {
  if (isModifierCode(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Super');
  parts.push(e.code);
  return parts.join('+');
}

/**
 * Normalize a free-form combo string into canonical form. Accepts modifier
 * synonyms (`Meta` → `Super`, `Cmd`/`Command` → `Super`, `Win`/`Windows` →
 * `Super`, `Control` → `Ctrl`, `Option` → `Alt`) and any case for the
 * modifier names; the trailing key segment is preserved verbatim (it is
 * already expected to be a `KeyboardEvent.code`).
 *
 * Throws on empty input or unrecognized modifier names so configuration
 * errors surface at load time instead of as silent unmatched bindings.
 */
export function canonicalize(combo: string): string {
  const raw = combo.trim();
  if (!raw) throw new Error('canonicalize: empty combo');
  const segments = raw.split('+').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error(`canonicalize: empty combo '${combo}'`);

  let ctrl = false, alt = false, shift = false, sup = false;
  let key: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const norm = normalizeModifier(seg);
    if (norm === null) {
      if (!isLast) {
        // Unknown segment in a non-last position is ambiguous. Treat as a
        // key only if it really is the last; otherwise the user has typo'd
        // a modifier and silent acceptance would mask the mistake.
        throw new Error(`canonicalize: unknown modifier '${seg}' in '${combo}'`);
      }
      key = seg;
      continue;
    }
    if (isLast) {
      // Trailing token that happens to look like a modifier name (rare —
      // e.g. someone literally bound "Ctrl") — treat as the key.
      key = seg;
      continue;
    }
    if (norm === 'Ctrl')  ctrl = true;
    if (norm === 'Alt')   alt = true;
    if (norm === 'Shift') shift = true;
    if (norm === 'Super') sup = true;
  }
  if (!key) throw new Error(`canonicalize: no key segment in '${combo}'`);
  const out: string[] = [];
  if (ctrl)  out.push('Ctrl');
  if (alt)   out.push('Alt');
  if (shift) out.push('Shift');
  if (sup)   out.push('Super');
  out.push(normalizeKey(key));
  return out.join('+');
}

/**
 * Map friendly shorthand to `KeyboardEvent.code` form:
 *   - single ASCII letter `s` / `S` → `KeyS`
 *   - single digit `1`              → `Digit1`
 *   - everything else (Escape, ArrowUp, F1, Space, KeyA, Digit3 …) → unchanged
 *
 * Lets manifest authors and Settings users type natural combos like `Ctrl+s`
 * without having to remember the DOM `code` taxonomy. The output is always
 * canonical so two equivalent user inputs end up as the same string.
 */
function normalizeKey(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key))    return `Digit${key}`;
  return key;
}

function normalizeModifier(seg: string): 'Ctrl' | 'Alt' | 'Shift' | 'Super' | null {
  const s = seg.toLowerCase();
  if (s === 'ctrl' || s === 'control')                      return 'Ctrl';
  if (s === 'alt'  || s === 'option' || s === 'opt')        return 'Alt';
  if (s === 'shift')                                        return 'Shift';
  if (s === 'super'|| s === 'meta'   || s === 'cmd'
   || s === 'command' || s === 'win' || s === 'windows')    return 'Super';
  return null;
}
