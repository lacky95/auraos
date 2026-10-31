// When to (re)dial the PTY WebSocket.
//
// The page owns the socket itself (URL, frames, xterm); this decides WHEN a
// new one is opened, so the policy is testable without a browser:
//
//   - a drop retries on a backoff ladder, 500 ms · 2ⁿ capped at 10 s;
//   - a wake-up (tab visible, window focus, back online, pageshow) redials at
//     once, cancelling any pending retry — the user is present;
//   - a periodic tick is the floor under missed close events;
//   - a redial while the previous socket is still open waits for that socket
//     to close (or 300 ms) before dialling. The server sizes the PTY to the
//     SMALLEST live socket, so two of ours overlapping — even for one round
//     trip — can shove the shell to a stale size and back (two SIGWINCHes, two
//     full repaints of whatever TUI is running);
//   - the "[disconnected — reconnecting]" notice is only shown once an outage
//     has lasted NOTICE_MS. A sub-second blip (the phone waking, a proxy
//     hiccup) reconnects silently instead of scribbling into the buffer.

export interface ConnectionDeps {
  /** Open a new socket now. */
  dial(): void;
  /** Close the current socket if it is CONNECTING/OPEN; true if there was one. */
  closeCurrent(): boolean;
  /** The current socket is CONNECTING or OPEN. */
  healthy(): boolean;
  /** No session to connect to (placeholder shown) — never redial. */
  detached(): boolean;
  /** The outage is long enough to tell the user. */
  onOutage?(): void;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 10_000;
export const NOTICE_MS = 1000;
export const SUPERSEDE_WAIT_MS = 300;

export function createConnection(deps: ConnectionDeps) {
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let attempt = 0;
  let retryTimer: unknown = null;
  let noticeTimer: unknown = null;
  let waitTimer: unknown = null;       // waiting for the superseded socket to close
  let outage = false;                  // the notice has been shown for this outage

  function clear(which: 'retry' | 'notice' | 'wait') {
    if (which === 'retry' && retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
    if (which === 'notice' && noticeTimer !== null) { clearTimer(noticeTimer); noticeTimer = null; }
    if (which === 'wait' && waitTimer !== null) { clearTimer(waitTimer); waitTimer = null; }
  }

  function backoffMs(): number {
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)), BACKOFF_CAP_MS);
  }

  function dialNow() {
    clear('wait');
    attempt++;
    deps.dial();
  }

  function connect() {
    if (deps.detached()) return;
    clear('retry');
    if (waitTimer !== null) return;    // already dialling as soon as the old socket is gone
    if (deps.closeCurrent()) {
      waitTimer = setTimer(dialNow, SUPERSEDE_WAIT_MS);
      return;
    }
    dialNow();
  }

  function scheduleRetry() {
    if (deps.detached() || retryTimer !== null || waitTimer !== null || deps.healthy()) return;
    retryTimer = setTimer(() => { retryTimer = null; connect(); }, backoffMs());
  }

  return {
    /** Dial (the first time, a session switch, an explicit take-over). */
    connect,

    /** The current socket opened. */
    opened() {
      attempt = 0;
      outage = false;
      clear('retry');
      clear('notice');
    },

    /** A socket closed. `current`: it was the active one (not a superseded
     *  one); `wasOpen`: it had opened, so this is a drop, not a failed dial. */
    closed({ current, wasOpen }: { current: boolean; wasOpen: boolean }) {
      if (!current) {
        if (waitTimer !== null) dialNow();   // the socket we were waiting on is gone
        return;
      }
      if (deps.detached()) { clear('notice'); return; }
      if (wasOpen && !outage && noticeTimer === null) {
        noticeTimer = setTimer(() => { noticeTimer = null; outage = true; deps.onOutage?.(); }, NOTICE_MS);
      }
      scheduleRetry();
    },

    /** The user is back (visibility, focus, online, pageshow): redial now. */
    wake() {
      if (deps.detached() || deps.healthy()) return;
      connect();
    },

    /** Periodic floor: a dead socket with nothing pending gets redialled. */
    tick() {
      if (deps.detached() || deps.healthy() || retryTimer !== null || waitTimer !== null) return;
      connect();
    },

    /** Leaving the session for good: nothing may fire afterwards. */
    stop() {
      clear('retry');
      clear('notice');
      clear('wait');
    },

    attempt: () => attempt,
    /** True once this outage has been announced (a later failed dial may
     *  update the notice instead of staying silent). */
    outage: () => outage,
    backoffMs,
  };
}

export type Connection = ReturnType<typeof createConnection>;
