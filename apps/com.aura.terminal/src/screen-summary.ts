/**
 * What is on a terminal screen, in a form an agent can act on — pure, no I/O.
 *
 *   • summarizeScreen(): program, state (shell_prompt, busy, menu,
 *     text_input, pager, editor, exited), a detected menu and input prompt,
 *     and the last non-empty rows (B10).
 *   • guardInput(): the hard safety check before keystrokes go out (B6). Prompt
 *     rules alone failed several times in voice calls — `exit` / Ctrl+D typed
 *     into a bare shell, and Down+Enter on a trust prompt landing on
 *     "No, exit". Those are refused here unless the caller passes `force`.
 *   • settleKey(): the screen minus volatile content (spinners, elapsed-time and
 *     token counters), so a busy TUI can still "settle" (B9).
 *
 * Generic on purpose (TM-18): the detectors read screen SHAPES that any TUI or
 * line-oriented program draws — a highlighted selection list (marker glyph,
 * numbered or not; reverse video via menu-select.ts), a numbered list answered
 * by typing a number, a yes/no question, an input line behind a prompt glyph,
 * an "esc to interrupt" busy hint. No detector branches on a program's name;
 * the `program` label and the editor/pager roles come from the data table in
 * tui-profiles.ts.
 *
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */
import { programLabel } from './tui-profiles.ts';
import type { ProgramRole } from './tui-profiles.ts';

export interface MenuOption {
  index: number;
  number: number | null;
  label: string;
  selected: boolean;
  destructive: boolean;
}

export interface Menu {
  question: string | null;
  options: MenuOption[];
  /** The highlighted option; -1 on a `typed` menu (nothing is highlighted). */
  selected_index: number;
  /** The footer says Escape exits/quits the program ("Esc to exit"). */
  escape_exits: boolean;
  /**
   * How an option is chosen: `highlight` = Up/Down move the highlight and
   * Enter confirms it; `typed` = no highlight, type the option's number at
   * the prompt below the list, then Enter (e.g. bash `select`, "Enter choice:").
   */
  selection: 'highlight' | 'typed';
}

/** A question waiting for a typed answer on the cursor row. */
export interface InputPrompt {
  /** `yes_no`: a "[y/N]"-style question; `line`: a free-text input line behind a prompt glyph (`>`, `❯`, `>>>`, `? Name:`). */
  kind: 'yes_no' | 'line';
  question: string | null;
  /** yes_no only: the answer Enter alone gives (the upper-case letter), or null. */
  default?: 'yes' | 'no' | null;
  /** yes_no only: the question names a destructive action — answer "yes" only if the user asked. */
  destructive?: boolean;
}

export type ScreenState = 'shell_prompt' | 'busy' | 'menu' | 'text_input' | 'pager' | 'editor' | 'exited';

export interface ScreenSummary {
  program: string;
  state: ScreenState;
  menu: Menu | null;
  /** Text typed on the shell prompt line but not yet submitted (shell_prompt only). */
  input: string | null;
  /** The input prompt on the cursor row (text_input only). */
  prompt?: InputPrompt;
  last_lines: string[];
  exit_status?: number | null;
}

export interface ScreenLike {
  command: string;
  title?: string;
  mode: 'normal' | 'alternate';
  screen: string[];
  cursor: { x: number; y: number };
  dead?: boolean;
  deadStatus?: number | null;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'ash', 'tcsh', 'csh', '-bash', 'login']);

export function isShellCommand(cmd: string | null | undefined): boolean {
  return SHELLS.has(String(cmd ?? '').trim().toLowerCase());
}

