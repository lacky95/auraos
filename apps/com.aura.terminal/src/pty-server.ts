import { WebSocketServer, WebSocket } from 'ws';
import pty, { type IPty } from 'node-pty';
import { parse as parseUrl } from 'node:url';

/**
 * PTY session registry — multicast, survives browser reload.
 *
 * Each session is keyed by the OS activity id (forwarded by the terminal
 * page as `?_aura_session=<id>` on its WS URL). MULTIPLE WebSocket
 * clients can attach to the same session simultaneously — PTY output is
 * broadcast to all of them, and any of them can write input. Two
 * browser tabs / two windows of the same activity end up sharing the
 * same live shell instead of ping-ponging displaces.
 *
 * Lifetime:
 *   • A new WS arriving for a session that has no PTY yet spawns one.
 *   • A WS closing detaches itself; the PTY stays alive.
 *   • When the LAST WS detaches we start a 5-min grace timer; if no
 *     reattach happens, the PTY is killed.
 *   • The OS `onActivityDestroy` lifecycle hook calls `killSession`
 *     which closes all bound WSes and kills the PTY immediately.
 *
 * Scrollback: each new WS gets a one-shot replay of the session's
 * scrollback ring buffer (256 KiB cap) before live output continues —
 * so a browser reload returns to exactly where it left off.
 *
 * Anonymous connections (no `_aura_session`) get the old "kill on
 * close" behavior — keeps direct `/ws` consumers (curl, tests) working.
 */

interface Session {
  id:         string;
  pty:        IPty;
  wss:        Set<WebSocket>;
  buffer:     string[];    // scrollback ring (joined chunks)
  bufferSize: number;      // total bytes in buffer; cap at SCROLLBACK_BYTES
  killTimer:  NodeJS.Timeout | null;
  reconcileTimer: NodeJS.Timeout | null;  // winsize self-heal heartbeat
  // Per-client reported size + primary flag — the shared PTY size is derived
  // from these (smallest-fit, or the primary device when one is set).
  clientSizes: Map<WebSocket, { cols: number; rows: number; primary: boolean }>;
  cols:       number;   // current EFFECTIVE PTY size (result of recomputeEffective)
  rows:       number;
}

const SCROLLBACK_BYTES = 256 * 1024;
const GRACE_MS         = 5 * 60_000;   // 5 minutes after last client leaves
const RECONCILE_MS     = 5_000;        // winsize self-heal heartbeat interval

// The host this terminal physically lives on — the AuraOS master ("aura-shell"
// by default, overridable via AURA_SHELL_HOSTNAME, which ContainerRunner now
// forwards into every app container). We DON'T use os.hostname()/$HOSTNAME here
// because the container is started with `--hostname <appId>`, so the kernel
// name is the package id ("com.aura.terminal") — not the host the user means.
const HOST_LABEL = process.env['AURA_SHELL_HOSTNAME'] ?? 'aura-shell';

// OSC window-title sequence. The Terminal page listens via xterm's
// onTitleChange and shows it as the session-host indicator.
function oscTitle(label: string): string {
  return `]0;${label}`;
}

const sessions = new Map<string, Session>();

function log(...args: unknown[]): void {
  console.log('[pty]', ...args);
}

function bufferPush(sess: Session, chunk: string): void {
  sess.buffer.push(chunk);
  sess.bufferSize += chunk.length;
  while (sess.bufferSize > SCROLLBACK_BYTES && sess.buffer.length > 1) {
    const removed = sess.buffer.shift()!;
    sess.bufferSize -= removed.length;
  }
}

function spawnPty(cols: number, rows: number): IPty {
  const shell = process.env['SHELL'] ?? '/bin/bash';
  return pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env['HOME'] ?? '/app',
    // AURA_TERM_LABEL marks this as the base/host shell so bashrc.aura.sh's
    // window-title shows the host ("aura-shell") rather than this app's id.
    // `aura jump` shells run in a different sandbox where it's absent (or
    // explicitly blanked, see enter-sandbox.ts), so they show the app instead.
    env: { ...process.env, AURA_TERM_LABEL: HOST_LABEL } as Record<string, string>,
  });
}

