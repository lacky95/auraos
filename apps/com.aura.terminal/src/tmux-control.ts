/**
 * tmux control — everything this app says to tmux, in one place.
 *
 * The shell behind every terminal session lives in a tmux server on a private
 * socket (see the "tmux backing" comment in pty-server.ts, and tmux.conf).
 * pty-server.ts only ever ATTACHES a PTY to it. This module is the other half:
 * creating a session with no PTY at all, reading a pane back as text, and
 * typing into it — what the terminal MCP (src/mcp/terminal.ts) is built on.
 *
 * tmux is a complete terminal emulator, so the rendered grid, the cursor and
 * the alternate-screen flag come straight out of `capture-pane` and
 * `display-message`; nothing here parses escape sequences. Keystrokes go in
 * through `send-keys`, into the same pane the browser is attached to, so a
 * human watching the window sees the agent type — and a session nobody has a
 * window on is just as readable, which a mirror fed from the PTY could never
 * offer.
 *
 * Node builtins only: the tests import this file directly under
 * `--experimental-strip-types`, where a bare package import would not resolve.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The host this terminal physically lives on — the AuraOS master ("aura-shell"
// by default, overridable via AURA_SHELL_HOSTNAME, which ContainerRunner
// forwards into every app container). We DON'T use os.hostname()/$HOSTNAME
// because the container is started with `--hostname <appId>`, so the kernel
// name is the package id ("com.aura.terminal") — not the host the user means.
export const HOST_LABEL = process.env['AURA_SHELL_HOSTNAME'] ?? 'aura-shell';

/** Private -L namespace, never collides with a user's own tmux. Overridable so
 *  tests can run against a throwaway server instead of the real one. */
export const TMUX_SOCKET = process.env['AURA_TERM_TMUX_SOCKET'] ?? 'aura';
export const TMUX_CONF   = join(dirname(fileURLToPath(import.meta.url)), '..', 'tmux.conf');

export const tmuxBin: string | null = (() => {
  if (process.env['AURA_TERM_TMUX'] === '0') return null;
  const bin = process.env['AURA_TERM_TMUX_BIN'] ?? 'tmux';
  try {
    const probe = spawnSync(bin, ['-V'], { stdio: 'ignore' });
    if (probe.status === 0) return bin;
  } catch { /* not installed / not executable */ }
  return null;
})();

/**
 * tmux session name for one of our session ids. Session ids look like
 * `com.aura.terminal-16#a12`, and tmux forbids `.` and `:` in names (it parses
 * them as window/pane addressing), so everything outside a safe set is folded
 * to `_`. The mapping only has to be stable and collision-free within one
 * container, which it is — the id is already unique there.
 */
