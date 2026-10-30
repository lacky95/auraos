/**
 * Virtual-keyboard layouts (simple-keyboard format) and the key table that
 * turns a simple-keyboard button into a KeyboardEvent description.
 *
 * Button tokens:
 *   a, Q, 1, ü, …          printable character
 *   {bksp} {enter} {tab}   named keys (KEYS below)
 *   {ctrl} {alt} {meta}    sticky modifiers (one tap = next key, double tap = lock)
 *   {shift} {lock}         shift layer (one-shot / caps); a sticky modifier in
 *                          layouts without a shift layer (navigation, shortcuts)
 *   {altgr}                AltGr layer (QWERTZ)
 *   {numbers} {abc}        layer switch in the compact layout
 *   {ctrl+c} {alt+f4} …    one-tap combo
 */
import type { KeySpec } from '../../../lib/keyboard/AuraInputManager.ts';

export type LayoutDef = Record<string, string[]>;
export interface LayoutMeta { id: string; label: string; layout: LayoutDef }

const BOTTOM_DE = '{ctrl} {meta} {alt} {space} {altgr} {arrowleft} {arrowup} {arrowdown} {arrowright}';
const BOTTOM_US = '{ctrl} {meta} {alt} {space} {arrowleft} {arrowup} {arrowdown} {arrowright}';

const QWERTZ: LayoutDef = {
  default: [
    '{escape} ^ 1 2 3 4 5 6 7 8 9 0 ß ´ {bksp}',
    '{tab} q w e r t z u i o p ü + {delete}',
    '{lock} a s d f g h j k l ö ä # {enter}',
    '{shift} < y x c v b n m , . - {shift}',
    BOTTOM_DE,
  ],
  shift: [
    '{escape} ° ! " § $ % & / ( ) = ? ` {bksp}',
    '{tab} Q W E R T Z U I O P Ü * {delete}',
    "{lock} A S D F G H J K L Ö Ä ' {enter}",
    '{shift} > Y X C V B N M ; : _ {shift}',
    BOTTOM_DE,
  ],
  altgr: [
    '{escape} ^ 1 ² ³ 4 5 6 { [ ] } \\ ´ {bksp}',
    '{tab} @ w € r t z u i o p ü ~ {delete}',
    '{lock} a s d f g h j k l ö ä # {enter}',
    '{shift} | y x c v b n µ , . - {shift}',
    BOTTOM_DE,
  ],
};

const QWERTY: LayoutDef = {
  default: [
    '{escape} ` 1 2 3 4 5 6 7 8 9 0 - = {bksp}',
    '{tab} q w e r t y u i o p [ ] \\',
    "{lock} a s d f g h j k l ; ' {enter}",
    '{shift} z x c v b n m , . / {shift}',
    BOTTOM_US,
  ],
  shift: [
    '{escape} ~ ! @ # $ % ^ & * ( ) _ + {bksp}',
    '{tab} Q W E R T Y U I O P { } |',
    '{lock} A S D F G H J K L : " {enter}',
    '{shift} Z X C V B N M < > ? {shift}',
    BOTTOM_US,
  ],
};

const COMPACT: LayoutDef = {
  default: [
    'q w e r t z u i o p {bksp}',
    'a s d f g h j k l {enter}',
    '{shift} y x c v b n m , . {shift}',
    '{numbers} {ctrl} {space} {arrowleft} {arrowright}',
  ],
  shift: [
    'Q W E R T Z U I O P {bksp}',
    'A S D F G H J K L {enter}',
    '{shift} Y X C V B N M ; : {shift}',
    '{numbers} {ctrl} {space} {arrowleft} {arrowright}',
  ],
  numbers: [
    '1 2 3 4 5 6 7 8 9 0 {bksp}',
    '@ # € % & * - + ( ) {enter}',
    '! ? / \\ : ; " \' _ =',
    '{abc} {escape} {tab} {space} {arrowleft} {arrowright}',
  ],
};

const NAVIGATION: LayoutDef = {
  default: [
    '{escape} {tab} {home} {arrowup} {end} {pageup}',
    '{ctrl} {shift} {arrowleft} {arrowdown} {arrowright} {pagedown}',
    '{alt} {meta} {bksp} {delete} {insert} {enter}',
  ],
};

const SHORTCUTS: LayoutDef = {
  default: [
    '{f1} {f2} {f3} {f4} {f5} {f6} {f7} {f8} {f9} {f10} {f11} {f12}',
    '{ctrl+a} {ctrl+c} {ctrl+x} {ctrl+v} {ctrl+z} {ctrl+y} {ctrl+s} {ctrl+f}',
    '{escape} {tab} {ctrl+shift+t} {alt+tab} {alt+f4} {ctrl} {alt} {shift} {meta}',
  ],
};

/** A shortcut row on top of the full QWERTZ keyboard. */
function withRow(row: string, base: LayoutDef = QWERTZ): LayoutDef {
  const out: LayoutDef = {};
  for (const [name, rows] of Object.entries(base)) out[name] = [row, ...rows];
  return out;
}