/** Labels whose confirmation ends a program or throws work away. A bare "No" counts; "No, and tell it what to do instead" does not. */
const DESTRUCTIVE = /\b(exit|quit|abort|delete|discard|overwrite|don'?t trust|do not trust|reject|deny|cancel|kill|terminate|remove|log ?out|shut ?down)\b/i;

export function isDestructiveLabel(label: string): boolean {
  const l = label.trim();
  return DESTRUCTIVE.test(l) || /^no[\s,.!]*$/i.test(l);
}

// ── Menus ───────────────────────────────────────────────────────────────────

const stripBox = (l: string) => l.replace(/^\s*[│┃║]\s?/, '').replace(/\s*[│┃║]\s*$/, '').replace(/\s+$/, '');
const SEL = /^(\s*)([❯›→▶●◉➤>*])\s+(?:(\d{1,2})[.)]\s+)?(\S.*)$/;
const NUM = /^(\s*)(?:[❯›→▶●◉➤>*]\s+)?(\d{1,2})[.)]\s+(\S.*)$/;
/** Selection glyphs that mark an unnumbered list on their own. */
const UNNUMBERED_MARKERS = new Set(['❯', '›', '→', '▶', '●', '◉', '➤']);
/**
 * Glyphs that are ALSO common prompt characters (`> ` of a REPL): they mark
 * an unnumbered list only when the other rows sit at exactly the label column
 * (fzf-style pickers) and the row is not the cursor row (that is the query line).
 */
const STRICT_MARKERS = new Set(['>']);
const RULE_ROW = /^\s*[─━╭╮╰╯┌┐└┘]/;
/** A list's match counter ("  3/120", "  3/120 ───"): never an option. */
const COUNTER_ROW = /^\s*\d+\s*\/\s*\d+(\s|$)/;

/** The selected row of a list: where its label starts and how far sibling rows may drift from that column. */
interface Anchor { row: number; col: number; number: number | null; label: string; tolerance: number }
type RawOption = { row: number; number: number | null; label: string; selected: boolean };

function optionsAround(rows: string[], a: Anchor): RawOption[] {
  const opts: RawOption[] = [{ row: a.row, number: a.number, label: a.label, selected: true }];
  if (a.number !== null) {
    // Numbered: walk the number chain up and down from the selected row.
    let want = a.number - 1;
    for (let r = a.row - 1; r >= Math.max(0, a.row - 12) && want >= 1; r--) {
      const m = NUM.exec(rows[r]!);
      if (m && Number(m[2]) === want) { opts.unshift({ row: r, number: want, label: m[3]!.trim(), selected: false }); want--; }
    }
    want = a.number + 1;
    for (let r = a.row + 1; r < Math.min(rows.length, a.row + 13); r++) {
      const m = NUM.exec(rows[r]!);
      if (m && Number(m[2]) === want) { opts.push({ row: r, number: want, label: m[3]!.trim(), selected: false }); want++; }
    }
    return opts;
  }
  const sibling = (r: number) => {
    const t = rows[r] ?? '';
    if (!t.trim() || RULE_ROW.test(t) || COUNTER_ROW.test(t) || SEL.test(t)) return null;
    const indent = t.length - t.trimStart().length;
    return Math.abs(indent - a.col) <= a.tolerance ? t.trim() : null;
  };
  for (let r = a.row - 1; r >= 0; r--) { const l = sibling(r); if (!l) break; opts.unshift({ row: r, number: null, label: l, selected: false }); }
  for (let r = a.row + 1; r < rows.length; r++) { const l = sibling(r); if (!l) break; opts.push({ row: r, number: null, label: l, selected: false }); }
  return opts;
}

function menuOf(rows: string[], opts: RawOption[], selection: Menu['selection']): Menu {
  let question: string | null = null;
  for (let r = opts[0]!.row - 1; r >= Math.max(0, opts[0]!.row - 6); r--) {
    const t = rows[r]!.trim();
    if (t && !/^[─━╭╮╰╯┌┐└┘\s]+$/.test(t)) { question = t; break; }
  }
  const below = rows.slice(opts[opts.length - 1]!.row + 1).join('\n');
  return {
    question,
    options: opts.map((o, index) => ({ index, number: o.number, label: o.label, selected: o.selected, destructive: isDestructiveLabel(o.label) })),
    selected_index: opts.findIndex((o) => o.selected),
    escape_exits: /\besc(ape)?\b[^\n]{0,12}\b(to )?(exit|quit)\b/i.test(below),
    selection,
  };
}

export interface DetectMenuOptions {
  /** The cursor row: a strict-marker row there is a query/prompt line, not a selection. */
  cursorRow?: number;
  /**
   * A row known to be highlighted by other means (reverse video, see
   * menu-select.ts `menuFromStyled`): read it as the selected row even
   * without a marker glyph.
   */
  selectedRow?: number;
}

