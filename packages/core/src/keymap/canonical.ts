/**
 * Canonical-combo serialization. Pure functions, no DOM types in the signatures
 * so this module is testable under plain Node.
 *
 * Canonical form:
 *   - Modifiers in order: Ctrl, Alt, Shift, Super  (Meta == Super)
 *   - Side-specific variants come in the same position as their generic form:
 *       LCtrl / RCtrl, LAlt / RAlt, LShift / RShift, LSuper / RSuper
 *     A side-specific modifier matches ONLY that side. The generic form
 *     (Ctrl, Alt, Shift, Super) matches either side. Don't mix the two for
 *     the same modifier in one combo.
 *   - Non-modifier key uses `KeyboardEvent.code` (physical position) so the
 *     binding is independent of the user's layout (Dvorak/Colemak/AZERTY).
 *   - `+` separator, no spaces. Example: `"Ctrl+Alt+Shift+Super+ArrowUp"`,
 *     `"RShift+Enter"`, `"RShift+Backspace"`.
 *
 * The bare-key form (`"Escape"`, `"KeyJ"`, `"AltRight"`) is also canonical —
 * a combo with zero modifiers. Lone-modifier presses (e.g. just AltRight)
 * emit the bare code so a binding can intercept them on their own.
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

/**
 * Per-side modifier state — which physical Ctrl/Alt/Shift/Super key is
 * currently held. Maintained by the dispatcher from `keydown`/`keyup` on
 * the modifier codes themselves. Passed to `comboFromEvent` so the combo
 * can use side-specific prefixes (`RShift+Enter`) instead of the generic
 * `Shift+Enter`. Without state, generic prefixes are used.
 */
export interface ModifierState {
  ctrlLeft:  boolean; ctrlRight:  boolean;
  altLeft:   boolean; altRight:   boolean;
  shiftLeft: boolean; shiftRight: boolean;
  metaLeft:  boolean; metaRight:  boolean;
}

