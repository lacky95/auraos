/**
 * Select / combobox logic (phase 6) — DOM-free, unit tested. The DOM side is
 * components/shell/notifications/ChoiceField.ts.
 *
 *   select    one option id out of ≤ 50; `default` preselects one.
 *   combobox  the same, searchable: typing filters the options (label,
 *             case- and accent-insensitive substring; prefix matches first).
 *             With `allowCustom` the typed text itself is a valid value; a
 *             value equal to an option id always means that option.
 */
export interface Choice { id: string; label: string }

/** Lower-case, accents stripped, whitespace collapsed. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Options whose label contains `query`; prefix matches first, otherwise in order. Empty query → all. */
export function filterChoices(options: readonly Choice[], query: string): Choice[] {
  const q = fold(query);
  if (!q) return [...options];
  const starts: Choice[] = [];
  const contains: Choice[] = [];
  for (const o of options) {
    const l = fold(o.label);
    if (l.startsWith(q)) starts.push(o);
    else if (l.includes(q)) contains.push(o);
  }
  return [...starts, ...contains];
}

/** The option whose label equals `text` (folded), if any. */
export function exactChoice(options: readonly Choice[], text: string): Choice | undefined {
  const t = fold(text);
  return t ? options.find((o) => fold(o.label) === t) : undefined;
}

/**
 * Typeahead of a select-only combobox (APG): the next option after `from`
 * whose label starts with `buffer`; a buffer of one repeated letter cycles
 * through the options starting with it. -1 when nothing matches.
 */
export function typeahead(options: readonly Choice[], buffer: string, from: number): number {
  const b = fold(buffer);
  if (!b || !options.length) return -1;
  const same = [...b].every((ch) => ch === b[0]);
  const needle = same ? b[0]! : b;
  // A longer buffer refines the current match (it may stay); one repeated letter moves on.
  const start = same ? from + 1 : Math.max(0, from);
  for (let k = 0; k < options.length; k++) {
    const i = (start + k + options.length) % options.length;
    if (fold(options[i]!.label).startsWith(needle)) return i;
  }
  return -1;
}

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp';
export const PAGE_STEP = 10;

/** Active index after a navigation key (clamped, no wrap — APG listbox). -1 stays -1 for an empty list. */
export function navigate(key: NavKey, cur: number, len: number): number {
  if (len <= 0) return -1;
  const last = len - 1;
  switch (key) {
    case 'ArrowDown': return cur < 0 ? 0 : Math.min(last, cur + 1);
    case 'ArrowUp': return cur < 0 ? last : Math.max(0, cur - 1);
    case 'Home': return 0;
    case 'End': return last;
    case 'PageDown': return cur < 0 ? Math.min(last, PAGE_STEP - 1) : Math.min(last, cur + PAGE_STEP);
    case 'PageUp': return cur < 0 ? 0 : Math.max(0, cur - PAGE_STEP);
  }
}

export interface ComboState {
  /** The chosen option id, if the text is an option. */
  selected?: string;
  /** What is in the text box. */
  text: string;
}

/**
 * The value a combobox reports: the chosen option id; else, with
 * `allowCustom`, the trimmed text (≤ 200); else nothing.
 */
export function comboValue(state: ComboState, allowCustom: boolean | undefined): string | undefined {
  if (state.selected !== undefined) return state.selected;
  const t = state.text.trim();
  return allowCustom && t ? t.slice(0, 200) : undefined;
}

/**
 * The state a combobox settles in when it loses focus / Enter is pressed
 * without an active option: an exact label match picks that option; free
 * text is kept with `allowCustom`, otherwise the last chosen option comes back.
 */
export function settleCombo(options: readonly Choice[], text: string, allowCustom: boolean | undefined, last: ComboState): ComboState {
  const exact = exactChoice(options, text);
  if (exact) return { selected: exact.id, text: exact.label };
  if (allowCustom) return { text: text.trim() };
  if (!text.trim()) return { text: '' };
  return { ...last };
}

/** State for a stored value (option id → its label; free text as is). */
export function comboStateFor(options: readonly Choice[], value: string | undefined, allowCustom: boolean | undefined): ComboState {
  if (value === undefined || value === '') return { text: '' };
  const o = options.find((x) => x.id === value);
  if (o) return { selected: o.id, text: o.label };
  return allowCustom ? { text: value } : { text: '' };
}
