/**
 * Shell boot timeline — marks, boot stages and an on-demand summary.
 *
 * Every mark is a `performance.mark('aura:<name>')` (always recorded, cheap)
 * plus a `shell:boot` debug line when the log filter enables it
 * (`?log=shell:*`, localStorage `aura.log`, Settings → General → Frontend
 * logging; see lib/logControl.ts).
 *
 * Boot stages (the order the desktop becomes usable):
 *   0 chrome          HTML + bars + theme              → 'chrome-ready'
 *   1 active ws       active workspace iframes loaded  → 'ws:active-loaded'
 *   2 bars            top/bottom bar fully interactive → 'bars-ready'
 *   3 warm            other workspaces warmed in idle  → 'warm:end'
 *   4 notifications   store + center + toasts          → 'notif:ready'
 * Later stages wait on earlier ones with `onStage(name, fn)` — never on
 * document order. A stage that never resolves (an app that never fires
 * `load`) is released by the caller's safety timeout.
 *
 * State lives on `window.__auraBoot` so every module script — and the
 * `is:inline` scripts, which can't import — share one timeline.
 */
import { createLogger } from '@aura/core/logger';

const log = createLogger('shell:boot');

export const STAGES = ['chrome-ready', 'ws:active-loaded', 'bars-ready', 'warm:end', 'notif:ready'] as const;
export type StageName = typeof STAGES[number] | (string & {});

interface MarkRecord { name: string; t: number; detail?: unknown }
interface BootState {
  marks: MarkRecord[];
  stages: Map<string, { done: boolean; t?: number; waiters: Array<() => void> }>;
  summaryPrinted: boolean;
}

