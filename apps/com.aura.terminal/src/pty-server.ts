import { WebSocketServer, WebSocket } from 'ws';
import pty, { type IPty } from 'node-pty';
import { spawnSync } from 'node:child_process';
import { parse as parseUrl } from 'node:url';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 *   • A detached session is held INDEFINITELY by default (see GRACE_MS) —
 *     the only thing that ends a shell is the user typing `exit`, the OS
 *     destroying the activity, or the container going away.
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
  // Output coalescing: accumulate PTY output and flush it in ~60Hz frames so a
  // burst of many tiny pty.onData chunks (Claude Code streaming, a big `cat`)
  // becomes a handful of WS frames instead of dozens — one browser repaint per
  // frame, not per chunk. Leading-edge: the FIRST chunk of an idle stretch is
  // sent immediately (zero added latency for interactive echo); only a burst
  // arriving inside the open window gets coalesced.
  outBuf:     string;                  // not-yet-sent PTY output
  outTimer:   NodeJS.Timeout | null;   // frame-window timer (null ⇒ idle)
}

const SCROLLBACK_BYTES = 256 * 1024;
const RECONCILE_MS     = 5_000;        // winsize self-heal heartbeat interval
const OUTPUT_FRAME_MS  = 16;           // output-coalescing frame (~60Hz)

/**
 * Detached-session grace — how long a PTY is held after its LAST client goes
 * away. `0` (the default) means "forever": the shell lives until the user
 * exits it, the OS destroys the activity, or the container stops.
 *
 * This used to be 5 minutes, which quietly made sessions mortal. A WebSocket
 * is not a reliable liveness signal for "the user left": a backgrounded tab, a
 * closed laptop lid, a sleeping phone, a Wi-Fi handover — any of those tear the
 * socket down (code 1006, no close frame) while the user very much still has
 * that terminal open. Worse, the reattach that would have cancelled the timer
 * CAN'T happen while the tab is frozen: browsers throttle/suspend background
 * timers, so the client's reconnect fires only when the user comes back —
 * long after the 5 minutes were up and the shell was killed.
 *
 * The PTY is cheap (an idle bash is a few MB) and the real cleanup path is
 * explicit: `killSession` from the `onActivityDestroy` lifecycle hook when the
 * activity is closed for real, plus the natural `pty.onExit` when the shell
 * ends. So we default to holding on. `AURA_PTY_GRACE_MS` can restore a finite
 * window for constrained hosts.
 */
const GRACE_MS = Number(process.env['AURA_PTY_GRACE_MS'] ?? 0);

/**
 * WebSocket keepalive. An idle terminal sends zero bytes for hours, and every
 * hop in between (the shell's WS proxy, a reverse proxy / tunnel, a NAT
 * conntrack entry, a corporate middlebox) is free to drop a silent connection.
 * A protocol-level ping every 25s keeps the path warm in BOTH directions (the
 * browser's automatic pong is return traffic) and gives us a real liveness
 * check — a client that misses two pings is genuinely gone, so we stop
 * broadcasting into a dead socket instead of waiting for TCP to notice.
 *
 * Dropping a dead WS does NOT touch the PTY: it only detaches, and with
 * GRACE_MS=0 the session simply waits for the reattach.
 */
const PING_MS = 25_000;

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

// Scrollback persistence — write to /data/scrollback/<sessionId> when the
// last client disconnects, reload when a session is recreated after a restart.
const SCROLLBACK_DIR = join(process.env['AURA_DATA_DIR'] ?? '/data', 'scrollback');

function saveScrollback(sess: Session): void {
  if (sess.buffer.length === 0) return;
  try {
    mkdirSync(SCROLLBACK_DIR, { recursive: true });
    writeFileSync(join(SCROLLBACK_DIR, sess.id), sess.buffer.join(''), 'utf-8');
  } catch { /* best-effort */ }
}

function loadScrollback(sessionId: string): { buffer: string[]; bufferSize: number } {
  try {
    const file = join(SCROLLBACK_DIR, sessionId);
    if (!existsSync(file)) return { buffer: [], bufferSize: 0 };
    const text = readFileSync(file, 'utf-8');
    // Treat the whole file as one chunk — it was already capped at SCROLLBACK_BYTES.
    return { buffer: [text], bufferSize: text.length };
  } catch {
    return { buffer: [], bufferSize: 0 };
  }
}

function deleteScrollback(sessionId: string): void {
  try { rmSync(join(SCROLLBACK_DIR, sessionId), { force: true }); } catch { /* ignore */ }
}

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

