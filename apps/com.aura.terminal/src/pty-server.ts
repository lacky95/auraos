import { WebSocketServer, WebSocket } from 'ws';
import pty, { type IPty } from 'node-pty';
import { parse as parseUrl } from 'node:url';

/**
 * PTY session registry — survives browser reload.
 *
 * Each session is keyed by the OS activity id (forwarded by the terminal
 * page as `?_aura_session=<id>` on its WS URL). When the browser drops the
 * WS the PTY DOES NOT die immediately — we start a grace timer (default 5
 * min). Within that window, a new WS arriving with the same sessionId
 * reattaches: the live PTY's `onData` is rewired to the new WS and the
 * scrollback ring buffer is replayed so the user sees the prior state
 * before live output continues.
 *
 * The PTY is killed only when:
 *   • the grace timer fires (browser gone for good), or
 *   • the OS calls the activity's `onActivityDestroy` lifecycle hook —
 *     which then calls `killSession(activityId)` from this module.
 *
 * Anonymous connections (no `_aura_session`) get the previous behavior:
 * a fresh PTY that dies on WS close, no scrollback. Maintains compat with
 * any caller that hits `/ws` directly without going through the OS proxy.
 */

interface Session {
  id:         string;
  pty:        IPty;
  ws:         WebSocket | null;
  buffer:     string[];    // scrollback ring (joined chunks)
  bufferSize: number;      // total bytes in buffer; cap at SCROLLBACK_BYTES
  killTimer:  NodeJS.Timeout | null;
}

const SCROLLBACK_BYTES = 256 * 1024;
const GRACE_MS         = 5 * 60_000;   // 5 minutes browser-gone before kill

const sessions = new Map<string, Session>();

function bufferPush(sess: Session, chunk: string): void {
  sess.buffer.push(chunk);
  sess.bufferSize += chunk.length;
  while (sess.bufferSize > SCROLLBACK_BYTES && sess.buffer.length > 1) {
    const removed = sess.buffer.shift()!;
    sess.bufferSize -= removed.length;
  }
}

function spawnPty(): IPty {
  const shell = process.env['SHELL'] ?? '/bin/bash';
  return pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env['HOME'] ?? '/app',
    env: process.env as Record<string, string>,
  });
}

function attachWs(sess: Session, ws: WebSocket): void {
  if (sess.killTimer) { clearTimeout(sess.killTimer); sess.killTimer = null; }
  sess.ws = ws;

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
      if (parsed.type === 'resize') sess.pty.resize(parsed.cols ?? 80, parsed.rows ?? 24);
      else if (parsed.type === 'data') sess.pty.write(parsed.data ?? '');
    } catch {
      sess.pty.write(raw);
    }
  });

  ws.on('close', () => {
    // Only detach if THIS ws is still the bound one. A fast reload can
    // create a new WS that attaches before the old one's 'close' event
    // fires; we don't want to nuke the new attachment.
    if (sess.ws !== ws) return;
    sess.ws = null;
    sess.killTimer = setTimeout(() => killSession(sess.id), GRACE_MS);
  });
}

function attachPtyOutput(sess: Session): void {
  sess.pty.onData((data) => {
    bufferPush(sess, data);
    if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
      sess.ws.send(data);
    }
  });
  sess.pty.onExit(() => {
    // PTY itself exited (user typed `exit`, signal, etc.). Drop the
    // session — no point holding it across reload.
    if (sess.ws) try { sess.ws.close(); } catch { /* ignore */ }
    sessions.delete(sess.id);
  });
}

/** Public entry — called by the OS lifecycle hook when the activity is destroyed. */
export function killSession(sessionId: string): boolean {
  const sess = sessions.get(sessionId);
  if (!sess) return false;
  if (sess.killTimer) clearTimeout(sess.killTimer);
  try { sess.pty.kill(); } catch { /* already gone */ }
  if (sess.ws) try { sess.ws.close(); } catch { /* ignore */ }
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
    // bypasses the OS proxy) working as before.
    if (!sessionId) {
      const term = spawnPty();
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

    // Named session: reattach if alive, otherwise spawn fresh.
    let sess = sessions.get(sessionId);
    if (!sess) {
      sess = { id: sessionId, pty: spawnPty(), ws: null, buffer: [], bufferSize: 0, killTimer: null };
      sessions.set(sessionId, sess);
      attachPtyOutput(sess);
    } else if (sess.ws) {
      // Old WS is still listed as attached — close it so the new one wins.
      try { sess.ws.close(); } catch { /* ignore */ }
      sess.ws = null;
    }
    attachWs(sess, ws);
  });

  return ptyWss;
}