/**
 * The highlight-style selection menu on screen (the one nearest the bottom),
 * or null: a row with a selection glyph (`❯ › → ▶ ● ◉ ➤`; `>` only with the
 * strict rule above; `>` / `*` also before a number) plus its siblings — a
 * number chain (`1.` / `1)`) or rows at the label's column.
 */
export function detectMenu(screen: string[], opts: DetectMenuOptions = {}): Menu | null {
  const rows = screen.map(stripBox);
  if (opts.selectedRow !== undefined) {
    const line = rows[opts.selectedRow];
    if (line === undefined || !line.trim()) return null;
    const col = line.length - line.trimStart().length;
    const num = /^(\d{1,2})[.)]\s+(\S.*)$/.exec(line.trim());
    const found = optionsAround(rows, {
      row: opts.selectedRow, col, tolerance: 2,
      number: num ? Number(num[1]) : null, label: num ? num[2]!.trim() : line.trim(),
    });
    return found.length >= 2 ? menuOf(rows, found, 'highlight') : null;
  }
  for (let s = rows.length - 1; s >= 0; s--) {
    const sel = SEL.exec(rows[s]!);
    if (!sel) continue;
    const marker = sel[2]!;
    let anchor: Anchor;
    if (sel[3]) anchor = { row: s, col: 0, tolerance: 0, number: Number(sel[3]), label: sel[4]!.trim() };
    else if (UNNUMBERED_MARKERS.has(marker)) anchor = { row: s, col: sel[1]!.length + marker.length + 1, tolerance: 2, number: null, label: sel[4]!.trim() };
    else if (STRICT_MARKERS.has(marker) && s !== opts.cursorRow) {
      anchor = { row: s, col: sel[1]!.length + marker.length + 1, tolerance: 0, number: null, label: sel[4]!.trim() };
    } else continue;
    const found = optionsAround(rows, anchor);
    if (found.length >= 2) return menuOf(rows, found, 'highlight');
  }
  return null;
}

const TYPED_OPT = /^\s*(?:\[(\d{1,2})\]|(\d{1,2})[.)])\s+(\S.*)$/;
/** A second `N)` column on one row: a multi-column list we cannot map to rows reliably. */
const MULTI_COL = /\S\s{2,}(?:\[\d{1,2}\]|\d{1,2}[.)])\s+\S/;

/**
 * A numbered list answered by TYPING a number, or null: options `1) a` /
 * `1. a` / `[1] a` numbered 1..n directly above the cursor row, and the
 * cursor row is a question prompt ending in `?` or `:` (bash `select`'s
 * `#?`, "Enter choice [1-3]:"), possibly with digits already typed.
 */
export function detectTypedMenu(screen: string[], cursorRow: number): Menu | null {
  const rows = screen.map(stripBox);
  const cur = (rows[cursorRow] ?? '').replace(/\s+$/, '');
  if (!cur.trim() || TYPED_OPT.test(cur)) return null;
  if (!/[?:]$/.test(cur.replace(/\s*\d{0,2}$/, ''))) return null;
  let r = cursorRow - 1;
  for (let blanks = 0; r >= 0 && !rows[r]!.trim() && blanks < 2; blanks++) r--;
  const found: RawOption[] = [];
  for (; r >= 0; r--) {
    const m = TYPED_OPT.exec(rows[r]!);
    if (!m) break;
    if (MULTI_COL.test(rows[r]!)) return null;
    found.unshift({ row: r, number: Number(m[1] ?? m[2]), label: m[3]!.trim(), selected: false });
  }
  if (found.length < 2 || found.some((o, i) => o.number !== i + 1)) return null;
  return menuOf(rows, found, 'typed');
}

// ── Input prompts ───────────────────────────────────────────────────────────

