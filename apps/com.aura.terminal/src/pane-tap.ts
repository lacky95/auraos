/**
 * Pane tap — the shell's RAW output, straight from the tmux pane.
 *
 * The browser used to draw whatever the attached tmux client wrote to its PTY.
 * That is tmux's RENDERING of the pane, not the program's output, and tmux
 * renders lossily under load: when more output is pending to a client than
 * `8 × cols × rows` bytes, it throws the backlog away and repaints just the
 * visible screen (tty_block_maybe in tmux's tty.c). Every line that scrolled
 * past in between never reaches xterm's scrollback. The threshold scales with
 * the screen, so a SHORT terminal loses output first — an 8-row window dropped
 * 360 of 400 lines of a plain `echo` loop, and a `--help` page came out with
 * its top half missing and a line repeated.
 *
 * `pipe-pane -O` copies every byte the pane's program writes, before any
 * rendering, so xterm.js gets exactly what it would get without tmux in the
 * middle — however small the window is. The tmux client stays attached for
 * what only it can do (input, the PTY size, keeping the session attached);
 * its rendered output is just drained.
 *
 * Transport is a FIFO opened O_RDWR: holding our own write end means the read
 * side never sees EOF while tmux's `cat` restarts, and libuv can poll it like
 * any pipe (a plain read stream on a FIFO would park a threadpool thread per
 * session).
 */
import { constants, mkdirSync, openSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TMUX_CONF, TMUX_SOCKET, shellArgv, tmuxBin, tmuxName } from './tmux-control.ts';

const TAP_DIR = join(tmpdir(), `aura-term-tap-${process.getuid?.() ?? 0}`);

export interface PaneTap {
  /** Stop the pipe, close the FIFO, remove it. Idempotent. */
  close(): void;
}

function tmuxSync(args: string[]): { ok: boolean; out: string } {
  if (!tmuxBin) return { ok: false, out: '' };
  const r = spawnSync(tmuxBin, ['-L', TMUX_SOCKET, '-f', TMUX_CONF, '-u', ...args], { encoding: 'utf-8' });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

export function tmuxHasSession(sessionId: string): boolean {
  return tmuxSync(['has-session', '-t', `=${tmuxName(sessionId)}`]).ok;
}

/**
 * Start tapping `sessionId`'s pane. When `create` is given and the session
 * does not exist yet, it is created detached in the SAME tmux command as the
 * pipe — so the shell's first prompt is already flowing into the tap.
 * Returns null when tmux is unavailable or the pipe could not be set up; the
 * caller then keeps showing the client's rendered output, as before.
 */
export function openPaneTap(
  sessionId: string,
  onData: (text: string) => void,
  create?: { cols: number; rows: number; shell: string; cwd: string; env: Record<string, string> },
): PaneTap | null {
  if (!tmuxBin) return null;
  const name = tmuxName(sessionId);
  const fifo = join(TAP_DIR, `${name}.fifo`);
  let sock: Socket;
  try {
    mkdirSync(TAP_DIR, { recursive: true, mode: 0o700 });
    rmSync(fifo, { force: true });
    if (spawnSync('mkfifo', ['-m', '600', fifo]).status !== 0) return null;
    const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    sock = new Socket({ fd, readable: true, writable: false });
  } catch {
    return null;
  }
  sock.setEncoding('utf8');                     // multi-byte chars split across reads stay whole
  sock.on('data', (d: string) => onData(d));
  sock.on('error', () => { /* closed under us — close() cleans up */ });

  // No `-o`: an existing pipe (left by a previous pty-server) is replaced,
  // which closes it and lets its `cat` exit.
  const pipe = ['pipe-pane', '-O', '-t', `=${name}:`, `exec cat > '${fifo}'`];
  const args = create && !tmuxHasSession(sessionId)
    ? ['new-session', '-d', '-s', name,
       '-x', String(create.cols), '-y', String(create.rows),
       '-c', create.cwd, '-e', `AURA_TERM_LABEL=${create.env['AURA_TERM_LABEL'] ?? ''}`,
       ...shellArgv(create.shell), ';', ...pipe]
    : pipe;
  const r = spawnSync(tmuxBin, ['-L', TMUX_SOCKET, '-f', TMUX_CONF, '-u', ...args],
    { encoding: 'utf-8', env: create?.env ?? process.env });
  if (r.status !== 0) {
    sock.destroy();
    rmSync(fifo, { force: true });
    return null;
  }

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      tmuxSync(['pipe-pane', '-t', `=${name}:`]);   // no command ⇒ stop piping
      sock.destroy();
      try { rmSync(fifo, { force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * Repaint of a pane we did not see being drawn — a session created before
 * this process tapped it (the MCP's `open_session`, or a pty-server restart).
 * The tap only carries output from now on, so the viewer gets the current
 * screen (with colours) and cursor once, then the live stream continues.
 * `withHistory` also prepends the pane's scrollback, for a viewer that has
 * no saved replay of its own.
 */
export function paneRepaint(sessionId: string, withHistory: boolean): string {
  const t = `=${tmuxName(sessionId)}:`;
  const st = tmuxSync(['display-message', '-p', '-t', t, '#{cursor_x}\t#{cursor_y}\t#{alternate_on}\t#{history_size}']);
  if (!st.ok) return '';
  const [cx, cy, alt, hist] = st.out.trim().split('\t').map(Number);
  // No screen clear: printing the grid row by row scrolls whatever the viewer
  // already shows up into its scrollback, and capture-pane emits every row
  // (blank ones too), so the last row lands on the bottom line.
  let out = '\x1b[0m\r\n';
  if (withHistory && !alt && hist! > 0) {
    const h = tmuxSync(['capture-pane', '-p', '-e', '-J', '-t', t, '-S', `-${Math.min(hist!, 5000)}`, '-E', '-1']);
    if (h.ok && h.out) out += h.out.replace(/\n$/, '').split('\n').join('\r\n') + '\r\n';
  }
  const screen = tmuxSync(['capture-pane', '-p', '-e', '-t', t]);
  if (!screen.ok) return '';
  if (alt) out += '\x1b[?1049h\x1b[H';
  out += screen.out.replace(/\n$/, '').split('\n').join('\r\n');
  out += `\x1b[0m\x1b[${(cy ?? 0) + 1};${(cx ?? 0) + 1}H`;
  return out;
}