function now(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function state(): BootState {
  const g = globalThis as { __auraBoot?: BootState };
  if (!g.__auraBoot) g.__auraBoot = { marks: [], stages: new Map(), summaryPrinted: false };
  // The inline head script may have created a plain object before this module ran.
  const s = g.__auraBoot;
  if (!(s.stages instanceof Map)) s.stages = new Map();
  if (!Array.isArray(s.marks)) s.marks = [];
  return s;
}

/** Record a point in time. `detail` shows in the debug line and the summary. */
export function mark(name: string, detail?: unknown): void {
  const t = now();
  state().marks.push({ name, t, detail });
  try { performance.mark(`aura:${name}`, detail === undefined ? undefined : { detail }); } catch { /* old engine */ }
  if (log.isEnabled()) log.debug(`${t.toFixed(0).padStart(6)}ms ${name}`, ...(detail === undefined ? [] : [detail]));
}

/** First time `name` was marked, ms since navigation start; null when never. */
export function markTime(name: string): number | null {
  const m = state().marks.find((r) => r.name === name);
  return m ? m.t : null;
}

/** Count of marks named `name` (or with that prefix when it ends in `*`). */
export function markCount(name: string): number {
  const prefix = name.endsWith('*') ? name.slice(0, -1) : null;
  return state().marks.filter((r) => (prefix !== null ? r.name.startsWith(prefix) : r.name === name)).length;
}

function slot(name: string) {
  const s = state();
  let st = s.stages.get(name);
  if (!st) { st = { done: false, waiters: [] }; s.stages.set(name, st); }
  return st;
}

/** Mark a stage done (idempotent) and run everything waiting on it. */
export function resolveStage(name: StageName, detail?: unknown): void {
  const st = slot(name);
  if (st.done) return;
  st.done = true;
  st.t = now();
  mark(`stage:${name}`, detail);
  const waiters = st.waiters.splice(0);
  for (const w of waiters) {
    try { w(); } catch (err) { console.error('[shell:boot] stage waiter failed', name, err); }
  }
}

export function isStageDone(name: StageName): boolean {
  return slot(name).done;
}

/**
 * Run `fn` once `name` is done (immediately — synchronously — when it already
 * is). With `timeoutMs`, `fn` also runs after that long if the stage never
 * comes; `fn` runs at most once either way.
 */
export function onStage(name: StageName, fn: () => void, opts: { timeoutMs?: number } = {}): void {
  const st = slot(name);
  let ran = false;
  const once = () => { if (ran) return; ran = true; fn(); };
  if (st.done) { once(); return; }
  st.waiters.push(once);
  if (opts.timeoutMs !== undefined) {
    setTimeout(() => {
      if (!ran) mark(`stage-timeout:${name}`, { afterMs: opts.timeoutMs });
      once();
    }, opts.timeoutMs);
  }
}

export function stage(name: StageName): Promise<void> {
  return new Promise((resolve) => onStage(name, resolve));
}

type IdleCb = (deadline: { timeRemaining(): number; didTimeout: boolean }) => void;

/** requestIdleCallback with a setTimeout fallback (Safari / old WebViews). */
export function idle(fn: () => void, opts: { timeout?: number } = {}): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: IdleCb, o?: { timeout?: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(() => fn(), { timeout: opts.timeout ?? 2000 });
  else setTimeout(fn, 50);
}

export interface SummaryRow { mark: string; ms: number; delta: number; detail: string }

/** The timeline as rows: ms since navigation start, delta to the previous mark. */
export function summaryRows(): SummaryRow[] {
  const marks = [...state().marks].sort((a, b) => a.t - b.t);
  let prev = 0;
  return marks.map((m) => {
    const row = {
      mark: m.name,
      ms: Math.round(m.t),
      delta: Math.round(m.t - prev),
      detail: m.detail === undefined ? '' : (typeof m.detail === 'string' ? m.detail : JSON.stringify(m.detail)),
    };
    prev = m.t;
    return row;
  });
}

/** The bar components that must be interactive for stage 'bars-ready'. */
export const BAR_PARTS = ['statusbar', 'dock', 'launcher', 'procman'] as const;

/**
 * A bar component registered its handlers (its trigger works from now on).
 * Resolves 'bars-ready' once all of BAR_PARTS did.
 */
export function markBarReady(part: typeof BAR_PARTS[number]): void {
  mark(`bar:${part}`);
  if (BAR_PARTS.every((p) => markCount(`bar:${p}`) > 0)) resolveStage('bars-ready');
}

/** Print the timeline table (only when `shell:boot` logging is on). */
export function printSummary(): void {
  if (!log.isEnabled()) return;
  const rows = summaryRows();
  log.info(`boot timeline — ${rows.length} marks`);
  // console.table keeps the table out of the per-line prefix format.
  (console.table ?? console.log).call(console, rows);
}

function printSummaryOnce(): void {
  const s = state();
  if (s.summaryPrinted) return;
  s.summaryPrinted = true;
  printSummary();
  sendReport();
}

/** Extra fields for the boot report (e.g. the lazy-load policy). */
const reportExtras: Record<string, () => unknown> = {};
export function addReportField(name: string, get: () => unknown): void {
  reportExtras[name] = get;
}

/**
 * Post the timeline to the shell (GET /api/os/boot-report reads it back), so a
 * boot can be inspected without DevTools. Only while `shell:boot` logging is on.
 */
export function sendReport(): void {
  if (!log.isEnabled() || typeof navigator === 'undefined' || typeof location === 'undefined') return;
  const extras: Record<string, unknown> = {};
  for (const [k, get] of Object.entries(reportExtras)) {
    try { extras[k] = get(); } catch { /* skip */ }
  }
  const body = JSON.stringify({
    url: location.pathname + location.search,
    ua: navigator.userAgent,
    stages: Object.fromEntries([...state().stages].map(([k, v]) => [k, v.done ? Math.round(v.t ?? 0) : null])),
    rows: summaryRows(),
    ...extras,
  });
  try {
    const blob = new Blob([body], { type: 'application/json' });
    if (!navigator.sendBeacon?.('/api/os/boot-report', blob)) {
      void fetch('/api/os/boot-report', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
    }
  } catch { /* best-effort */ }
}

/** Print (and report) the summary once every stage is done, or after
 *  `fallbackMs` at the latest. */
export function installSummaryTrigger(fallbackMs = 20_000): void {
  let left = STAGES.length;
  for (const s of STAGES) onStage(s, () => { if (--left === 0) printSummaryOnce(); });
  setTimeout(printSummaryOnce, fallbackMs);
}

/** Console handle: `__auraBootTimeline.print()` from DevTools at any time. */
if (typeof window !== 'undefined') {
  (window as unknown as { __auraBootTimeline?: unknown }).__auraBootTimeline = {
    print: () => { (console.table ?? console.log).call(console, summaryRows()); },
    rows: summaryRows,
    stages: () => Object.fromEntries([...state().stages].map(([k, v]) => [k, v.done ? Math.round(v.t ?? 0) : null])),
  };
}

/** Test hook: forget every mark and stage. */
export function _resetForTests(): void {
  const g = globalThis as { __auraBoot?: BootState };
  delete g.__auraBoot;
}
