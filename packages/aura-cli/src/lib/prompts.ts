import { stdin, stdout } from 'node:process';
import { moveCursor, clearScreenDown } from 'node:readline';
import { color } from './format.js';

/**
 * Sentinel returned by prompts when the user presses the back key (Esc on
 * pickers, Esc at empty input on text). Caller checks `=== BACK` and walks
 * its step index backwards. Symbol because that's guaranteed unique even if
 * a future prompt returns string literals.
 */
export const BACK = Symbol('aura.prompt.back');
export type BackSignal = typeof BACK;

/**
 * Interactive prompt helpers for `aura dev new` (and any future wizards).
 * Intentionally tiny — no `inquirer` dependency — so the esbuild bundle stays
 * compact. Same raw-mode arrow-key approach as `commands/jump.ts`.
 *
 * Each function rejects on Ctrl-C / Escape so the caller can clean up and
 * exit with a sensible code. All output goes to stdout; stderr stays free
 * for warn/fail so scripted callers can still pipe through.
 */

const KEY_ENTER = '\r';
const KEY_UP    = '\x1b[A';
const KEY_DOWN  = '\x1b[B';
const KEY_LEFT  = '\x1b[D';
const KEY_RIGHT = '\x1b[C';
const KEY_ESC   = '\x1b';
const KEY_CTRLC = '\x03';
// Ctrl-B = "back" across all interactive prompts. Picked because every other
// candidate had a browser-level collision when the CLI runs inside the
// AuraOS terminal iframe: Esc exits browser fullscreen, Backspace navigates
// browser history. Ctrl-B is a free byte (\x02) in browsers and shells.
const KEY_CTRLB = '\x02';
void KEY_RIGHT; // exported alongside KEY_LEFT for symmetry; not currently consumed

export class PromptCancelled extends Error {
  constructor() { super('prompt cancelled'); this.name = 'PromptCancelled'; }
}

/**
 * Tiny raw-mode line editor used by `promptText`. Replaces readline so we
 * can intercept Ctrl-B cleanly (readline swallows it). Supports:
 *   • printable chars + utf-8 paste
 *   • Backspace / Ctrl-H — delete char before cursor (normal editing).
 *   • Ctrl-B → return BACK when `allowBack` is set. Used by the wizard's
 *     step machinery to walk one step backwards. Picked because Esc exits
 *     browser fullscreen and Backspace navigates browser history; Ctrl-B
 *     has neither collision.
 *   • Ctrl-U → clear line
 *   • Ctrl-C → reject with PromptCancelled (the only cancel key)
 *   • Enter (\r / \n) → submit
 *   • Esc + Left/Right arrows are intentionally swallowed.
 */
function readLineRaw(opts: { allowBack?: boolean }): Promise<string | BackSignal> {
  if (!stdin.isTTY) {
    throw new Error('promptText needs a TTY (use flags for non-interactive runs).');
  }
  return new Promise((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const cleanup = () => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); };
    const onData = (data: string) => {
      // Multi-char terminal sequences (paste, escape sequences). Handle the
      // common ones; ignore the rest so the user can't accidentally inject
      // garbage by pressing arrow keys.
      if (data === KEY_CTRLC) { cleanup(); reject(new PromptCancelled()); return; }
      if (data === KEY_ENTER || data === '\n') { cleanup(); stdout.write('\n'); resolve(buf); return; }
      // Esc is intentionally swallowed (see header docstring) — we never
      // want it to leak back to the browser as a fullscreen-exit key.
      if (data === KEY_ESC) return;
      // Ctrl-B → go back (only when caller opted in). Always swallowed.
      if (data === KEY_CTRLB) {
        if (opts.allowBack) { cleanup(); stdout.write('\n'); resolve(BACK); return; }
        return;
      }
      if (data === '') { // Ctrl-U → clear line
        if (buf.length) { stdout.write('\r\x1b[K'); /* caller redraws header */ }
        buf = '';
        return;
      }
      if (data === '\x7f' || data === '\b') {
        // Plain delete-last-char. Backspace is NOT a back signal — Chrome and
        // older browsers map it to "navigate back" in browser history, which
        // would take the user out of AuraOS entirely if it leaked through.
        if (buf.length) {
          buf = buf.slice(0, -1);
          stdout.write('\b \b');
        }
        return;
      }
      // Skip ANSI CSI sequences (arrow keys, function keys) — ignored in text mode.
      if (data.startsWith('\x1b[') || data.startsWith('\x1bO')) return;
      // Accept any printable string (handles single chars and pasted runs).
      // Strip control bytes from pastes so accidental \r in the middle doesn't submit early.
      const cleaned = data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      if (!cleaned) return;
      buf += cleaned;
      stdout.write(cleaned);
    };
    stdin.on('data', onData);
  });
}

