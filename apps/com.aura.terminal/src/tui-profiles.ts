/**
 * Program profiles — DATA, not logic (TM-18).
 *
 * The terminal MCP understands screens through generic detectors in
 * screen-summary.ts (selection menus, typed-number menus, yes/no prompts,
 * input lines, busy hints). Nothing there branches on a program's name.
 *
 * This table only decides the `program` LABEL a summary reports, plus a
 * coarse `role` for programs whose screen has no generic shape to detect
 * (an editor or a pager looks like arbitrary text). To teach the MCP about
 * another program, add a row here; never add a name check to a detector.
 *
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */

/** What a program is for, when its screen alone does not say: drives the `pager` / `editor` states. */
export type ProgramRole = 'editor' | 'pager' | 'repl' | 'prompt-tui';

export interface ProgramProfile {
  /** Label reported as `program`; omitted = the foreground command's own name. */
  program?: string;
  role?: ProgramRole;
  /** Foreground command names (lower-cased) that are this program. */
  commands: RegExp;
  /** A pane title that names this program, for any non-shell command. */
  title?: RegExp;
  /**
   * Runtimes this program often runs under (e.g. a CLI shipped as a `node`
   * script): the foreground command then only says "node", so one of
   * `screen` / `screenPairs` must ALSO match before the label applies.
   */
  hosts?: RegExp;
  /** Any visible row matching one of these identifies the program (only with `hosts`). */
  screen?: RegExp[];
  /** Two adjacent rows (`above`, then `row`) that identify the program (only with `hosts`). */
  screenPairs?: Array<{ above: RegExp; row: RegExp }>;
}

/** First match wins. Shells are recognised before this table (screen-summary.ts `isShellCommand`). */
export const PROGRAM_PROFILES: readonly ProgramProfile[] = [
  {
    // Claude Code: often runs as plain `node`; recognised by its footer hints
    // or its input row (`❯ …` directly under a horizontal rule).
    program: 'claude', role: 'prompt-tui', commands: /^claude$/, title: /claude/i, hosts: /^node$/,
    screen: [/Claude Code|claude\.ai|\? for shortcuts|esc to interrupt|bypass permissions|⏵⏵/],
    screenPairs: [{ above: /^\s*─{10,}/, row: /^\s*❯\s/ }],
  },
  { role: 'editor', commands: /^(n?vim?|vi|nano|emacs|micro|hx)$/ },
  { role: 'pager', commands: /^(less|more|man|most)$/ },
  { program: 'python', role: 'repl', commands: /^python\d*(\.\d+)?$/ },
];

/** The profile for a foreground command / title / screen, or null. */
export function profileFor(cmd: string, title: string, screen: string[]): ProgramProfile | null {
  for (const p of PROGRAM_PROFILES) {
    if (p.commands.test(cmd)) return p;
    if (p.title && title && p.title.test(title)) return p;
    if (p.hosts && p.hosts.test(cmd) && screen.some((l, i) =>
      (p.screen ?? []).some((re) => re.test(l))
      || (p.screenPairs ?? []).some((pair) => pair.above.test(l) && pair.row.test(screen[i + 1] ?? '')))) return p;
  }
  return null;
}

/** The `program` label for a non-shell command. */
export function programLabel(cmd: string, title: string, screen: string[]): { program: string; role: ProgramRole | null } {
  const p = profileFor(cmd, title, screen);
  return { program: p?.program ?? (cmd || 'unknown'), role: p?.role ?? null };
}