const YES_NO = /[[(]\s*(y|yes)\s*\/\s*(n|no)\s*[\])]|\b(y|yes)\/(n|no)\b/i;
/** A free-text input line: a prompt glyph at the start of the cursor row (inside a box border or not). */
const LINE_PROMPT = /^\s*[│┃║]?\s*(>>>|\.\.\.|[>❯›»➜])(\s|$)/;
/** An inquirer-style question line: `? Project name: …`. */
const QUESTION_LINE = /^\s*[?]\s+\S[^?:]*[?:](\s|$)/;
/** A shell prompt ahead of the text: the row is a command being typed, not a question. */
const SHELL_PROMPT_BEFORE = /[$#%❯]\s/;

/** The input prompt on the cursor row, or null. */
export function detectPrompt(screen: string[], cursor: { x: number; y: number }): InputPrompt | null {
  const raw = (screen[cursor.y] ?? '').replace(/\s+$/, '');
  const row = stripBox(raw);
  const yn = YES_NO.exec(row);
  if (yn && /^\s*[:?]?\s*(y|yes|n|no)?\s*$/i.test(row.slice(yn.index + yn[0].length))) {
    const before = row.slice(0, yn.index).trim();
    if (!SHELL_PROMPT_BEFORE.test(row.slice(0, yn.index))) {
      let question: string | null = before || null;
      for (let r = cursor.y - 1; !question && r >= Math.max(0, cursor.y - 3); r--) question = stripBox(screen[r] ?? '').trim() || null;
      const y = yn[1] ?? yn[3] ?? '';
      const n = yn[2] ?? yn[4] ?? '';
      const upperY = y[0] === 'Y' && n[0] === 'n';
      const upperN = n[0] === 'N' && y[0] === 'y';
      return {
        kind: 'yes_no', question,
        default: upperY ? 'yes' : upperN ? 'no' : null,
        destructive: question ? DESTRUCTIVE.test(question) : false,
      };
    }
  }
  if (LINE_PROMPT.test(raw) || QUESTION_LINE.test(row)) {
    const q = QUESTION_LINE.test(row) ? row.trim().replace(/^\?\s+/, '').replace(/([?:]).*$/, '$1') : null;
    return { kind: 'line', question: q };
  }
  return null;
}

/** "Esc to interrupt" / "Ctrl+C to interrupt": the program is working and says how to stop it. */
const BUSY_HINT = /\b(esc|escape|ctrl\+c|\^c)\s+to\s+interrupt\b/i;

// ── Program + state ─────────────────────────────────────────────────────────

function identify(v: Pick<ScreenLike, 'command' | 'title' | 'screen'>): { program: string; role: ProgramRole | null } {
  const cmd = String(v.command ?? '').trim().toLowerCase();
  if (isShellCommand(cmd)) return { program: 'shell', role: null };
  return programLabel(cmd, v.title ?? '', v.screen);
}

/** Best guess at the program owning the pane: `shell`, a label from tui-profiles.ts, else the foreground command. */
export function programOf(v: Pick<ScreenLike, 'command' | 'title' | 'screen'>): string {
  return identify(v).program;
}

/** The text after the prompt on the cursor row (`user@host:~$ ls -l` → `ls -l`). */
export function promptInput(screen: string[], cursor: { x: number; y: number }): string | null {
  const row = (screen[cursor.y] ?? '').replace(/\s+$/, '');
  const m = /^.*?[$#%>❯]\s(.*)$/.exec(row) ?? /^.*?[$#%>❯]$/.exec(row);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

export function summarizeScreen(v: ScreenLike): ScreenSummary {
  const last_lines = v.screen.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-3);
  const { program, role } = identify(v);
  if (v.dead) return { program, state: 'exited', menu: null, input: null, last_lines, exit_status: v.deadStatus ?? null };
  if (program === 'shell' && v.mode === 'normal') {
    // A script running in the shell may ask for a number or a yes/no; otherwise this is the shell's own prompt.
    const typed = detectTypedMenu(v.screen, v.cursor.y);
    if (typed) return { program, state: 'menu', menu: typed, input: null, last_lines };
    const p = detectPrompt(v.screen, v.cursor);
    if (p?.kind === 'yes_no') return { program, state: 'text_input', menu: null, input: null, prompt: p, last_lines };
    return { program, state: 'shell_prompt', menu: null, input: promptInput(v.screen, v.cursor), last_lines };
  }
  const menu = detectMenu(v.screen, { cursorRow: v.cursor.y }) ?? detectTypedMenu(v.screen, v.cursor.y);
  if (menu) return { program, state: 'menu', menu, input: null, last_lines };
  if (role === 'pager') return { program, state: 'pager', menu: null, input: null, last_lines };
  if (role === 'editor') return { program, state: 'editor', menu: null, input: null, last_lines };
  if (v.screen.some((l) => BUSY_HINT.test(l))) return { program, state: 'busy', menu: null, input: null, last_lines };
  const prompt = detectPrompt(v.screen, v.cursor);
  if (prompt) return { program, state: 'text_input', menu: null, input: null, prompt, last_lines };
  return { program, state: 'busy', menu: null, input: null, last_lines };
}

/** A one-line summary for a tool result's text header. */
export function summaryLine(s: ScreenSummary): string {
  const parts = [`program=${s.program}`, `state=${s.state}`];
  if (s.input) parts.push(`input=${JSON.stringify(s.input)}`);
  if (s.prompt) {
    parts.push(`prompt=${s.prompt.kind}`);
    if (s.prompt.question) parts.push(`question=${JSON.stringify(s.prompt.question)}`);
    if (s.prompt.default) parts.push(`default=${s.prompt.default}`);
    if (s.prompt.destructive) parts.push('[destructive]');
  }
  if (s.menu) {
    if (s.menu.selection === 'typed') parts.push('menu_selection=typed');
    const sel = s.menu.options[s.menu.selected_index];
    parts.push(`menu=${JSON.stringify(s.menu.options.map((o) => `${o.number ? `${o.number}. ` : ''}${o.label}${o.selected ? ' [selected]' : ''}${o.destructive ? ' [destructive]' : ''}`))}`);
    if (sel) parts.push(`selected=${JSON.stringify(sel.label)}`);
  }
  if (s.state === 'exited') parts.push(`exit_status=${s.exit_status ?? '?'}`);
  return parts.join(' ');
}

// ── Settling ────────────────────────────────────────────────────────────────

const SPINNER = /[⠀-⣿✻✽✶✳✢✺✹✸✷◐◓◑◒◴◵◶◷⣾⣽⣻⢿⡿⣟⣯⣷]/g;

/** The screen minus content that changes while a program merely waits (spinner glyphs, timers, token counters). */
export function settleKey(lines: string[]): string {
  return lines.map((l) => l
    .replace(SPINNER, '')
    .replace(/\d+(\.\d+)?\s*(ms|s|m|h)\b/g, '#t')
    .replace(/[\d.,]+\s*k?\s*tokens?/gi, '#tok')
    .replace(/\s+$/, '')).join('\n');
}

/** A screen that is waiting for the user — safe to return early once it stopped changing. */
export function isReadyState(s: ScreenSummary): boolean {
  return (s.state === 'shell_prompt' && !s.input) || s.state === 'menu' || s.state === 'text_input' || s.state === 'exited';
}

// ── Input guard ─────────────────────────────────────────────────────────────

/** One input step in order: a key name (friendly or tmux) or literal text. */
export type InputStep = { key: string } | { text: string };

export interface Refusal {
  refused: true;
  reason: string;
  would_select?: string;
  hint: string;
}

/** A shell command line that would end the shell (and with it the session) or the machine. */
const SHELL_KILLERS = /^(exit|logout|exec|shutdown|reboot|halt|poweroff|init\s+[06]|kill\s+(-\S+\s+)*(\$\$|\$PPID|-1|1|0)|pkill\s+(-\S+\s+)*(bash|sh|tmux|node)|killall|tmux\s+kill-(server|session)|systemctl\s+(poweroff|reboot|halt))(?=\s|$|;|\))/;

export function killsShell(line: string): string | null {
  for (const seg of line.split(/;|&&|\|\||\||\n/)) {
    const t = seg.trim();
    if (SHELL_KILLERS.test(t)) return t;
  }
  return null;
}

const norm = (k: string) => k.trim().toLowerCase().replace(/^control[+-]|^ctrl[+-]|^c-/, 'ctrl+');
const isEnter = (k: string) => ['enter', 'return', 'cr', 'ctrl+m', 'ctrl+j', 'kpenter'].includes(norm(k));
const isCtrlD = (k: string) => norm(k) === 'ctrl+d';
const isInterrupt = (k: string) => ['ctrl+c', 'ctrl+d', 'ctrl+\\', 'escape', 'esc', 'q', 'ctrl+z'].includes(norm(k));
const optionName = (o: MenuOption) => `${o.number ? `${o.number}. ` : ''}${o.label}`;

const FORCE_HINT = 'Not sent. Pass force:true ONLY if the user explicitly asked for exactly this; otherwise read get_screen and choose another key.';

/**
 * Refuse input that would close the shell or confirm a destructive menu
 * option. `summary` is the screen right before sending. Returns null when the
 * input is fine.
 */
export function guardInput(summary: ScreenSummary, steps: InputStep[]): Refusal | null {
  const atShell = summary.state === 'shell_prompt';
  let mayBeShell = atShell;   // a Ctrl+C / q / Escape earlier in the batch may drop to the shell
  let line = atShell ? (summary.input ?? '') : '';
  const menu = summary.state === 'menu' ? summary.menu : null;
  let possible: Set<number> | null = menu ? new Set([menu.selected_index]) : null;

  const refuse = (reason: string, would_select?: string): Refusal =>
    ({ refused: true, reason, ...(would_select ? { would_select } : {}), hint: FORCE_HINT });

  const confirmMenu = (indices: Iterable<number>): Refusal | null => {
    if (!menu) return null;
    for (const i of indices) {
      const o = menu.options[i];
      if (o?.destructive) return refuse(`Enter would confirm the destructive menu option "${optionName(o)}"${menu.question ? ` for "${menu.question}"` : ''}.`, optionName(o));
    }
    possible = null;   // a safe option was confirmed: the menu is gone, stop simulating it
    return null;
  };
  const submitLine = (): Refusal | null => {
    if (mayBeShell) {
      const k = killsShell(line);
      if (k) return refuse(`"${k}" at a shell prompt would end the shell and close this terminal session.`);
    }
    line = '';
    return null;
  };

  for (const step of steps) {
    if ('text' in step) {
      for (const ch of step.text) {
        if (ch === '\r' || ch === '\n') {
          if (possible) { const r = confirmMenu(possible); if (r) return r; continue; }
          const r = submitLine(); if (r) return r;
          continue;
        }
        if (ch === '\u0004' && mayBeShell && !line) return refuse('Ctrl+D at an empty shell prompt would end the shell and close this terminal session.');
        if (possible && menu && /\d/.test(ch)) {
          const o = menu.options.find((x) => x.number === Number(ch));
          if (o) { const r = confirmMenu([o.index]); if (r) return refuse(`Pressing "${ch}" selects "${optionName(o)}" in the menu, which is destructive.`, optionName(o)); continue; }
        }
        line += ch;
      }
      continue;
    }
    const key = step.key;
    if (isEnter(key)) {
      if (possible) { const r = confirmMenu(possible); if (r) return r; continue; }
      const r = submitLine(); if (r) return r;
      continue;
    }
    if (isCtrlD(key) && mayBeShell && !line) {
      return refuse(atShell
        ? 'Ctrl+D at a shell prompt would end the shell and close this terminal session.'
        : 'Ctrl+D after an interrupt key in the same batch may land on the shell prompt and close the session.');
    }
    if (menu && possible && (norm(key) === 'escape' || norm(key) === 'esc') && menu.escape_exits) {
      return refuse('Escape on this menu exits the program (its footer says "Esc to exit").');
    }
    if (menu && possible && (norm(key) === 'up' || norm(key) === 'down' || norm(key) === 'k' || norm(key) === 'j')) {
      // Simulate both clamping and wrap-around: different TUIs do either.
      const n = menu.options.length;
      const up = norm(key) === 'up' || norm(key) === 'k';
      const next = new Set<number>();
      for (const i of possible) {
        const j = up ? i - 1 : i + 1;
        if (j < 0) { next.add(0); next.add(n - 1); } else if (j >= n) { next.add(n - 1); next.add(0); } else next.add(j);
      }
      possible = next;
      continue;
    }
    if (menu && possible && /^\d$/.test(key.trim())) {
      const o = menu.options.find((x) => x.number === Number(key.trim()));
      if (o) { if (o.destructive) return refuse(`Pressing "${key.trim()}" selects "${optionName(o)}" in the menu, which is destructive.`, optionName(o)); possible = null; continue; }
    }
    if (isInterrupt(key)) { mayBeShell = true; line = ''; possible = null; continue; }
    if (norm(key) === 'ctrl+u') { line = ''; continue; }
    if (['backspace', 'bspace', 'bs'].includes(norm(key))) { line = line.slice(0, -1); continue; }
    if ([...key].length === 1) line += key;
    else if (norm(key) === 'space') line += ' ';
  }
  return null;
}