export async function promptText(
  question: string,
  opts: {
    /** Default value used when the user just hits enter. Shown in dim parens. */
    default?: string;
    /** Return `null` to accept, or an error message to re-prompt. */
    validate?: (v: string) => string | null;
    /** Enables Backspace-at-empty as the BACK signal; shows hint. */
    allowBack?: boolean;
  } = {},
): Promise<string | BackSignal> {
  for (;;) {
    const defHint  = opts.default !== undefined ? color.dim(` (${opts.default})`) : '';
    const backHint = opts.allowBack ? color.dim(' [⌃B back]') : '';
    stdout.write(`${color.cyan('?')} ${question}${defHint}${backHint} `);
    const raw = await readLineRaw({ allowBack: opts.allowBack ?? false });
    if (raw === BACK) return BACK;
    const value = raw.trim() || (opts.default ?? '');
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) { stdout.write(`  ${color.red('✗')} ${err}\n`); continue; }
    }
    return value;
  }
}

export async function promptConfirm(
  question: string,
  defaultYes = true,
  opts: { allowBack?: boolean } = {},
): Promise<boolean | BackSignal> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const v = await promptText(`${question} ${color.dim(hint)}`, {
    default: defaultYes ? 'y' : 'n',
    ...(opts.allowBack ? { allowBack: true } : {}),
  });
  if (v === BACK) return BACK;
  return /^y/i.test(v);
}

export interface ChoiceOption<T> {
  /** Returned value when this option is chosen. */
  value: T;
  /** What the user sees in the picker. */
  label: string;
  /** One-line description shown dimmed beside the label. */
  desc?: string;
}

export async function promptChoice<T>(
  question: string,
  options: ChoiceOption<T>[],
  defaultIdx = 0,
  opts: { allowBack?: boolean } = {},
): Promise<T | BackSignal> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`promptChoice "${question}" needs a TTY (pass flags non-interactively instead).`);
  }
  let idx = Math.max(0, Math.min(defaultIdx, options.length - 1));
  let linesWritten = 0;

  const draw = (firstTime: boolean) => {
    if (!firstTime) {
      moveCursor(stdout, 0, -linesWritten);
      clearScreenDown(stdout);
    }
    const lines: string[] = [];
    lines.push(`${color.cyan('?')} ${question}`);
    for (let i = 0; i < options.length; i++) {
      const o = options[i]!;
      const cursor = i === idx ? color.green('▸') : ' ';
      const label  = i === idx ? color.bold(o.label) : o.label;
      const desc   = o.desc ? color.dim(`  — ${o.desc}`) : '';
      lines.push(`  ${cursor} ${label}${desc}`);
    }
    const back = opts.allowBack ? '   ⌃B/← back' : '';
    lines.push(color.dim(`  ↑↓ navigate   ↵ enter${back}   ^C cancel`));
    const text = lines.join('\n') + '\n';
    stdout.write(text);
    // Count actual newlines so the rewind matches what we just wrote
    // (the picker stops drifting even if a label embeds a newline later).
    linesWritten = (text.match(/\n/g) ?? []).length;
  };

  return new Promise<T | BackSignal>((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (data: string) => {
      if (data === KEY_CTRLC) { cleanup(); reject(new PromptCancelled()); return; }
      // Esc + Backspace are silently swallowed — Esc would exit browser
      // fullscreen, Backspace would navigate the iframe's history.
      if (data === KEY_ESC) return;
      if (data === '\x7f' || data === '\b') return;
      // Back keys: Ctrl-B (universal), Left-arrow, or vim 'h'.
      if (data === KEY_CTRLB || data === KEY_LEFT || data === 'h') {
        if (opts.allowBack) { cleanup(); resolve(BACK); return; }
        return;
      }
      if (data === KEY_ENTER) { cleanup(); resolve(options[idx]!.value); return; }
      if (data === KEY_UP   || data === 'k') { idx = (idx - 1 + options.length) % options.length; draw(false); return; }
      if (data === KEY_DOWN || data === 'j') { idx = (idx + 1) % options.length; draw(false); return; }
      // Digit quick-pick: 1..9 maps to the matching option index.
      if (data >= '1' && data <= '9') {
        const n = parseInt(data, 10) - 1;
        if (n < options.length) { cleanup(); resolve(options[n]!.value); }
      }
    };
    stdin.on('data', onData);
    draw(true);
  });
}

