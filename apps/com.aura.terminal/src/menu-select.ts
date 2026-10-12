/**
 * select_menu_option's planning half (TM-16 / B16) — pure, no I/O.
 *
 * Picking row N of a TUI menu used to take get_screen → count rows →
 * send_keys Down×k → get_screen, and a wrong count or a blind Enter caused
 * most failed picks. The tool reads the menu once (detectMenu: a selection
 * glyph; or a reverse-video highlighted row when there is none), resolves the
 * target here, sends exactly the arrows planMove() says, and verifies. Menus
 * without a highlight (`selection: "typed"`) are answered by typing the number.
 *
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */
import { detectMenu } from './screen-summary.ts';
import type { Menu, MenuOption } from './screen-summary.ts';
import { parseStyledLine } from './screen-styles.ts';

export interface OptionError { code: 'option-not-found' | 'option-ambiguous'; message: string; candidates: string[] }

export const optionLabel = (o: MenuOption) => `${o.number ? `${o.number}. ` : ''}${o.label}`;

const normLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The option a target names: a number is the option's own number on a
 * numbered menu, else the 1-based row; a string matches the label exactly,
 * then as a prefix, then as a substring (case-insensitive). Ambiguity is an
 * error that lists the candidates, never a guess.
 */
export function findOption(menu: Menu, target: number | string): { option: MenuOption } | { error: OptionError } {
  const all = menu.options.map(optionLabel);
  const notFound = (what: string): { error: OptionError } =>
    ({ error: { code: 'option-not-found', message: `No menu option matches ${what}.`, candidates: all } });
  const t = typeof target === 'string' && /^\s*\d{1,3}\s*$/.test(target) ? Number(target) : target;
  if (typeof t === 'number') {
    const byNumber = menu.options.find((o) => o.number === t);
    if (byNumber) return { option: byNumber };
    if (menu.options.some((o) => o.number !== null)) return notFound(`number ${t}`);
    const byIndex = menu.options[t - 1];
    return byIndex ? { option: byIndex } : notFound(`row ${t} (the menu has ${menu.options.length})`);
  }
  const want = normLabel(t);
  if (!want) return notFound('an empty label');
  for (const tier of [(l: string) => l === want, (l: string) => l.startsWith(want), (l: string) => l.includes(want)]) {
    const hits = menu.options.filter((o) => tier(normLabel(o.label)));
    if (hits.length === 1) return { option: hits[0]! };
    if (hits.length > 1) {
      return { error: { code: 'option-ambiguous', message: `"${t}" matches ${hits.length} options; name one exactly or pass its number.`, candidates: hits.map(optionLabel) } };
    }
  }
  return notFound(JSON.stringify(t));
}

/** Arrows from the selected row to `targetIndex` (no wrap-around assumed: the shortest path in a list that clamps). */
export function planMove(menu: Menu, targetIndex: number): { key: 'Up' | 'Down' | null; count: number } {
  const d = targetIndex - menu.selected_index;
  return d === 0 ? { key: null, count: 0 } : { key: d > 0 ? 'Down' : 'Up', count: Math.abs(d) };
}

/**
 * The menu on a captured screen WITH escapes (`capture-pane -e`): the
 * glyph-marked menu when there is one, else a single reverse-video row
 * (≥ 2 visible characters) among siblings at the same indent, read as the
 * selected row — the two generic ways a TUI shows "this one is selected".
 */
export function menuFromStyled(styled: string[], cursorRow?: number): Menu | null {
  const rows = styled.map((l) => parseStyledLine(l));
  const plain = rows.map((cells) => cells.map((c) => c.ch).join(''));
  const direct = detectMenu(plain, { cursorRow });
  if (direct) return direct;
  const highlighted = rows
    .map((cells, i) => ({ i, n: cells.filter((c) => c.reverse && c.ch.trim()).length }))
    .filter((r) => r.n >= 2);
  if (highlighted.length !== 1) return null;
  return detectMenu(plain, { selectedRow: highlighted[0]!.i });
}

/** The menu's rows (question to last option) for a compact excerpt. */
export function menuExcerpt(screen: string[], menu: Menu | null, fallbackRows = 12): string[] {
  const rows = screen.map((l) => l.replace(/\s+$/, ''));
  if (menu) {
    const labels = menu.options.map((o) => o.label);
    const first = rows.findIndex((r) => r.includes(labels[0]!));
    let last = -1;
    for (let i = Math.max(first, 0); i < rows.length; i++) if (rows[i]!.includes(labels[labels.length - 1]!)) { last = i; break; }
    if (first >= 0 && last >= first) {
      let from = first;
      for (let r = first - 1; menu.question && r >= Math.max(0, first - 6); r--) if (rows[r]!.includes(menu.question)) { from = r; break; }
      return rows.slice(from, last + 1);
    }
  }
  return rows.filter((r) => r.trim()).slice(-fallbackRows);
}