export function tmuxName(sessionId: string): string {
  return `aura-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Names of the tmux sessions on our private socket; empty when tmux is absent. */
export function liveTmuxSessions(): Set<string> {
  if (!tmuxBin) return new Set();
  try {
    const r = spawnSync(tmuxBin, ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf-8' });
    if (r.status !== 0 || !r.stdout) return new Set();   // no server running ⇒ no sessions
    return new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch { return new Set(); }
}

/** `liveTmuxSessions()` without blocking the event loop — for request paths. */
export async function liveTmuxSessionsAsync(): Promise<Set<string>> {
  if (!tmuxBin) return new Set();
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}']);
    return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch { return new Set(); }  // no server running ⇒ no sessions
}

/** Kill the backing tmux session. Returns true if one actually existed. */
export function tmuxKill(sessionId: string): boolean {
  if (!tmuxBin) return false;
  try {
    const r = spawnSync(tmuxBin, ['-L', TMUX_SOCKET, 'kill-session', '-t', tmuxName(sessionId)], { stdio: 'ignore' });
    return r.status === 0;
  } catch { /* no server / no such session — nothing to clean up */ }
  return false;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type TmuxErrorCode =
  /** tmux is off (AURA_TERM_TMUX=0) or not in the image: nothing below can work. */
  | 'tmux-disabled'
  /** The target session is not on our socket. */
  | 'no-such-session'
  /** tmux ran and refused; message carries its stderr. */
  | 'tmux-failed'
  /** A key name `mapKey` could not translate. */
  | 'bad-key';

export class TmuxError extends Error {
  readonly code: TmuxErrorCode;
  // No parameter properties: the tests load this file with node's strip-only
  // TypeScript mode, which rejects that syntax.
  constructor(code: TmuxErrorCode, message: string) {
    super(message);
    this.name = 'TmuxError';
    this.code = code;
  }
}

export function requireTmux(): string {
  if (tmuxBin) return tmuxBin;
  throw new TmuxError('tmux-disabled',
    'tmux is disabled (AURA_TERM_TMUX=0) or not installed on this instance; ' +
    'screen reading and input are unavailable here.');
}

/**
 * Run one tmux command on our socket and return its stdout.
 *
 * "can't find pane/session" and "no server running" become `no-such-session`
 * — but note that `display-message -p` answers happily for a target that does
 * not exist, so callers that need certainty check `liveTmuxSessions()` first.
 */
export function tmux(
  args: string[],
  opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const bin = requireTmux();
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin, ['-L', TMUX_SOCKET, ...args],
      { encoding: 'utf-8', timeout: opts.timeoutMs ?? 5_000, maxBuffer: 16 * 1024 * 1024, env: opts.env },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const msg = (stderr || err.message).trim();
        // "error connecting to <socket> (No such file or directory)" is how a
        // socket with no server behind it fails — same meaning as "no server running".
        if (/can't find (pane|session|window)|no server running|error connecting to|session not found/i.test(msg)) {
          return reject(new TmuxError('no-such-session', msg));
        }
        reject(new TmuxError('tmux-failed', `tmux ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${msg}`));
      },
    );
    // Always end stdin: with nothing to read tmux would otherwise wait on it
    // for `load-buffer -`, and a closed empty stdin is harmless for the rest.
    // tmux can exit before reading it (a dead session fails at once), and the
    // write then raises EPIPE on stdin. Unhandled, that crashes the whole
    // instance; the exit callback above already reports the real failure.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
}

// ── Pane state ──────────────────────────────────────────────────────────────

export interface PaneState {
  cols: number;
  rows: number;
  /** 0-based, within the visible grid. */
  cursorX: number;
  cursorY: number;
  /** A full-screen program (vim, htop, less …) owns the screen. */
  alternate: boolean;
  /** Foreground process, e.g. `bash`, `vim`, `node`. */
  command: string;
  /** The OSC window title the shell last set. */
  title: string;
  /** Lines of scrollback tmux holds above the visible grid. */
  historySize: number;
  /** tmux clients attached (the pty-server's PTY counts as one). */
  attachedClients: number;
  /** The pane's process has exited (only possible with `remain-on-exit`). */
  dead: boolean;
  /** Exit status of a dead pane; null while alive or unknown. */
  deadStatus: number | null;
}

/** Tab-separated so a title with spaces survives; a title with a TAB does not,
 *  which is a trade nobody will notice. */
const PANE_FORMAT = [
  '#{pane_width}', '#{pane_height}', '#{cursor_x}', '#{cursor_y}', '#{alternate_on}',
  '#{pane_current_command}', '#{pane_title}', '#{history_size}', '#{session_attached}',
  '#{pane_dead}', '#{pane_dead_status}',
].join('\t');

/** Parse one `PANE_FORMAT` line. Exported for the tests. */
export function parsePaneState(line: string): PaneState {
  const f = line.replace(/\r?\n$/, '').split('\t');
  const num = (i: number) => { const n = Number(f[i]); return Number.isFinite(n) ? n : 0; };
  return {
    cols: num(0), rows: num(1), cursorX: num(2), cursorY: num(3),
    alternate: f[4] === '1',
    command: f[5] ?? '', title: f[6] ?? '',
    historySize: num(7), attachedClients: num(8),
    dead: f[9] === '1',
    deadStatus: f[10] !== undefined && f[10] !== '' && Number.isFinite(Number(f[10])) ? Number(f[10]) : null,
  };
}

export async function paneState(sessionId: string): Promise<PaneState> {
  return parsePaneState(await tmux(['display-message', '-p', '-t', tmuxName(sessionId), PANE_FORMAT]));
}

/** Every pane on our socket in one call, keyed by tmux session name. Empty
 *  when no server is running. */
/**
 * Pane state and the visible grid in ONE tmux invocation (`display-message`
 * `;` `capture-pane`) — the settle loop of get_screen polls this, so halving
 * the process spawns per poll matters.
 */
export async function snapshot(sessionId: string): Promise<{ state: PaneState; lines: string[] }> {
  const t = tmuxName(sessionId);
  const out = await tmux(['display-message', '-p', '-t', t, PANE_FORMAT, ';', 'capture-pane', '-p', '-N', '-t', t]);
  const nl = out.indexOf('\n');
  const state = parsePaneState(nl < 0 ? out : out.slice(0, nl));
  const lines = nl < 0 ? [] : out.slice(nl + 1).replace(/\n$/, '').split('\n');
  return { state, lines };
}

export async function inspectPanes(): Promise<Map<string, PaneState>> {
  const out = new Map<string, PaneState>();
  if (!tmuxBin) return out;
  let text: string;
  try {
    text = await tmux(['list-panes', '-a', '-F', `#{session_name}\t${PANE_FORMAT}`]);
  } catch (err) {
    if (err instanceof TmuxError && err.code === 'no-such-session') return out;
    throw err;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    out.set(line.slice(0, tab), parsePaneState(line.slice(tab + 1)));
  }
  return out;
}

