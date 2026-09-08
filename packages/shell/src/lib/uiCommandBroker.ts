/**
 * Server → browser commands with an answer.
 *
 * Every other OS event is a notification ("state moved, go re-read it").
 * The shell MCP needs the opposite: "do this in the UI and tell me what
 * happened" — zoom, fullscreen, launcher search, window focus and the like
 * exist only in the browser. So a command is emitted as `ui:command`, ONE
 * browser tab claims it (first claim wins, so two open tabs never both
 * create a workspace), runs it, and posts the result back here.
 *
 * Pinned on globalThis like keymapRegistry: the routes that dispatch, claim
 * and resolve are separate modules under Vite, and a pending command must be
 * found by all three.
 */
import { randomUUID } from 'node:crypto';
import { OsEventBus } from '@aura/core';

export type UiCommandOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: 'no-ui' | 'timeout' | 'ui-error'; message: string };

export interface UiCommandResult { ok: boolean; result?: unknown; error?: string }

interface Pending {
  action: string;
  claimed: boolean;
  settle: (o: UiCommandOutcome) => void;
  claimTimer: NodeJS.Timeout | null;
  resultTimer: NodeJS.Timeout | null;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS     = 60_000;
const CLAIM_WINDOW_MS    = 1_500;

class UiCommandBroker {
  private pending = new Map<string, Pending>();

  /** Emit a command and wait for the browser's answer. Never throws. */
  dispatch(
    action: string,
    params?: Record<string, unknown>,
    opts: { timeoutMs?: number; claimWindowMs?: number } = {},
  ): Promise<UiCommandOutcome> {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
    const claimWindowMs = opts.claimWindowMs ?? CLAIM_WINDOW_MS;
    const id = randomUUID();
    return new Promise<UiCommandOutcome>((resolve) => {
      const entry: Pending = {
        action, claimed: false, claimTimer: null, resultTimer: null,
        settle: (o) => {
          if (entry.claimTimer)  clearTimeout(entry.claimTimer);
          if (entry.resultTimer) clearTimeout(entry.resultTimer);
          this.pending.delete(id);
          resolve(o);
        },
      };
      // Registered BEFORE the emit: a tab can claim within the same tick.
      this.pending.set(id, entry);
      entry.claimTimer = setTimeout(() => {
        if (!entry.claimed) entry.settle({ ok: false, error: 'no-ui', message: 'no shell UI is connected — open the shell in a browser' });
      }, claimWindowMs);
      entry.resultTimer = setTimeout(() => {
        entry.settle({ ok: false, error: 'timeout', message: `the shell UI did not answer "${action}" within ${timeoutMs} ms` });
      }, timeoutMs);
      OsEventBus.emit('ui:command', { id, action, params });
    });
  }

  /** First claimant runs the command; everyone else is told to stand down. */
  claim(id: string): 'claimed' | 'already-claimed' | 'unknown' {
    const entry = this.pending.get(id);
    if (!entry) return 'unknown';
    if (entry.claimed) return 'already-claimed';
    entry.claimed = true;
    if (entry.claimTimer) { clearTimeout(entry.claimTimer); entry.claimTimer = null; }
    return 'claimed';
  }

  /** The browser's answer. False when the id is unknown or already settled. */
  resolve(id: string, r: UiCommandResult): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (r.ok) entry.settle({ ok: true, result: r.result ?? null });
    else entry.settle({ ok: false, error: 'ui-error', message: r.error || `"${entry.action}" failed in the shell UI` });
    return true;
  }

  pendingCount(): number { return this.pending.size; }
}

const GLOBAL_KEY = '__aura_ui_command_broker__';
type GlobalWithBroker = typeof globalThis & { [GLOBAL_KEY]?: UiCommandBroker };
const existing = (globalThis as GlobalWithBroker)[GLOBAL_KEY];
export const uiCommandBroker: UiCommandBroker = existing ?? new UiCommandBroker();
if (!existing) (globalThis as GlobalWithBroker)[GLOBAL_KEY] = uiCommandBroker;