// ─── Multi-select with mode switch + fuzzy filter ─────────────────────────────

export interface MultiSelectMode<T> {
  /** Hint shown in the header (e.g. "enable only", "install + enable"). */
  label: string;
  /** Items visible in this mode. Same value across modes shares a check state. */
  options: Array<{
    value: T;
    label: string;
    desc?: string;
    /** Right-side badge (e.g. "installed", "apt"). */
    tag?: string;
    /** Pre-checked at first paint. Honored only on the first mode that has it. */
    initiallyChecked?: boolean;
  }>;
}

export interface MultiSelectResult<T> {
  modeIdx: number;
  selected: T[];
}

/**
 * Checkbox picker with three super-powers compared to `promptChoice`:
 *   • Space toggles each row (Enter confirms the whole set).
 *   • Pressing 'm' (or Tab) cycles through `modes` — same `value` retains its
 *     check across modes, so e.g. "enable only" → "install + enable" still
 *     shows the user's prior toggles.
 *   • '/' opens a sub-input that filters the visible rows by substring match
 *     on label + tag + desc. Esc clears the filter; Backspace deletes a char.
 *
 * Returns the selected values + the mode the user was in when they confirmed
 * (so the caller can decide whether to install, just enable, etc.).
 */
export async function promptMultiSelect<T>(
  question: string,
  modes: MultiSelectMode<T>[],
  initialModeIdx = 0,
  opts: { allowBack?: boolean } = {},
): Promise<MultiSelectResult<T> | BackSignal> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`promptMultiSelect "${question}" needs a TTY.`);
  }
  if (modes.length === 0) throw new Error('promptMultiSelect needs at least one mode');

  let modeIdx = Math.max(0, Math.min(initialModeIdx, modes.length - 1));
  const checked = new Set<T>();
  // Seed from initiallyChecked across all modes (first-occurrence wins so
  // identical values in multiple modes don't double-toggle).
  for (const mode of modes) {
    for (const opt of mode.options) {
      if (opt.initiallyChecked) checked.add(opt.value);
    }
  }
  let cursor = 0;
  let filter = '';
  let linesWritten = 0;

  function visibleOptions(): MultiSelectMode<T>['options'] {
    const all = modes[modeIdx]!.options;
    if (!filter) return all;
    const needle = filter.toLowerCase();
    return all.filter((o) => {
      const hay = `${o.label} ${o.tag ?? ''} ${o.desc ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  const draw = (firstTime: boolean) => {
    if (!firstTime) {
      moveCursor(stdout, 0, -linesWritten);
      clearScreenDown(stdout);
    }
    const visible = visibleOptions();
    if (cursor >= visible.length) cursor = Math.max(0, visible.length - 1);

    const lines: string[] = [];
    lines.push(`${color.cyan('?')} ${question}`);
    const modeLabel = modes.length > 1
      ? `mode ${color.green('[' + modes[modeIdx]!.label + ']')}`
      : '';
    const checkedCount = checked.size;
    const filterStatus = filter
      ? `${color.cyan('filter:')} "${filter}"`
      : '';
    const meta = [modeLabel, `${color.dim(visible.length + ' shown')}`, color.dim(checkedCount + ' selected'), filterStatus]
      .filter(Boolean).join('  ');
    lines.push(`  ${meta}`);
    lines.push('');

    if (visible.length === 0) {
      lines.push(`  ${color.dim('(no matches)')}`);
    } else {
      // Max ~12 rows at a time so a big registry doesn't blow out the redraw.
      const WINDOW = 12;
      const start = Math.max(0, Math.min(cursor - 5, visible.length - WINDOW));
      const end   = Math.min(visible.length, start + WINDOW);
      const widthLabel = Math.min(
        24,
        Math.max(...visible.slice(start, end).map((o) => o.label.length), 8),
      );
      for (let i = start; i < end; i++) {
        const o = visible[i]!;
        const isCursor = i === cursor;
        const isChecked = checked.has(o.value);
        const cur  = isCursor ? color.green('▸') : ' ';
        const box  = isChecked ? color.green('[✓]') : color.dim('[ ]');
        const name = isCursor ? color.bold(o.label.padEnd(widthLabel)) : o.label.padEnd(widthLabel);
        const tag  = o.tag ? color.dim(o.tag.padEnd(10)) : ' '.repeat(10);
        const desc = o.desc ? color.dim('— ' + o.desc) : '';
        lines.push(`  ${cur} ${box} ${name}  ${tag} ${desc}`);
      }
      if (end < visible.length) {
        lines.push(color.dim(`  … ${visible.length - end} more below`));
      }
    }

    lines.push('');
    const backHint = opts.allowBack ? '   ⌃B/← back' : '';
    const help = filter
      ? color.dim('  type to filter   ⌫ del   ⌃B clear filter   ↑↓ navigate   space toggle   ↵ apply')
      : modes.length > 1
        ? color.dim(`  ↑↓ navigate   space toggle   / search   m/⇥ switch mode   ↵ done${backHint}   ^C cancel`)
        : color.dim(`  ↑↓ navigate   space toggle   / search   ↵ done${backHint}   ^C cancel`);
    lines.push(help);

    const text = lines.join('\n') + '\n';
    stdout.write(text);
    linesWritten = (text.match(/\n/g) ?? []).length;
  };

  return new Promise<MultiSelectResult<T>>((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let filtering = false;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (data: string) => {
      // Filter-mode key handling: any character extends the filter; Backspace
      // deletes the last char. Ctrl-B exits filter mode (clears it). Esc is
      // swallowed (browser fullscreen), Backspace is plain delete only — it
      // doesn't leave filter mode, since browsers sometimes propagate it as
      // history navigation if it leaks past the iframe.
      if (filtering) {
        if (data === KEY_ESC) return;
        if (data === KEY_ENTER) { filtering = false; draw(false); return; }
        if (data === KEY_CTRLC) { cleanup(); reject(new PromptCancelled()); return; }
        if (data === KEY_CTRLB) { filtering = false; filter = ''; cursor = 0; draw(false); return; }
        if (data === '\x7f' || data === '\b') {
          filter = filter.slice(0, -1);
          cursor = 0;
          draw(false);
          return;
        }
        // Arrow keys still navigate while filtering.
        if (data === KEY_UP)   { const v = visibleOptions(); if (v.length) cursor = (cursor - 1 + v.length) % v.length; draw(false); return; }
        if (data === KEY_DOWN) { const v = visibleOptions(); if (v.length) cursor = (cursor + 1) % v.length; draw(false); return; }
        // Space toggles while filtering too.
        if (data === ' ') {
          const v = visibleOptions();
          const o = v[cursor];
          if (o) { checked.has(o.value) ? checked.delete(o.value) : checked.add(o.value); }
          draw(false);
          return;
        }
        // Printable char → extend filter.
        if (data.length === 1 && data >= ' ' && data <= '~') {
          filter += data;
          cursor = 0;
          draw(false);
          return;
        }
        return;
      }

      // Normal-mode keys.
      if (data === KEY_CTRLC) { cleanup(); reject(new PromptCancelled()); return; }
      // Esc + Backspace are silently swallowed — browser collisions (Esc =
      // exit fullscreen, Backspace = history back). Back = Ctrl-B or ←.
      if (data === KEY_ESC) return;
      if (data === '\x7f' || data === '\b') return;
      if (data === KEY_CTRLB || data === KEY_LEFT) {
        if (opts.allowBack) { cleanup(); resolve(BACK); return; }
        return;
      }
      if (data === KEY_ENTER) {
        cleanup();
        resolve({ modeIdx, selected: Array.from(checked) });
        return;
      }
      if (data === KEY_UP   || data === 'k') { const v = visibleOptions(); if (v.length) cursor = (cursor - 1 + v.length) % v.length; draw(false); return; }
      if (data === KEY_DOWN || data === 'j') { const v = visibleOptions(); if (v.length) cursor = (cursor + 1) % v.length; draw(false); return; }
      if (data === ' ') {
        const v = visibleOptions();
        const o = v[cursor];
        if (o) { checked.has(o.value) ? checked.delete(o.value) : checked.add(o.value); }
        draw(false);
        return;
      }
      if (data === '/') { filtering = true; filter = ''; cursor = 0; draw(false); return; }
      if ((data === 'm' || data === '\t') && modes.length > 1) {
        modeIdx = (modeIdx + 1) % modes.length;
        cursor = 0;
        draw(false);
        return;
      }
      // 'a' toggles all visible (handy on a filtered list).
      if (data === 'a') {
        const v = visibleOptions();
        const anyUnchecked = v.some((o) => !checked.has(o.value));
        for (const o of v) {
          if (anyUnchecked) checked.add(o.value);
          else              checked.delete(o.value);
        }
        draw(false);
        return;
      }
    };
    stdin.on('data', onData);
    draw(true);
  });
}
