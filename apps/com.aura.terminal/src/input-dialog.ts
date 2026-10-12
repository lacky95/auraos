/**
 * The "review before inserting" dialog — one per session.
 *
 * `type_text` from the MCP no longer types straight into the shell: it opens
 * this dialog in the terminal window, where the human (or the agent, through
 * the dialog MCP tools) can edit the text and then Insert it into the shell
 * or Copy it. The server holds the authoritative state; the browser renders
 * it and reports edits and button clicks back over the pty WebSocket.
 *
 * The store lives on globalThis for the same reason as the pty-server's
 * session map: the WS server and the API routes load this file as different
 * module instances, and they must see one dialog per session. The pty-server
 * registers the push/write hooks (see `installDialogHooks`) so this module
 * never imports it — no cycle, and a dialog can be opened for a session no
 * window is rendering yet (it shows as soon as one attaches).
 */
import { pasteText, sendLiteral, tmuxBin } from './tmux-control.ts';

export type DialogStatus = 'open' | 'inserted' | 'copied' | 'closed';
export type DialogAction = 'insert' | 'copy' | 'close';

export interface InputDialog {
  /** Changes every time a new dialog is opened on the session. */
  id: string;
  sessionId: string;
  text: string;
  status: DialogStatus;
  /** Insert as a bracketed paste (multi-line safe) instead of keystrokes. */
  paste: boolean;
  /** Who made the last change to `text` or `status`. */
  by: 'agent' | 'user';
  /** Bumped on every change, so the browser can tell fresh state from an echo. */
  rev: number;
  updatedAt: number;
}

interface Hooks {
  /** Send a control message to every live window of the session. */
  push(sessionId: string, msg: Record<string, unknown>): void;
  /** Raw PTY write — the insert fallback when tmux is off. */
  write(sessionId: string, text: string): boolean;
}

const STORE_KEY = '__aura_input_dialogs__';
const HOOKS_KEY = '__aura_input_dialog_hooks__';
const g = globalThis as Record<string, unknown>;
const dialogs: Map<string, InputDialog> =
  (g[STORE_KEY] as Map<string, InputDialog> | undefined) ?? (g[STORE_KEY] = new Map<string, InputDialog>()) as Map<string, InputDialog>;

export function installDialogHooks(hooks: Hooks): void {
  g[HOOKS_KEY] = hooks;
}

function hooks(): Hooks | null {
  return (g[HOOKS_KEY] as Hooks | undefined) ?? null;
}

function publish(d: InputDialog): InputDialog {
  hooks()?.push(d.sessionId, { type: 'dialog', dialog: d });
  return d;
}

export class DialogError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DialogError';
    this.status = status;
    this.code = code;
  }
}

function requireOpen(sessionId: string): InputDialog {
  const d = dialogs.get(sessionId);
  if (!d || d.status !== 'open') throw new DialogError(404, 'no-dialog', `no open dialog on ${sessionId}`);
  return d;
}

function touch(d: InputDialog, by: InputDialog['by']): void {
  d.by = by;
  d.rev += 1;
  d.updatedAt = Date.now();
}

/** The session's dialog — the open one, or the last one with its final status. */
export function getDialog(sessionId: string): InputDialog | null {
  return dialogs.get(sessionId) ?? null;
}

/** Open (or replace) the session's dialog with `text`. */
export function openDialog(sessionId: string, text: string, paste: boolean): InputDialog {
  const prev = dialogs.get(sessionId);
  const d: InputDialog = {
    id: `dlg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId, text, paste, status: 'open', by: 'agent',
    rev: (prev?.rev ?? 0) + 1, updatedAt: Date.now(),
  };
  dialogs.set(sessionId, d);
  return publish(d);
}

/** Replace the text of the open dialog. */
export function setDialogText(sessionId: string, text: string, by: InputDialog['by']): InputDialog {
  const d = requireOpen(sessionId);
  d.text = text;
  touch(d, by);
  return publish(d);
}

/**
 * Insert / copy / close the open dialog.
 *
 * Copy needs the clipboard, which only the browser has — and browsers only
 * grant it inside a user gesture. A user click copies in the page and then
 * reports here (status → copied). An agent's copy asks the window to try
 * (`dialog-copy`); the dialog stays open, and `copyRequested` says so.
 */
export async function dialogAction(
  sessionId: string, action: DialogAction, by: InputDialog['by'],
): Promise<InputDialog & { copyRequested?: boolean }> {
  const d = requireOpen(sessionId);
  if (action === 'insert') {
    if (tmuxBin) {
      if (d.paste) await pasteText(sessionId, d.text);
      else await sendLiteral(sessionId, d.text);
    } else if (!hooks()?.write(sessionId, d.text)) {
      throw new DialogError(409, 'not-live', `${sessionId} has no live shell to insert into`);
    }
    d.status = 'inserted';
  } else if (action === 'copy') {
    if (by === 'agent') {
      hooks()?.push(sessionId, { type: 'dialog-copy', id: d.id });
      return { ...d, copyRequested: true };
    }
    d.status = 'copied';
  } else {
    d.status = 'closed';
  }
  touch(d, by);
  return publish(d);
}