// ── Shell lifetime ──────────────────────────────────────────────────────────

/**
 * The pane runs the shell under this loop, which tells a deliberate `exit`
 * from a crash:
 *
 * - `exit` / Ctrl+D in the ROOT shell ends the session for real: the loop runs
 *   `tmux kill-session` on its own pane's session (`$TMUX` / `$TMUX_PANE` are
 *   set inside every pane, so it hits the right socket and session) and stops.
 *   The window then moves on to the next session (pty-server sends
 *   `session-ended`). An `exit` inside an `aura jump` hop only ends the hop —
 *   `"$@"` below returns only when the root shell itself is gone.
 * - A shell that died by a signal (status > 128) or lived under ~2 s (broken
 *   rc file) is NOT a deliberate exit: a line says so and a fresh shell starts
 *   in the same pane, same session id (TM-4), at most once a second. 130 is
 *   the exception: an interactive shell ignores SIGINT, so 130 only means the
 *   last command was Ctrl+C'd before the user typed `exit`.
 *   If `tmux kill-session` fails, the loop also falls back to a restart.
 *   `set -m` (job control) makes the loop take the terminal back when a shell
 *   dies without handing it back itself (SIGKILL): otherwise the next shell
 *   starts outside the tty's foreground process group ("no job control in
 *   background"), dies on its first read, and that exit would end the session.
 *
 * The argv is baked into a session when it is created: sessions from before
 * this loop keep restarting until they are recreated.
 *
 * tmux's `pane-died` hook would be the obvious tool, but tmux 3.3a fires it
 * for only some exits (pass 1 measured ~1 in 3; with a client attached it
 * never fired here), so the loop does the job and `remain-on-exit` (tmux.conf)
 * plus `respawnIfDead` cover a pane that dies anyway.
 *
 * No `;` at the end of an argument (tmux would end its command there) and no
 * `#` (format expansion): the loop uses newlines.
 */
const SHELL_LOOP = [
  'set -m',
  'while :',
  'do',
  '  t=$(date +%s)',
  '  "$@"',
  '  s=$?',
  '  if [ $(( $(date +%s) - t )) -ge 2 ] && { [ "$s" -le 128 ] || [ "$s" -eq 130 ]; } && [ -n "$TMUX_PANE" ]',
  '  then tmux kill-session -t "$TMUX_PANE" && exit 0',
  '  fi',
  "  printf '\\r\\n[shell exited (status %s), starting a new shell]\\r\\n' \"$s\"",
  '  if [ $(( $(date +%s) - t )) -lt 2 ]',
  '  then sleep 1',
  '  fi',
  'done',
].join('\n');

/** argv for a pane: the shell under the exit/restart loop (see SHELL_LOOP). */
export function shellArgv(shell: string): string[] {
  return ['/bin/sh', '-c', SHELL_LOOP, 'aura-shell', shell];
}

/**
 * Where a new shell starts: `$HOME`, unless that is unset or inside the app's
 * own tree (the dev server watches it — files a shell writes there would
 * reload it), then `$AURA_TERM_HOME` or `/data/home`. Existing sessions keep
 * their cwd: attach never re-applies it.
 */
export function shellCwd(env: NodeJS.ProcessEnv = process.env, appRoot: string = process.cwd()): string {
  const home = env['HOME'];
  const root = appRoot.replace(/\/+$/, '');
  if (home && home !== root && !home.startsWith(`${root}/`)) return home;
  const alt = env['AURA_TERM_HOME'] ?? '/data/home';
  try { mkdirSync(alt, { recursive: true }); } catch { /* read-only: the shell falls back to / */ }
  return alt;
}