/**
 * tmux backing — the shell OUTLIVES the PTY.
 *
 * Holding the PTY across disconnects (see GRACE_MS) fixes the common case, but
 * the PTY is still the shell's parent: anything that ends the pty-server ends
 * every shell with it — an app-instance restart, a Vite reload of this module,
 * a crash, `aura dev` cycling the container's process. That's the last way a
 * long-running session can vanish without the user doing anything.
 *
 * So the shell runs inside a tmux session instead, and the PTY becomes a
 * disposable pipe onto it. `new-session -A` means attach-or-create: a respawned
 * PTY reattaches to the SAME live shell — same cwd, same env, same running
 * command, same scrollback. What survives now is bounded by the container's
 * lifetime, not this process's.
 *
 * tmux is meant to be invisible (see tmux.conf); the user still just gets a
 * bash prompt. If the binary isn't in the image we degrade silently to a bare
 * shell — which behaves exactly like before — so an app running on an older
 * base image, or with AURA_TERM_TMUX=0, is never left broken.
 */
const TMUX_SOCKET = 'aura';   // private -L namespace, never collides with a user's own tmux
const TMUX_CONF   = join(dirname(fileURLToPath(import.meta.url)), '..', 'tmux.conf');

const tmuxBin = (() => {
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
function tmuxName(sessionId: string): string {
  return `aura-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Kill the backing tmux session. Returns true if one actually existed. */
function tmuxKill(sessionId: string): boolean {
  if (!tmuxBin) return false;
  try {
    const r = spawnSync(tmuxBin, ['-L', TMUX_SOCKET, 'kill-session', '-t', tmuxName(sessionId)], { stdio: 'ignore' });
    return r.status === 0;
  } catch { /* no server / no such session — nothing to clean up */ }
  return false;
}

function spawnPty(sessionId: string | null, cols: number, rows: number): IPty {
  const shell = process.env['SHELL'] ?? '/bin/bash';
  // AURA_TERM_LABEL marks this as the base/host shell so bashrc.aura.sh's
  // window-title shows the host ("aura-shell") rather than this app's id.
  // `aura jump` shells run in a different sandbox where it's absent (or
  // explicitly blanked, see enter-sandbox.ts), so they show the app instead.
  const env = { ...process.env, AURA_TERM_LABEL: HOST_LABEL } as Record<string, string>;
  const opts = { name: 'xterm-256color', cols, rows, cwd: process.env['HOME'] ?? '/app', env };

  // Anonymous connections (sessionId === null) are explicitly ephemeral —
  // they die with their socket by design, so persistence would only leak
  // tmux servers for curl/test clients.
  if (!tmuxBin || sessionId === null) return pty.spawn(shell, [], opts);

  // attach-or-create. `-u` forces UTF-8 regardless of the container's locale
  // (node:22 images ship POSIX, which would otherwise mangle box-drawing).
  return pty.spawn(tmuxBin, [
    '-L', TMUX_SOCKET,
    '-f', TMUX_CONF,
    '-u',
    'new-session', '-A', '-s', tmuxName(sessionId),
    shell,
  ], opts);
}

function broadcastToWss(sess: Session, data: string): void {
  for (const ws of sess.wss) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Flush whatever output is buffered right now — append it to the scrollback
// ring and broadcast it to every attached client. No-op when the buffer is
// empty. Callers that must guarantee ordering (scrollback replay/save, pty
// exit) call this before they read the ring.
function emitOut(sess: Session): void {
  if (sess.outBuf.length === 0) return;
  const data = sess.outBuf;
  sess.outBuf = '';
  bufferPush(sess, data);
  broadcastToWss(sess, data);
}

function attachPtyOutput(sess: Session): void {
  sess.pty.onData((data) => {
    sess.outBuf += data;
    if (sess.outTimer) return;                   // window open → coalesce; it will flush at window end
    emitOut(sess);                               // leading edge: idle → send now (0ms added for echo)
    sess.outTimer = setTimeout(() => { sess.outTimer = null; emitOut(sess); }, OUTPUT_FRAME_MS);
    if (typeof sess.outTimer.unref === 'function') sess.outTimer.unref();
  });
  sess.pty.onExit(() => {
    log('pty exit', sess.id);
    // PTY exited (user typed `exit`, signal, etc.). Flush the tail first so the
    // final output (logout banner, last program frame) isn't lost, then drop
    // the session entirely — no point holding scrollback for a dead shell.
    emitOut(sess);
    if (sess.outTimer) { clearTimeout(sess.outTimer); sess.outTimer = null; }
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
  markAlive(ws);
  sess.wss.add(ws);
  log('attach', sess.id, `clients=${sess.wss.size} scrollback=${sess.bufferSize}B`);

  // Flush any output still sitting in the coalescing buffer into the ring so
  // this client's replay below reflects the very latest state. Safe: the new
  // ws isn't in sess.wss yet, so emitOut's broadcast can't double-send to it.
  emitOut(sess);

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
    // Last client left. Persist the scrollback so the session survives even a
    // pty-server restart, then hold the PTY: with GRACE_MS=0 (the default) the
    // shell waits indefinitely for the user to come back. A finite grace is
    // opt-in via AURA_PTY_GRACE_MS.
    if (sess.wss.size === 0) {
      emitOut(sess);                 // fold any buffered tail into the ring before we persist it
      saveScrollback(sess);
      if (GRACE_MS > 0) {
        sess.killTimer = setTimeout(() => {
          log('grace expired', sess.id);
          killSession(sess.id);
        }, GRACE_MS);
      } else {
        log('idle', sess.id, 'no clients — holding session indefinitely');
      }
    }
  });
}

/**
 * Global keepalive sweep — one timer for every attached socket rather than one
 * timer per socket. Marks each client unacknowledged, pings it, and terminates
 * anything that didn't pong since the previous sweep. `ws` answers incoming
 * pings automatically, so browsers need no cooperation for this to work.
 */
const alive = new WeakSet<WebSocket>();

function markAlive(ws: WebSocket): void {
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
}

function sweepKeepalive(): void {
  for (const sess of sessions.values()) {
    for (const ws of sess.wss) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!alive.has(ws)) {
        // Missed the previous ping — the socket is a zombie (half-open TCP,
        // sleeping device). Terminate so `close` fires and it detaches; the
        // PTY itself is untouched and waits for the reattach.
        log('keepalive timeout', sess.id);
        try { ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      alive.delete(ws);
      try { ws.ping(); } catch { /* socket died between check and ping */ }
    }
  }
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

  // Tear down the tmux session and the persisted scrollback UNCONDITIONALLY —
  // before the in-memory lookup, not after it. Now that shells outlive this
  // process, an empty registry no longer means "no shell": after a pty-server
  // restart the shell is alive in tmux while `sessions` is empty. Early-
  // returning there would strand that shell forever, and the next activity to
  // reuse the id would attach to a stale one.
  const killedTmux = tmuxKill(sessionId);
  deleteScrollback(sessionId);

  if (!sess) {
    if (killedTmux) log('killSession', sessionId, 'detached tmux session reaped (no in-memory session)');
    return killedTmux;
  }
  log('killSession', sessionId, `clients=${sess.wss.size}`);
  if (sess.killTimer) clearTimeout(sess.killTimer);
  if (sess.reconcileTimer) { clearInterval(sess.reconcileTimer); sess.reconcileTimer = null; }
  if (sess.outTimer) { clearTimeout(sess.outTimer); sess.outTimer = null; }
  // Kill the tmux session FIRST. Killing only the PTY would leave the shell
  // running detached forever — and the next activity to reuse this id would
  // silently attach to that stale shell instead of getting a fresh one.
  tmuxKill(sessionId);
  try { sess.pty.kill(); } catch { /* already gone */ }
  for (const ws of sess.wss) { try { ws.close(); } catch { /* ignore */ } }
  sess.wss.clear();
  sessions.delete(sessionId);
  deleteScrollback(sessionId);
  return true;
}

let ptyWss: WebSocketServer | null = null;

export function getPtyWss(): WebSocketServer {
  if (ptyWss) return ptyWss;

  ptyWss = new WebSocketServer({ noServer: true });

  // Keepalive sweep — armed once with the server, unref'd so it never keeps
  // the process alive on its own.
  const keepalive = setInterval(sweepKeepalive, PING_MS);
  if (typeof keepalive.unref === 'function') keepalive.unref();
  log('keepalive armed', `${PING_MS}ms`, GRACE_MS > 0 ? `grace=${GRACE_MS}ms` : 'grace=never');

  ptyWss.on('connection', (ws: WebSocket, req) => {
    // `req` is the upgrade request — the WS server's `connection` event
    // passes it through when we forward it from the upgrade handler.

    // Disable Nagle so a small keystroke-echo frame isn't held back waiting to
    // be batched with more bytes. NOTE: the `ws` library already calls
    // socket.setNoDelay() on every socket it manages, so this is a
    // belt-and-suspenders guard documenting intent — not the latency fix. The
    // actual smoothing win is the output coalescing in attachPtyOutput.
    try { (req as { socket?: { setNoDelay?: (v: boolean) => void } })?.socket?.setNoDelay?.(true); }
    catch { /* socket already gone / no-op */ }

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
      const term = spawnPty(null, 80, 24);
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
      const saved = loadScrollback(sessionId);
      sess = {
        id: sessionId, pty: spawnPty(sessionId, 80, 24),
        wss: new Set(), ...saved,
        killTimer: null, reconcileTimer: null, clientSizes: new Map(), cols: 80, rows: 24,
        outBuf: '', outTimer: null,
      };
      sessions.set(sessionId, sess);
      attachPtyOutput(sess);
      startReconcile(sess);
      // Seed the host indicator before the shell's first prompt renders. It
      // sits first in the scrollback, so any later prompt title (incl. an
      // `aura jump` target) naturally overrides it on replay.
      if (saved.buffer.length === 0) bufferPush(sess, oscTitle(HOST_LABEL));
    }
    attachWs(sess, ws);
  });

  return ptyWss;
}
