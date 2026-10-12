/**
 * `act` — one act-and-verify step on a terminal session (B11 / TM-11).
 *
 * read the screen → summary → B6 guard (screen-summary.ts `guardInput`, plus
 * the exited-shell and optional menu checks) → ONE input batch → settle or
 * `wait_for` → the screen after, its summary and the rows that changed.
 *
 * I/O is injected (`ActDeps`) so the flow is testable without tmux; the MCP
 * tool in terminal.ts wires it to `screenFor` / `inputFor`. `run_command` is
 * `act` with text + Enter and the menu check on.
 */
import { guardInput, summarizeScreen } from '../screen-summary.ts';
import type { InputStep, ScreenSummary } from '../screen-summary.ts';
import type { ScreenOptions, ScreenView } from '../session-service.ts';

export interface ActDeps {
  screen(id: string, opts: ScreenOptions): Promise<ScreenView>;
  /** Send the steps as one input batch (terminal.ts `sendSteps` → `inputFor`). */
  send(id: string, steps: InputStep[], paste: boolean): Promise<{ chars: number; keys: string[] }>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface ActOptions {
  steps: InputStep[];
  paste?: boolean;
  /** Skip the guard (the screen is still read for the summary and the diff). */
  force?: boolean;
  /** Refuse while a selection menu is on screen (run_command: typed text would pick options). */
  refuseOnMenu?: boolean;
  /** Wait until this text (or `/regex/flags`) appears on a new row instead of waiting for the screen to settle. */
  waitFor?: string;
  settleMs?: number;
  timeoutMs?: number;
  scrollback?: number;
}

export interface ChangedRow { row: number; text: string; before?: string }

export type ActOutcome =
  | { refused: Record<string, unknown> }
  | {
    before: ScreenView;
    beforeSummary: ScreenSummary;
    sent: { chars: number; keys: string[] };
    after: ScreenView;
    summary: ScreenSummary;
    changed: ChangedRow[];
    waitFor?: { pattern: string; matched: boolean };
    elapsedMs: number;
  };

export const ACT_DEFAULTS = { settleMs: 200, timeoutMs: 4_000 } as const;
const POLL_MS = 100;

export function summarize(view: ScreenView): ScreenSummary {
  return summarizeScreen({
    command: view.command, title: view.title, mode: view.mode, screen: view.screen, cursor: view.cursor,
    dead: view.dead, deadStatus: view.deadStatus,
  });
}

/**
 * The B6 decision for a screen summary: a refusal payload (without target
 * info) or null. Shared by every input tool so the guard has one source.
 */
export function refusalFor(summary: ScreenSummary, steps: InputStep[], opts: { refuseOnMenu?: boolean; respawned?: boolean } = {}): Record<string, unknown> | null {
  if (summary.state === 'exited') {
    return { refused: true, reason: `The shell in this session has exited (status ${summary.exit_status ?? '?'}).`, hint: opts.respawned
      ? 'Nothing was sent. A fresh shell was started in the same session: read the screen, then send again if it still makes sense. Do not open a new session.'
      : 'Nothing was sent. Tell the user; do not open a new session unless asked.',
      ...(opts.respawned ? { respawned: true } : {}) };
  }
  if (opts.refuseOnMenu && summary.state === 'menu') {
    return { refused: true, reason: 'A selection menu is on screen — typing a command would select options.', hint: 'Not sent. Use get_status, then send_keys for the menu.', menu: summary.menu };
  }
  const refusal = guardInput(summary, steps);
  if (refusal) return { ...refusal, screen_state: summary.state, program: summary.program, ...(summary.menu ? { menu: summary.menu } : {}) };
  return null;
}

const trimEnd = (l: string | undefined) => (l ?? '').replace(/\s+$/, '');

/** Rows whose text differs between two grids (trailing blanks ignored), top to bottom. */
export function changedRows(before: string[], after: string[], withBefore = false): ChangedRow[] {
  const out: ChangedRow[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const a = trimEnd(after[i]);
    const b = trimEnd(before[i]);
    if (a !== b) out.push(withBefore ? { row: i, text: a, before: b } : { row: i, text: a });
  }
  return out;
}

/** `/re/flags` → RegExp, anything else → a literal substring test. Throws on a bad regex. */
export function waitMatcher(pattern: string): (line: string) => boolean {
  const m = /^\/(.+)\/([dgimsuy]*)$/s.exec(pattern);
  if (m) { const re = new RegExp(m[1]!, m[2]!.replace(/g|y/g, '')); return (l) => re.test(l); }
  return (l) => l.includes(pattern);
}

/**
 * True when a row matching `test` is NEW: some matching row text occurs more
 * often on `after` than on `before`. Text that was already on screen (or just
 * scrolled up) does not count, so waiting for "$ " waits for the NEXT prompt.
 * A before-row that was extended in place (the prompt line the input was typed
 * on: "$" → "$ ls") no longer counts as already present.
 */
export function hasNewMatch(before: string[], after: string[], test: (line: string) => boolean): boolean {
  const count = (rows: string[], skip: (i: number) => boolean = () => false) => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => { const t = trimEnd(r); if (!skip(i) && test(t)) m.set(t, (m.get(t) ?? 0) + 1); });
    return m;
  };
  const extended = (i: number) => {
    const b = trimEnd(before[i]);
    const a = trimEnd(after[i]);
    return a !== b && a.startsWith(b);
  };
  const b = count(before, extended);
  for (const [text, n] of count(after)) if (n > (b.get(text) ?? 0)) return true;
  return false;
}

export async function act(deps: ActDeps, id: string, o: ActOptions): Promise<ActOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const now = deps.now ?? Date.now;
  const before = await deps.screen(id, { settleMs: 0 });
  const beforeSummary = summarize(before);
  if (!o.force) {
    const refused = refusalFor(beforeSummary, o.steps, { refuseOnMenu: o.refuseOnMenu, respawned: before.respawned });
    if (refused) return { refused };
  }
  const test = o.waitFor !== undefined ? waitMatcher(o.waitFor) : null;   // a bad regex throws before anything is sent
  const started = now();
  const sent = await deps.send(id, o.steps, o.paste ?? false);
  const timeoutMs = o.timeoutMs ?? ACT_DEFAULTS.timeoutMs;

  let after: ScreenView;
  let waitFor: { pattern: string; matched: boolean } | undefined;
  if (test) {
    let matched = false;
    for (;;) {
      after = await deps.screen(id, { settleMs: 0, scrollback: o.scrollback });
      matched = hasNewMatch(before.screen, after.screen, test);
      if (matched || now() - started >= timeoutMs) break;
      await sleep(POLL_MS);
    }
    // In wait_for mode `settled` means "the condition was met before timeout_ms".
    after = { ...after, settled: matched };
    waitFor = { pattern: o.waitFor!, matched };
  } else {
    after = await deps.screen(id, { settleMs: o.settleMs ?? ACT_DEFAULTS.settleMs, timeoutMs, scrollback: o.scrollback });
  }
  return {
    before, beforeSummary, sent, after, summary: summarize(after),
    changed: changedRows(before.screen, after.screen, true), ...(waitFor ? { waitFor } : {}), elapsedMs: now() - started,
  };
}