/**
 * If the pane's program has exited (kept by `remain-on-exit`), start its
 * command again in the same pane. Returns whether it did, with the exit status.
 */
export async function respawnIfDead(sessionId: string): Promise<{ respawned: boolean; deadStatus: number | null }> {
  const t = tmuxName(sessionId);
  const st = parsePaneState(await tmux(['display-message', '-p', '-t', t, PANE_FORMAT]));
  if (!st.dead) return { respawned: false, deadStatus: null };
  try {
    await tmux(['respawn-pane', '-t', t]);
  } catch (err) {
    // Someone else (a window's heartbeat, a parallel read) respawned it first.
    if (!(err instanceof TmuxError && /still active/i.test(err.message))) throw err;
  }
  return { respawned: true, deadStatus: st.deadStatus };
}

// ── Sessions, screen, input ─────────────────────────────────────────────────

/**
 * Create a detached session — a shell with no PTY on it yet.
 *
 * Mirrors `spawnPty` in pty-server.ts exactly (same conf, `-u`, shell, cwd
 * and AURA_TERM_LABEL) so that when a window later attaches with
 * `new-session -A` it finds the shell it would have created itself. `-e`
 * sets the label in the SESSION environment, which is what matters when the
 * server is already running and our own env is not consulted.
 */
export async function newSession(sessionId: string, cols: number, rows: number): Promise<void> {
  const shell = process.env['SHELL'] ?? '/bin/bash';
  await tmux([
    '-f', TMUX_CONF, '-u',
    'new-session', '-d', '-s', tmuxName(sessionId),
    '-x', String(cols), '-y', String(rows),
    '-c', shellCwd(),
    '-e', `AURA_TERM_LABEL=${HOST_LABEL}`,
    ...shellArgv(shell),
  ], { env: { ...process.env, AURA_TERM_LABEL: HOST_LABEL } });
}

/**
 * The visible grid, one string per row, top to bottom. `-N` keeps trailing
 * blanks; `padScreen` normalises what is left. Never `-J`: joining wrapped
 * lines would break the row-for-row correspondence with the screen.
 */
export async function captureScreen(sessionId: string): Promise<string[]> {
  const text = await tmux(['capture-pane', '-p', '-N', '-t', tmuxName(sessionId)]);
  return text.replace(/\n$/, '').split('\n');
}

/**
 * The last `lines` lines of scrollback above the grid, wrapped lines joined.
 * `historySize` comes from `paneState`: with an empty history tmux answers
 * `-S -n -E -1` with a visible line instead of nothing, so it is guarded here.
 */
export async function captureScrollback(sessionId: string, lines: number, historySize: number): Promise<string[]> {
  const n = Math.min(lines, historySize);
  if (n <= 0) return [];
  const text = await tmux(['capture-pane', '-p', '-J', '-t', tmuxName(sessionId), '-S', `-${n}`, '-E', '-1']);
  return text.replace(/\n$/, '').split('\n');
}

/** argv entries are capped per string on Linux; chunk well under it. */
const LITERAL_CHUNK = 4096;

/** Type `text` as-is — `-l` means no key-name lookup, `--` guards a leading `-`. */
export async function sendLiteral(sessionId: string, text: string): Promise<void> {
  const target = tmuxName(sessionId);
  for (let i = 0; i < text.length; i += LITERAL_CHUNK) {
    await tmux(['send-keys', '-t', target, '-l', '--', text.slice(i, i + LITERAL_CHUNK)]);
  }
}

/**
 * Paste `text` with bracketed-paste markers, the way a terminal pastes: a
 * readline shell shows a multi-line paste without running each line, and an
 * editor inserts it without auto-indenting every line.
 */
export async function pasteText(sessionId: string, text: string): Promise<void> {
  const buf = `aura-mcp-${process.pid}-${Date.now()}`;
  await tmux(['load-buffer', '-b', buf, '-'], { input: text });
  await tmux(['paste-buffer', '-d', '-p', '-b', buf, '-t', tmuxName(sessionId)]);
}

/** Send already-mapped tmux key names (see `mapKey`), in order. */
export async function sendKeys(sessionId: string, tmuxKeys: string[]): Promise<void> {
  if (tmuxKeys.length === 0) return;
  await tmux(['send-keys', '-t', tmuxName(sessionId), ...tmuxKeys]);
}

// ── Key names ───────────────────────────────────────────────────────────────