export function emptyModifierState(): ModifierState {
  return {
    ctrlLeft: false, ctrlRight: false,
    altLeft:  false, altRight:  false,
    shiftLeft:false, shiftRight:false,
    metaLeft: false, metaRight: false,
  };
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
 * Update a `ModifierState` from a single key event. Returns the new state
 * (does NOT mutate the input). The dispatcher feeds `keydown`+`keyup` on
 * modifier codes to keep the state in sync.
 */
export function updateModifierState(state: ModifierState, code: string, down: boolean): ModifierState {
  if (!MODIFIER_CODES.has(code)) return state;
  const next = { ...state };
  if (code === 'ControlLeft')  next.ctrlLeft   = down;
  if (code === 'ControlRight') next.ctrlRight  = down;
  if (code === 'AltLeft')      next.altLeft    = down;
  if (code === 'AltRight')     next.altRight   = down;
  if (code === 'ShiftLeft')    next.shiftLeft  = down;
  if (code === 'ShiftRight')   next.shiftRight = down;
  if (code === 'MetaLeft' || code === 'OSLeft')  next.metaLeft  = down;
  if (code === 'MetaRight'|| code === 'OSRight') next.metaRight = down;
  return next;
}

/**
 * Build a canonical combo string from a KeyboardEvent-like object.
 *
 * If `state` is provided, side-specific modifier prefixes (`RShift`, `LCtrl`,
 * etc.) are emitted in preference to the generic forms — so a binding can
 * distinguish "right Shift + Enter" from "left Shift + Enter". Without
 * state, generic prefixes (`Shift`, `Ctrl`, …) are emitted.
 *
 * Lone-modifier presses (e.g. `AltRight` on its own) emit the bare code
 * with no prefix — so `AltRight` alone is a valid bind target.
 */
export function comboFromEvent(e: KeyEventLike, state?: ModifierState): string {
  if (isModifierCode(e.code)) return e.code;
  const parts: string[] = [];
  // Ctrl
  if (e.ctrlKey) {
    if (state) {
      if (state.ctrlRight && !state.ctrlLeft) parts.push('RCtrl');
      else if (state.ctrlLeft && !state.ctrlRight) parts.push('LCtrl');
      else parts.push('Ctrl');
    } else parts.push('Ctrl');
  }
  // Alt
  if (e.altKey) {
    if (state) {
      if (state.altRight && !state.altLeft) parts.push('RAlt');
      else if (state.altLeft && !state.altRight) parts.push('LAlt');
      else parts.push('Alt');
    } else parts.push('Alt');
  }
  // Shift
  if (e.shiftKey) {
    if (state) {
      if (state.shiftRight && !state.shiftLeft) parts.push('RShift');
      else if (state.shiftLeft && !state.shiftRight) parts.push('LShift');
      else parts.push('Shift');
    } else parts.push('Shift');
  }
  // Super / Meta
  if (e.metaKey) {
    if (state) {
      if (state.metaRight && !state.metaLeft) parts.push('RSuper');
      else if (state.metaLeft && !state.metaRight) parts.push('LSuper');
      else parts.push('Super');
    } else parts.push('Super');
  }
  parts.push(e.code);
  return parts.join('+');
}

/**
 * Normalize a free-form combo string into canonical form. Accepts modifier
 * synonyms and any case for the modifier names; the trailing key segment is
 * preserved verbatim (it is already expected to be a `KeyboardEvent.code`).
 *
 *   ctrl/control                 → Ctrl
 *   alt/option/opt               → Alt
 *   shift                        → Shift
 *   super/meta/cmd/command/win   → Super
 *   lctrl / rctrl / leftctrl / rightctrl …     → LCtrl / RCtrl
 *   lshift / rshift / leftshift / rightshift   → LShift / RShift
 *   (same for alt / super)
 *
 * Throws on empty input or unrecognized modifier names so configuration
 * errors surface at load time instead of as silent unmatched bindings.
 */
export function canonicalize(combo: string): string {
  const raw = combo.trim();
  if (!raw) throw new Error('canonicalize: empty combo');
  const segments = raw.split('+').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error(`canonicalize: empty combo '${combo}'`);

  let ctrl: 'none' | 'any' | 'L' | 'R' = 'none';
  let alt:  'none' | 'any' | 'L' | 'R' = 'none';
  let shift:'none' | 'any' | 'L' | 'R' = 'none';
  let sup:  'none' | 'any' | 'L' | 'R' = 'none';
  let key: string | null = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const norm = normalizeModifier(seg);
    if (norm === null) {
      if (!isLast) {
        throw new Error(`canonicalize: unknown modifier '${seg}' in '${combo}'`);
      }
      key = seg;
      continue;
    }
    if (isLast) {
      // Trailing token that happens to look like a modifier name — treat as the key.
      key = seg;
      continue;
    }
    const [mod, side] = norm;
    if (mod === 'Ctrl')  ctrl  = side;
    if (mod === 'Alt')   alt   = side;
    if (mod === 'Shift') shift = side;
    if (mod === 'Super') sup   = side;
  }
  if (!key) throw new Error(`canonicalize: no key segment in '${combo}'`);
  const out: string[] = [];
  emit(out, 'Ctrl',  ctrl);
  emit(out, 'Alt',   alt);
  emit(out, 'Shift', shift);
  emit(out, 'Super', sup);
  out.push(normalizeKey(key));
  return out.join('+');
}

function emit(out: string[], base: 'Ctrl' | 'Alt' | 'Shift' | 'Super', side: 'none' | 'any' | 'L' | 'R'): void {
  if (side === 'none') return;
  if (side === 'any') { out.push(base); return; }
  out.push(`${side}${base}`);
}

/**
 * Return every canonical form a physical combo also satisfies. Used by the
 * dispatcher to match generic bindings (`Shift+Enter`) against side-specific
 * events (`RShift+Enter`).
 *
 *   "RShift+Enter"            → ["RShift+Enter", "Shift+Enter"]
 *   "Shift+Enter"             → ["Shift+Enter"]
 *   "RShift+LCtrl+Enter"      → ["RShift+LCtrl+Enter", "Shift+LCtrl+Enter",
 *                                "RShift+Ctrl+Enter",  "Shift+Ctrl+Enter"]
 *
 * The first entry is always the input itself (most-specific). Caller can
 * walk the list and take the first hit if it wants specific-over-generic
 * precedence.
 */