function broadcastToWss(sess: Session, data: string): void {
  for (const ws of sess.wss) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function attachPtyOutput(sess: Session): void {
  sess.pty.onData((data) => {
    bufferPush(sess, data);
    broadcastToWss(sess, data);
  });
  sess.pty.onExit(() => {
    log('pty exit', sess.id);
    // PTY exited (user typed `exit`, signal, etc.). Drop the session
    // entirely — no point holding scrollback for a dead shell.
    if (sess.reconcileTimer) { clearInterval(sess.reconcileTimer); sess.reconcileTimer = null; }
    for (const ws of sess.wss) { try { ws.close(); } catch { /* ignore */ } }
    sess.wss.clear();
    sessions.delete(sess.id);
  });
}

/**
 * Winsize self-heal heartbeat.
 *
 * `sess.cols/rows` is the AUTHORITATIVE size — the browser terminal computes it
 * from the shell's exact tile box and sends it on every change. But a program
 * running INSIDE the PTY can move the kernel winsize out from under us at any
 * time (a TUI that calls TIOCSWINSZ, `stty cols N`, a size probe, an
 * `aura jump` child, …). Nothing in the event-driven path corrects that —
 * there's no browser resize to react to — so a long-running CLI tool ends up
 * wrapping at the wrong column with the user doing nothing.
 *
 * So we re-assert the size we KNOW is right on a slow heartbeat. This is
 * silent in the steady state: Linux's tty_do_resize() early-returns WITHOUT
 * signalling when the winsize is unchanged, so re-applying the same dimensions
 * sends no SIGWINCH and triggers no repaint. Only when something actually
 * drifted the winsize does the re-apply differ → SIGWINCH → the shell/TUI
 * snaps back to the correct width. Runs only while a client is attached.
 */
function startReconcile(sess: Session): void {
  if (sess.reconcileTimer) return;
  sess.reconcileTimer = setInterval(() => {
    if (sess.wss.size === 0) return;          // detached → nothing to keep in sync
    if (sess.cols <= 0 || sess.rows <= 0) return;
    try { sess.pty.resize(sess.cols, sess.rows); } catch { /* pty gone */ }
  }, RECONCILE_MS);
  // Never hold the process open just for the heartbeat.
  if (typeof sess.reconcileTimer.unref === 'function') sess.reconcileTimer.unref();
}

function attachWs(sess: Session, ws: WebSocket): void {
  if (sess.killTimer) { clearTimeout(sess.killTimer); sess.killTimer = null; }
  sess.wss.add(ws);
  log('attach', sess.id, `clients=${sess.wss.size} scrollback=${sess.bufferSize}B`);

  // Replay scrollback before live output resumes. One write of the joined
  // buffer is preferable to N small frames — xterm.js batches paint, but
  // the network round-trips would still show as a sluggish redraw.
  if (sess.buffer.length > 0) {
    try { ws.send(sess.buffer.join('')); } catch { /* socket may have torn down */ }
  }

  ws.on('message', (msg: Buffer | string) => {
    const raw = msg.toString();
    try {
      const parsed = JSON.parse(raw) as { type: string; cols?: number; rows?: number; data?: string; primary?: boolean };
      if (parsed.type === 'resize') {
        // A PTY has ONE winsize, but clients (different devices / screens) can
        // each want a different one. So clients REPORT their own desired size
        // here and the server picks the shared size in recomputeEffective():
        // smallest of everyone (so content wraps to fit every screen) unless a
        // client flags itself `primary`, in which case the primary device's
        // size wins. Each client still renders its own xterm at its own size;
        // this only governs the shared PTY the shell actually formats against.
        const cols = parsed.cols ?? sess.cols;
        const rows = parsed.rows ?? sess.rows;
        if (cols > 0 && rows > 0) {
          sess.clientSizes.set(ws, { cols, rows, primary: parsed.primary === true });
          recomputeEffective(sess);
        }
      } else if (parsed.type === 'data') {
        sess.pty.write(parsed.data ?? '');
      }
    } catch {
      sess.pty.write(raw);
    }
  });

  ws.on('close', (code) => {
    sess.wss.delete(ws);
    sess.clientSizes.delete(ws);
    // A client leaving can grow the effective size (e.g. the smallest screen
    // disconnected) — recompute so the remaining devices reclaim the space.
    recomputeEffective(sess);
    log('detach', sess.id, `code=${code} remaining=${sess.wss.size}`);
    // Last client left — start grace timer. If anything reattaches
    // within the window we cancel it (in attachWs above).
    if (sess.wss.size === 0) {
      sess.killTimer = setTimeout(() => {
        log('grace expired', sess.id);
        killSession(sess.id);
      }, GRACE_MS);
    }
  });
}

/**
 * Pick the shared PTY winsize from every attached client's reported size.
 *
 * Default: the SMALLEST cols/rows across all clients, so the shell's output
 * wraps to fit the narrowest screen — larger screens just show unused space on
 * the right (tmux-style), never wrong-wrapped text. Override: if any client
 * flagged itself `primary` (the user pressed the ★ button on that device), the
 * primary device's size wins instead — its screen fills exactly, others render
 * best-effort. Multiple primaries fall back to the smallest among them.
 *
 * Re-applying is idempotent: when the result is unchanged we don't touch the
 * PTY, and even the reconcile heartbeat's identical re-apply is a Linux no-op.
 */
function recomputeEffective(sess: Session): void {
  const all = [...sess.clientSizes.values()].filter((s) => s.cols > 0 && s.rows > 0);
  if (all.length === 0) return;                 // no sized clients yet — keep current
  const primaries = all.filter((s) => s.primary);
  const pool = primaries.length > 0 ? primaries : all;
  const cols = Math.min(...pool.map((s) => s.cols));
  const rows = Math.min(...pool.map((s) => s.rows));
  if (cols === sess.cols && rows === sess.rows) return;
  sess.cols = cols; sess.rows = rows;
  try { sess.pty.resize(cols, rows); } catch { /* ignore */ }
}

/** Public entry — called by the OS lifecycle hook when the activity is destroyed. */
export function killSession(sessionId: string): boolean {
  const sess = sessions.get(sessionId);
  if (!sess) return false;
  log('killSession', sessionId, `clients=${sess.wss.size}`);
  if (sess.killTimer) clearTimeout(sess.killTimer);
  if (sess.reconcileTimer) { clearInterval(sess.reconcileTimer); sess.reconcileTimer = null; }
  try { sess.pty.kill(); } catch { /* already gone */ }
  for (const ws of sess.wss) { try { ws.close(); } catch { /* ignore */ } }
  sess.wss.clear();
  sessions.delete(sessionId);
  return true;
}

let ptyWss: WebSocketServer | null = null;

export function getPtyWss(): WebSocketServer {
  if (ptyWss) return ptyWss;

  ptyWss = new WebSocketServer({ noServer: true });

  ptyWss.on('connection', (ws: WebSocket, req) => {
    // `req` is the upgrade request — the WS server's `connection` event
    // passes it through when we forward it from the upgrade handler.
    const url = parseUrl(req?.url ?? '', true);
    const sessionId = typeof url.query?.['_aura_session'] === 'string'
      ? url.query['_aura_session']
      : null;

    // Anonymous mode: no session id → fall back to legacy "kill on close"
    // behaviour. Keeps direct `/ws` consumers (curl, tests, anything that
    // bypasses the OS proxy) working as before. Each anonymous WS gets
    // its own private PTY.
    if (!sessionId) {
      log('anon connect');
      const term = spawnPty(80, 24);
      term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
      term.onExit(() => ws.close());
      ws.on('message', (msg: Buffer | string) => {
        const raw = msg.toString();
        try {
          const parsed = JSON.parse(raw) as { type: string; cols?: number; rows?: number; data?: string };
          if (parsed.type === 'resize') term.resize(parsed.cols ?? 80, parsed.rows ?? 24);
          else if (parsed.type === 'data') term.write(parsed.data ?? '');
        } catch { term.write(raw); }
      });
      ws.on('close', () => term.kill());
      return;
    }

    // Named session: attach to existing PTY (multicast) or spawn fresh.
    let sess = sessions.get(sessionId);
    if (!sess) {
      log('new session', sessionId);
      sess = {
        id: sessionId, pty: spawnPty(80, 24),
        wss: new Set(), buffer: [], bufferSize: 0,
        killTimer: null, reconcileTimer: null, clientSizes: new Map(), cols: 80, rows: 24,
      };
      sessions.set(sessionId, sess);
      attachPtyOutput(sess);
      startReconcile(sess);
      // Seed the host indicator before the shell's first prompt renders. It
      // sits first in the scrollback, so any later prompt title (incl. an
      // `aura jump` target) naturally overrides it on replay.
      bufferPush(sess, oscTitle(HOST_LABEL));
    }
    attachWs(sess, ws);
  });

  return ptyWss;
}