/** What `mapKey` accepts, for error messages and tool descriptions. */
export const KEY_HELP =
  'Enter, Tab, Escape, Backspace, Delete, Insert, Space, Up, Down, Left, Right, Home, End, '
  + 'PageUp, PageDown, F1–F12, a single character, and any of those with Ctrl+ / Alt+ / Shift+ '
  + '(e.g. Ctrl+C, Alt+Enter, Shift+Tab). tmux names (C-c, M-x, BTab) pass through.';

const NAMED: Record<string, string> = {
  enter: 'Enter', return: 'Enter', cr: 'Enter',
  tab: 'Tab', btab: 'BTab',
  escape: 'Escape', esc: 'Escape',
  backspace: 'BSpace', bspace: 'BSpace', bs: 'BSpace',
  delete: 'DC', del: 'DC', dc: 'DC',
  insert: 'IC', ins: 'IC', ic: 'IC',
  space: 'Space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'PPage', pgup: 'PPage', ppage: 'PPage',
  pagedown: 'NPage', pgdn: 'NPage', npage: 'NPage',
};

const MODS: Record<string, 'C' | 'M' | 'S'> = {
  ctrl: 'C', control: 'C', c: 'C',
  alt: 'M', meta: 'M', m: 'M', opt: 'M', option: 'M',
  shift: 'S', s: 'S',
};

/** The characters a terminal can actually send with Ctrl held. */
const CTRL_BASE = /^[a-z0-9[\]\\^_@/ -]$/i;

const badKey = (msg: string) => new TmuxError('bad-key', msg);

/**
 * Friendly key name → tmux key name. Strict on purpose: `send-keys` TYPES an
 * unknown name as literal characters, so a typo in a key name would silently
 * become keystrokes. Anything not recognised is rejected with the accepted
 * list instead.
 */
export function mapKey(name: string): string {
  if (name === ' ') return 'Space';
  const raw = name.trim();
  if (!raw) throw badKey('empty key name');
  if ([...raw].length === 1) {
    // tmux reads a lone ";" in argv as a command separator, not a key.
    if (raw === ';') throw badKey('";" cannot be sent as a key — use type_text for it');
    return raw;
  }

  const sep = raw.includes('+') ? '+' : '-';
  const parts = raw.split(sep);
  // A trailing empty part means the base key IS the separator ("Ctrl+-", "Shift--").
  if (parts.length >= 2 && parts[parts.length - 1] === '') { parts.pop(); parts[parts.length - 1] = sep; }
  const base = parts.pop()!;
  const mods = new Set<'C' | 'M' | 'S'>();
  for (const m of parts) {
    const k = MODS[m.toLowerCase()];
    if (!k) throw badKey(`unknown modifier "${m}" in "${name}". Accepted: ${KEY_HELP}`);
    mods.add(k);
  }

  let key: string;
  const lower = base.toLowerCase();
  if ([...base].length === 1) {
    if (mods.has('C') && !CTRL_BASE.test(base)) throw badKey(`Ctrl+${base} is not a key a terminal can send`);
    // Ctrl+- is 0x1F on a real terminal, the key tmux names C-_.
    key = base === ' ' ? 'Space' : mods.has('C') ? (base === '-' ? '_' : lower) : base;
  } else if (NAMED[lower]) {
    key = NAMED[lower];
  } else if (/^f([1-9]|1[0-2])$/.test(lower)) {
    key = `F${lower.slice(1)}`;
  } else {
    throw badKey(`unknown key "${name}". Accepted: ${KEY_HELP}`);
  }
  if (mods.has('S') && key === 'Tab') { mods.delete('S'); key = 'BTab'; }
  if (mods.size === 0) return key;
  return (['C', 'M', 'S'] as const).filter((m) => mods.has(m)).map((m) => `${m}-`).join('') + key;
}

// ── Grid ────────────────────────────────────────────────────────────────────

/**
 * Normalise captured rows to a `rows × cols` grid: every line right-padded
 * with spaces to `cols` (by code point — a double-width glyph over-pads by one
 * cell, which is the lesser evil), missing rows filled in. tmux trims blank
 * lines to nothing, and a TUI is only readable when the columns line up.
 */
export function padScreen(lines: string[], cols: number, rows: number): string[] {
  const out = lines.slice(0, Math.max(rows, 0)).map((l) => {
    const width = [...l].length;
    return width >= cols ? l : l + ' '.repeat(cols - width);
  });
  while (out.length < rows) out.push(' '.repeat(cols));
  return out;
}
