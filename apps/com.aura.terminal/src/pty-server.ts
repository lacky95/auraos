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
  cols:       number;
  rows:       number;
}

const SCROLLBACK_BYTES = 256 * 1024;
const GRACE_MS         = 5 * 60_000;   // 5 minutes after last client leaves

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
    env: process.env as Record<string, string>,
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
    for (const ws of sess.wss) { try { ws.close(); } catch { /* ignore */ } }
    sess.wss.clear();
    sessions.delete(sess.id);
  });
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
      const parsed = JSON.parse(raw) as { type: string; cols?: number; rows?: number; data?: string };
      if (parsed.type === 'resize') {
        // Resize is a shared property of the PTY — every connected client
        // sees the same dimensions. We adopt the resize the latest client
        // sent. If clients disagree, the most recent one wins (consistent
        // with how `term.onResize` fires after fit() inside each iframe).
        const cols = parsed.cols ?? sess.cols;
        const rows = parsed.rows ?? sess.rows;
        if (cols !== sess.cols || rows !== sess.rows) {
          sess.cols = cols; sess.rows = rows;
          try { sess.pty.resize(cols, rows); } catch { /* ignore */ }
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

/** Public entry — called by the OS lifecycle hook when the activity is destroyed. */
export function killSession(sessionId: string): boolean {
  const sess = sessions.get(sessionId);
  if (!sess) return false;
  log('killSession', sessionId, `clients=${sess.wss.size}`);
  if (sess.killTimer) clearTimeout(sess.killTimer);
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
        killTimer: null, cols: 80, rows: 24,
      };
      sessions.set(sessionId, sess);
      attachPtyOutput(sess);
    }
    attachWs(sess, ws);
  });

  return ptyWss;
}