/** App adapters: tuned rows for terminals, editors and remote desktops. */
const TERMINAL = withRow('{ctrl+c} {ctrl+d} {ctrl+z} {ctrl+l} {ctrl+r} {ctrl+a} {ctrl+e} {ctrl+u} {ctrl+w} | ~ / $');
const EDITOR   = withRow('{ctrl+s} {ctrl+z} {ctrl+y} {ctrl+f} {ctrl+h} {ctrl+space} {ctrl+/} {f2} {home} {end}');
const REMOTE   = withRow('{ctrl+alt+delete} {meta} {alt+tab} {f1} {f2} {f3} {f4} {f5} {f10} {f11} {f12}');

export const LAYOUTS: LayoutMeta[] = [
  { id: 'full',       label: 'QWERTZ',   layout: QWERTZ },
  { id: 'qwerty',     label: 'QWERTY',   layout: QWERTY },
  { id: 'compact',    label: 'Compact',  layout: COMPACT },
  { id: 'navigation', label: 'Nav',      layout: NAVIGATION },
  { id: 'shortcuts',  label: 'Shortcuts', layout: SHORTCUTS },
  { id: 'terminal',   label: 'Terminal', layout: TERMINAL },
  { id: 'editor',     label: 'Editor',   layout: EDITOR },
  { id: 'remote',     label: 'Remote',   layout: REMOTE },
];

export function layoutById(id: string, custom?: LayoutDef | null): LayoutDef {
  if (id === 'custom' && custom?.['default']?.length) return custom;
  return (LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0]!).layout;
}

/** Named keys. */
export const KEYS: Record<string, KeySpec> = {
  '{bksp}':       { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  '{tab}':        { key: 'Tab',       code: 'Tab',       keyCode: 9 },
  '{enter}':      { key: 'Enter',     code: 'Enter',     keyCode: 13 },
  '{space}':      { key: ' ',         code: 'Space',     keyCode: 32 },
  '{escape}':     { key: 'Escape',    code: 'Escape',    keyCode: 27 },
  '{pageup}':     { key: 'PageUp',    code: 'PageUp',    keyCode: 33 },
  '{pagedown}':   { key: 'PageDown',  code: 'PageDown',  keyCode: 34 },
  '{end}':        { key: 'End',       code: 'End',       keyCode: 35 },
  '{home}':       { key: 'Home',      code: 'Home',      keyCode: 36 },
  '{arrowleft}':  { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  '{arrowup}':    { key: 'ArrowUp',   code: 'ArrowUp',   keyCode: 38 },
  '{arrowright}': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  '{arrowdown}':  { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  '{insert}':     { key: 'Insert',    code: 'Insert',    keyCode: 45 },
  '{delete}':     { key: 'Delete',    code: 'Delete',    keyCode: 46 },
};
for (let i = 1; i <= 12; i++) KEYS[`{f${i}}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

export const MODIFIER_TOKENS = { '{ctrl}': 'ctrl', '{alt}': 'alt', '{meta}': 'meta', '{shift}': 'shift' } as const;

/** Key description for a printable character. `code` is the US physical position. */
export function keyForChar(ch: string): KeySpec {
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
  if (ch === ' ') return KEYS['{space}']!;
  const PUNCT: Record<string, [string, number]> = {
    '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
    '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188],
    '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192],
  };
  const p = PUNCT[ch];
  return p ? { key: ch, code: p[0], keyCode: p[1] } : { key: ch, code: '', keyCode: 0 };
}

export interface Combo { key: KeySpec; mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } }

/** `{ctrl+shift+t}` → combo, or null when the token isn't one. */
export function parseCombo(token: string): Combo | null {
  const m = /^\{(.+\+.+)\}$/.exec(token);
  if (!m) return null;
  const parts = m[1]!.split('+');
  const last = parts.pop()!;
  const mods: Combo['mods'] = {};
  for (const p of parts) {
    if (p === 'ctrl' || p === 'alt' || p === 'shift' || p === 'meta') mods[p] = true;
    else return null;
  }
  const named = KEYS[`{${last}}`];
  if (named) return { key: named, mods };
  if (last === 'space') return { key: KEYS['{space}']!, mods };
  return last.length === 1 ? { key: keyForChar(last), mods } : null;
}

const LABELS: Record<string, string> = {
  '{bksp}': '⌫', '{tab}': 'Tab', '{enter}': 'Enter', '{space}': ' ', '{escape}': 'Esc',
  '{shift}': 'Shift', '{lock}': 'Caps', '{ctrl}': 'Ctrl', '{alt}': 'Alt', '{meta}': 'Win',
  '{altgr}': 'AltGr', '{numbers}': '123', '{abc}': 'ABC',
  '{arrowleft}': '←', '{arrowup}': '↑', '{arrowright}': '→', '{arrowdown}': '↓',
  '{home}': 'Home', '{end}': 'End', '{pageup}': 'PgUp', '{pagedown}': 'PgDn',
  '{insert}': 'Ins', '{delete}': 'Del',
};

/** Display labels for every function button in `layout` (combos get "Ctrl+C"). */
export function displayFor(layout: LayoutDef): Record<string, string> {
  const out: Record<string, string> = { ...LABELS };
  for (let i = 1; i <= 12; i++) out[`{f${i}}`] = `F${i}`;
  for (const rows of Object.values(layout)) {
    for (const tok of rows.join(' ').split(' ')) {
      if (out[tok] || !parseCombo(tok)) continue;
      out[tok] = tok.slice(1, -1).split('+')
        .map((p) => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win', delete: 'Del', space: 'Space', tab: 'Tab' }[p] ?? p.toUpperCase()))
        .join('+');
    }
  }
  return out;
}
