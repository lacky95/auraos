/**
 * Session operations on THIS instance — the local half of the terminal MCP.
 *
 * Everything here acts on the shells in this container: the pty-server's
 * registry for what it knows (which window is rendering what), tmux for the
 * shells themselves (screen, cursor, input). The HTTP routes under
 * `src/pages/api/sessions/` are thin wrappers over these functions, and the
 * MCP calls them directly when the session is local and over those routes
 * when it lives in another instance (see session-router.ts).
 */
import {
  killSession, listSessionsAsync, nextSessionId, reserveSessionName, reservedSessionNames, sessionInUse,
} from './pty-server.ts';
import type { SessionInfo } from './pty-server.ts';
import {
  TmuxError, captureScrollback, inspectPanes, liveTmuxSessionsAsync, mapKey, newSession,
  padScreen, paneState, pasteText, requireTmux, respawnIfDead, sendKeys, sendLiteral, snapshot, tmux, tmuxName,
} from './tmux-control.ts';
import { isReadyState, settleKey, summarizeScreen } from './screen-summary.ts';
import type { PaneState } from './tmux-control.ts';
import { dialogAction, getDialog, openDialog, setDialogText } from './input-dialog.ts';
import type { InputDialog } from './input-dialog.ts';

export interface SessionView {
  /** Full id, `<instanceId>#a<n>`. */
  id: string;
  /** Short form the picker shows, `#a<n>`. */
  label: string;
  /** This process has a PTY on it right now. */
  live: boolean;
  /** A browser window is rendering it — a human sees every keystroke. */
  inUse: boolean;
  /** Bytes of saved scrollback. */
  bytes: number;
  // The tmux view; null when tmux is off or the pane could not be inspected.
  cols: number | null;
  rows: number | null;
  alternate: boolean | null;
  command: string | null;
  title: string | null;
  attached: number | null;
}

export interface ScreenView {
  id: string;
  /** `alternate` ⇒ a full-screen program owns the grid (vim, htop, less …). */
  mode: 'normal' | 'alternate';
  cols: number;
  rows: number;
  /** 0-based, within `screen`. */
  cursor: { x: number; y: number };
  command: string;
  title: string;
  historySize: number;
  inUse: boolean;
  /** The grid stopped changing for `settleMs` before we returned it (spinners and timers ignored). */
  settled: boolean;
  /** The shell in the pane has exited (pane kept by tmux `remain-on-exit`). */
  dead?: boolean;
  deadStatus?: number | null;
  /** The pane was dead on this read and a fresh shell has been started in it
   *  (same session id); `screen` still shows the moment it exited. */
  respawned?: boolean;
  /** How long the read (incl. settling) took. */
  elapsedMs?: number;
  /** `rows` strings of exactly `cols` characters, top to bottom. */
  screen: string[];
  /** Up to `scrollback` lines from above the grid, oldest first. */
  scrollback: string[];
}

export interface ScreenOptions {
  scrollback?: number;
  settleMs?: number;
  timeoutMs?: number;
}

export interface InputBody {
  text?: string;
  keys?: string[];
  /** Deliver `text` as a bracketed paste instead of keystrokes. */
  paste?: boolean;
}

export interface InputResult {
  id: string;
  sent: { chars: number; keys: string[] };
}

export class SessionError extends Error {
  readonly status: number;
  readonly code: string;
  /** What the agent should do next — shown in the MCP's structured error. */
  readonly hint: string | undefined;
  /** For transient failures (an instance restarting): when a retry makes sense. */
  readonly retryAfterMs: number | undefined;
  constructor(status: number, code: string, message: string, hint?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.retryAfterMs = retryAfterMs;
  }
}

export const LIMITS = {
  scrollback: 5_000,
  settleMs:   5_000,
  timeoutMs:  30_000,
  keyRepeats: 200,
  keyRepeatDelayMs: 10_000,
  cols: { min: 20, max: 400 },
  rows: { min: 5,  max: 200 },
} as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function localInstanceId(): string {
  return process.env['APP_INSTANCE_ID'] ?? 'com.aura.terminal';
}

/** A session exists when tmux has its shell. (In-memory-only sessions exist
 *  solely when tmux is off, and then nothing below can read them anyway.) */
async function ensureExists(id: string): Promise<void> {
  if (!(await liveTmuxSessionsAsync()).has(tmuxName(id))) {
    throw new SessionError(404, 'no-such-session', `No session "${id}" on ${localInstanceId()}.`,
      'Its shell has exited or the id is stale. Call list_sessions (or omit target to use the default session). '
      + 'Do NOT open a new session or instance unless the user asked for one.');
  }
}

