/**
 * Page side of an OPEN_TERMINAL intent's `command` (server side:
 * launch-commands.ts): decide WHEN to tell the container "this window's
 * terminal is live — run it now".
 *
 * "Live" is the `granted` control frame: the socket is open, xterm is fitted
 * (connect() fits on open), the PTY is attached and this browser renders it.
 * The gate waits `settleMs` past that so the scrollback replay is painted,
 * then fires once. A drop or a take-over (`lost`) before it fires just
 * cancels; the next `granted` — after any reconnect — re-arms it. A fire
 * that fails on the network is retried while the terminal stays live; any
 * answer from the container ends it (the container removes the command
 * before typing it, so there is nothing to retry and nothing to run twice).
 */
export type FireOutcome = 'done' | 'retry';

export interface LaunchGateOptions {
  fire: () => Promise<FireOutcome>;
  settleMs?: number;
  retryMs?: number;
  maxAttempts?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface LaunchGate {
  /** The terminal is live (a `granted` frame arrived). */
  live(): void;
  /** It is not any more (socket closed, or another browser took it). */
  lost(): void;
  readonly done: boolean;
}

export function createLaunchGate(opts: LaunchGateOptions): LaunchGate {
  const settleMs = opts.settleMs ?? 150;
  const retryMs = opts.retryMs ?? 2_000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let done = false;
  let isLive = false;
  let inFlight = false;
  let attempts = 0;
  let timer: unknown = null;

  const disarm = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const arm = (ms: number) => {
    if (done || inFlight || !isLive) return;
    disarm();
    timer = schedule(run, ms);
  };

  async function run(): Promise<void> {
    timer = null;
    if (done || inFlight || !isLive) return;
    inFlight = true;
    attempts++;
    let outcome: FireOutcome;
    try { outcome = await opts.fire(); } catch { outcome = 'retry'; }
    inFlight = false;
    if (outcome === 'done' || attempts >= maxAttempts) { done = true; return; }
    arm(retryMs);
  }

  return {
    live() { isLive = true; arm(settleMs); },
    lost() { isLive = false; disarm(); },
    get done() { return done; },
  };
}