export function expandCombo(combo: string): string[] {
  // Parse into modifier slots + key. Same shape as canonicalize but we
  // need the side tags so we can produce the cartesian product.
  const segments = combo.split('+').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return [combo];
  type Slot = { base: ModName; side: ModSide };
  const slots: Slot[] = [];
  let key: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const norm = normalizeModifier(seg);
    if (norm === null || isLast) { key = seg; continue; }
    slots.push({ base: norm[0], side: norm[1] });
  }
  if (!key) return [combo];
  // Cartesian product: each L/R slot has 2 variants (itself + 'any').
  // 'any' slots have 1 variant. So 2^k where k = count of L/R slots.
  let variants: Slot[][] = [[]];
  for (const slot of slots) {
    const next: Slot[][] = [];
    for (const v of variants) {
      next.push([...v, slot]);
      if (slot.side === 'L' || slot.side === 'R') {
        next.push([...v, { base: slot.base, side: 'any' }]);
      }
    }
    variants = next;
  }
  const out: string[] = [];
  for (const v of variants) {
    const acc: string[] = [];
    // Re-emit in canonical Ctrl→Alt→Shift→Super order.
    for (const base of ['Ctrl', 'Alt', 'Shift', 'Super'] as ModName[]) {
      const s = v.find((slot) => slot.base === base);
      if (s) emit(acc, s.base, s.side);
    }
    acc.push(normalizeKey(key));
    out.push(acc.join('+'));
  }
  return out;
}

/**
 * Map friendly shorthand to `KeyboardEvent.code` form:
 *   - single ASCII letter `s` / `S` → `KeyS`
 *   - single digit `1`              → `Digit1`
 *   - everything else (Escape, ArrowUp, F1, Space, KeyA, Digit3 …) → unchanged
 */
function normalizeKey(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key))    return `Digit${key}`;
  // Multi-char DOM `KeyboardEvent.code` values are PascalCase (Enter,
  // Escape, ArrowUp, Backspace). Title-case any all-lowercase input so
  // `enter` and `Enter` produce the same canonical output.
  if (/^[a-z]+$/.test(key))   return key.charAt(0).toUpperCase() + key.slice(1);
  return key;
}

type ModName = 'Ctrl' | 'Alt' | 'Shift' | 'Super';
type ModSide = 'any'  | 'L'   | 'R';

function normalizeModifier(seg: string): [ModName, ModSide] | null {
  const s = seg.toLowerCase();
  // Side-specific forms first — long names so substrings don't false-match.
  if (s === 'lctrl' || s === 'leftctrl' || s === 'leftcontrol')       return ['Ctrl',  'L'];
  if (s === 'rctrl' || s === 'rightctrl' || s === 'rightcontrol')     return ['Ctrl',  'R'];
  if (s === 'lalt'  || s === 'leftalt'   || s === 'loption')          return ['Alt',   'L'];
  if (s === 'ralt'  || s === 'rightalt'  || s === 'roption'
   || s === 'altgr' || s === 'altgraph')                              return ['Alt',   'R'];
  if (s === 'lshift'|| s === 'leftshift')                             return ['Shift', 'L'];
  if (s === 'rshift'|| s === 'rightshift')                            return ['Shift', 'R'];
  if (s === 'lsuper'|| s === 'leftsuper' || s === 'lmeta' || s === 'lcmd'
   || s === 'lwin'  || s === 'leftwin')                               return ['Super', 'L'];
  if (s === 'rsuper'|| s === 'rightsuper'|| s === 'rmeta' || s === 'rcmd'
   || s === 'rwin'  || s === 'rightwin')                              return ['Super', 'R'];
  // Generic (either side)
  if (s === 'ctrl' || s === 'control')                                return ['Ctrl',  'any'];
  if (s === 'alt'  || s === 'option'  || s === 'opt')                 return ['Alt',   'any'];
  if (s === 'shift')                                                  return ['Shift', 'any'];
  if (s === 'super'|| s === 'meta'    || s === 'cmd'
   || s === 'command'|| s === 'win'   || s === 'windows')             return ['Super', 'any'];
  return null;
}