function view(info: SessionInfo, pane: PaneState | undefined): SessionView {
  return {
    ...info,
    cols:      pane?.cols ?? null,
    rows:      pane?.rows ?? null,
    alternate: pane?.alternate ?? null,
    command:   pane?.command ?? null,
    title:     pane?.title ?? null,
    attached:  pane?.attachedClients ?? null,
  };
}

/** One async tmux call (list-panes) answers both "which shells exist" and
 *  what each pane shows; no blocking spawn or stat on the request path. */
export async function listLocal(): Promise<{ instanceId: string; sessions: SessionView[]; reserved: string[] }> {
  const panes = await inspectPanes();
  const infos = await listSessionsAsync(new Set(panes.keys()));
  return {
    instanceId: localInstanceId(),
    sessions: infos.map((s) => view(s, panes.get(tmuxName(s.id)))),
    reserved: reservedSessionNames(),
  };
}

/**
 * Create a shell with no window on it. It shows up in every window's session
 * picker at once, and attaching there lands in this same shell — `spawnPty`
 * uses attach-or-create against the same name.
 */
export async function openLocal(opts: { cols?: number; rows?: number } = {}): Promise<SessionView> {
  requireTmux();
  const cols = clamp(opts.cols ?? 80, LIMITS.cols.min, LIMITS.cols.max);
  const rows = clamp(opts.rows ?? 24, LIMITS.rows.min, LIMITS.rows.max);

  // `nextSessionId` numbers above every name with a scrollback file; a shell
  // that is alive in tmux but lost its file (deleted by hand, say) is not in
  // that set, so step past any live name too rather than fail on a duplicate.
  const alive = await liveTmuxSessionsAsync();
  let id = nextSessionId(localInstanceId());
  const m = /^(.*#a)(\d+)$/.exec(id);
  for (let n = m ? Number(m[2]) : 0; m && alive.has(tmuxName(id)); id = `${m[1]}${++n}`) { /* step */ }

  reserveSessionName(id);
  await newSession(id, cols, rows);
  const info = (await listSessionsAsync(await liveTmuxSessionsAsync())).find((s) => s.id === id)
    ?? { id, label: `#${id.split('#').slice(1).join('#')}`, live: false, inUse: false, bytes: 0 };
  return view(info, await paneState(id));
}

export function killLocal(id: string): { id: string; killed: boolean } {
  return { id, killed: killSession(id) };
}

/**
 * The screen as an agent should read it. With `settleMs > 0` the grid is
 * re-read until it has stopped changing for that long — a command's output
 * arrives over several frames, and reading after the first one is the classic
 * way an agent acts on half a screen. Past `timeoutMs` the latest frame is
 * returned with `settled: false` rather than an error: a progress spinner
 * never settles, and the frame is still what the agent asked for.
 */
export async function screenLocal(id: string, opts: ScreenOptions = {}): Promise<ScreenView> {
  requireTmux();
  await ensureExists(id);
  const settleMs  = clamp(opts.settleMs ?? 200, 0, LIMITS.settleMs);
  const timeoutMs = clamp(opts.timeoutMs ?? 3_000, 100, LIMITS.timeoutMs);
  const wanted    = clamp(opts.scrollback ?? 0, 0, LIMITS.scrollback);

  // One tmux call per poll; the settle key ignores spinner glyphs and
  // elapsed-time / token counters, so a TUI that is only animating settles.
  const snap = async () => {
    const { state, lines } = await snapshot(id);
    return { state, lines, key: `${state.cursorX},${state.cursorY},${state.alternate},${state.dead}\n${settleKey(lines)}` };
  };
  const ready = (c: Awaited<ReturnType<typeof snap>>) => isReadyState(summarizeScreen({
    command: c.state.command, title: c.state.title, mode: c.state.alternate ? 'alternate' : 'normal',
    screen: c.lines, cursor: { x: c.state.cursorX, y: c.state.cursorY }, dead: c.state.dead,
  }));

  const started = Date.now();
  let cur = await snap();
  let stableSince = Date.now();
  let changed = false;
  let settled = settleMs === 0;
  while (!settled && Date.now() - started < timeoutMs) {
    await sleep(Math.min(settleMs, 50));
    const next = await snap();
    if (next.key === cur.key) {
      const stableFor = Date.now() - stableSince;
      // Early out: after a change, a screen waiting for the user (empty shell
      // prompt, menu, input box) only needs a short quiet period.
      if (stableFor >= settleMs || (changed && stableFor >= Math.min(settleMs, 100) && ready(cur))) settled = true;
    } else {
      cur = next;
      changed = true;
      stableSince = Date.now();
    }
  }

  const { state } = cur;
  // An exited shell is reported as such (state `exited`), then restarted in
  // place: the session stays, it never turns into `no-such-session`.
  const respawned = state.dead ? (await respawnIfDead(id)).respawned : false;
  return {
    id,
    mode: state.alternate ? 'alternate' : 'normal',
    cols: state.cols,
    rows: state.rows,
    cursor: { x: state.cursorX, y: state.cursorY },
    command: state.command,
    title: state.title,
    historySize: state.historySize,
    inUse: sessionInUse(id),
    settled,
    dead: state.dead,
    deadStatus: state.deadStatus,
    ...(respawned ? { respawned } : {}),
    elapsedMs: Date.now() - started,
    screen: padScreen(cur.lines, state.cols, state.rows),
    scrollback: await captureScrollback(id, wanted, state.historySize),
  };
}

/** The visible grid WITH its SGR escape sequences (`capture-pane -e`), for
 *  get_screen's dim marking and select_menu_option's reverse-video menus (TM-16/17). */
export async function styledLocal(id: string): Promise<string[]> {
  requireTmux();
  await ensureExists(id);
  const out = await tmux(['capture-pane', '-p', '-e', '-N', '-t', tmuxName(id)]);
  return out.replace(/\n$/, '').split('\n');
}

/** Text first, then keys, so `{ text: "ls", keys: ["Enter"] }` is one round trip.
 *  Every key is mapped before anything is sent: a bad name fails whole. */
export async function inputLocal(id: string, body: InputBody): Promise<InputResult> {
  requireTmux();
  await ensureExists(id);
  const keys = (body.keys ?? []).map(mapKey);
  // Keystrokes meant for the program that exited must not land in the fresh
  // shell: restart it, send nothing, and say so.
  const dead = await respawnIfDead(id);
  if (dead.respawned) {
    throw new SessionError(409, 'shell-exited',
      `The shell in "${id}" had exited (status ${dead.deadStatus ?? '?'}); nothing was sent.`,
      'A fresh shell was started in the same session. Read the screen, then send again if it still makes sense. '
      + 'Do NOT open a new session.');
  }
  if (body.text) {
    if (body.paste) await pasteText(id, body.text);
    else await sendLiteral(id, body.text);
  }
  await sendKeys(id, keys);
  return { id, sent: { chars: body.text?.length ?? 0, keys } };
}

// ── Review-before-insert dialog ─────────────────────────────────────────────

export interface DialogOpBody {
  op: 'open' | 'set' | 'insert' | 'copy' | 'close';
  text?: string;
  paste?: boolean;
}

export interface DialogView {
  session: string;
  /** null when no dialog was ever opened on the session. */
  dialog: (InputDialog & { copyRequested?: boolean }) | null;
  /** A window is rendering the session, so a human can see the dialog. */
  inUse: boolean;
}

function dialogView(id: string, dialog: DialogView['dialog']): DialogView {
  return { session: id, dialog, inUse: sessionInUse(id) };
}

export async function dialogGetLocal(id: string): Promise<DialogView> {
  await ensureExists(id);
  return dialogView(id, getDialog(id));
}

export async function dialogOpLocal(id: string, body: DialogOpBody): Promise<DialogView> {
  await ensureExists(id);
  if (body.op === 'open') {
    if (!body.text) throw new SessionError(400, 'bad-request', 'text required');
    return dialogView(id, openDialog(id, body.text, body.paste ?? false));
  }
  if (body.op === 'set') {
    if (body.text === undefined) throw new SessionError(400, 'bad-request', 'text required');
    return dialogView(id, setDialogText(id, body.text, 'agent'));
  }
  return dialogView(id, await dialogAction(id, body.op, 'agent'));
}

// ── Errors on the wire ──────────────────────────────────────────────────────

const TMUX_STATUS: Record<TmuxError['code'], number> = {
  'tmux-disabled': 501, 'no-such-session': 404, 'bad-key': 400, 'tmux-failed': 500,
};

/** `{ error, message }` with the status the error carries — one shape for every route. */
export function errorResponse(err: unknown): Response {
  if (err instanceof SessionError) {
    return Response.json({ error: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }, { status: err.status });
  }
  if (err instanceof TmuxError)    return Response.json({ error: err.code, message: err.message }, { status: TMUX_STATUS[err.code] });
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: 'internal', message }, { status: 500 });
}

/** Read an optional integer query/body value; `undefined` when absent or not a number. */
export function intOr(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
