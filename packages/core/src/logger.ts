/**
 * Aura global logger — one filter spec, works in Node (server-side
 * handlers, AppManager, etc.) and in the browser (shell DOM scripts,
 * iframe forwarders, SDK consumers).
 *
 * Filter spec: comma- or whitespace-separated `<pattern>[@<level>]`
 * entries. `*` is a wildcard, `-` prefix negates. `@<level>` raises the
 * minimum level the matching namespaces emit at — `debug` < `info`
 * < `log` ≤ `warn` < `error`. Without `@level`, every level fires.
 *
 *   AURA_LOG=*                       everything, every level
 *   AURA_LOG=sse,ws-proxy,keymap     three namespaces, every level
 *   AURA_LOG=*@warn                  only warn/error globally
 *   AURA_LOG=sse@debug,*@error       sse full firehose, everything else error-only
 *   AURA_LOG=*,-noisy                everything except `noisy`
 *
 * Lookup order:
 *   either   — globalThis.__AURA_LOG__  (programmatic override)
 *   server   — process.env.AURA_LOG
 *   browser  — localStorage 'aura.log'  →  <meta name="aura-log">
 *
 * Off by default. Filter is re-read on every log call so toggling
 * localStorage / globalThis at runtime takes effect on the next line
 * without restart.
 */

export type LogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info:  20,
  log:   20,
  warn:  30,
  error: 40,
};

export interface Logger {
  debug(...args: unknown[]): void;
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Cheap pre-check so callers can skip arg-construction work. */
  isEnabled(level?: LogLevel): boolean;
  /** Tag a child logger like `parent:child`. Inherits the parent's filter rules. */
  child(suffix: string): Logger;
}

function readFilter(): string {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as { __AURA_LOG__?: string };
    if (typeof g.__AURA_LOG__ === 'string' && g.__AURA_LOG__) return g.__AURA_LOG__;
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env.AURA_LOG === 'string') {
    return process.env.AURA_LOG;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem('aura.log');
      if (v) return v;
    } catch { /* private mode etc. */ }
  }
  const g = globalThis as { document?: { querySelector?: (sel: string) => { content?: string } | null } };
  if (g.document?.querySelector) {
    const m = g.document.querySelector('meta[name="aura-log"]');
    if (m?.content) return m.content;
  }
  return '';
}

function patternToRegExp(pat: string): RegExp {
  const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

interface ParsedEntry { neg: boolean; re: RegExp; minLevel: number }
let cachedFilter = '';
let cachedEntries: ParsedEntry[] = [];

function parse(filter: string): ParsedEntry[] {
  if (filter === cachedFilter) return cachedEntries;
  const out: ParsedEntry[] = [];
  for (const raw of filter.split(/[\s,]+/)) {
    if (!raw) continue;
    const neg = raw.startsWith('-');
    const body = neg ? raw.slice(1) : raw;
    const at = body.indexOf('@');
    let pat = body, level: LogLevel | null = null;
    if (at >= 0) {
      pat = body.slice(0, at);
      const lv = body.slice(at + 1) as LogLevel;
      if (lv in LEVEL_ORDER) level = lv;
    }
    out.push({ neg, re: patternToRegExp(pat), minLevel: level ? LEVEL_ORDER[level] : LEVEL_ORDER.debug });
  }
  cachedFilter = filter;
  cachedEntries = out;
  return out;
}

/** Returns minimum-level threshold for `namespace`, or null if disabled. */
function thresholdFor(namespace: string): number | null {
  const entries = parse(readFilter());
  let threshold: number | null = null;
  for (const e of entries) {
    if (!e.re.test(namespace)) continue;
    if (e.neg) return null;            // explicit deny wins
    // Lowest threshold wins (most permissive of the matching rules).
    if (threshold === null || e.minLevel < threshold) threshold = e.minLevel;
  }
  return threshold;
}

export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;
  const enabledAt = (level: LogLevel) => {
    const t = thresholdFor(namespace);
    return t !== null && LEVEL_ORDER[level] >= t;
  };
  const emit = (level: LogLevel, args: unknown[]) => {
    if (!enabledAt(level)) return;
    const target = level === 'debug' ? (console.debug ?? console.log)
                 : level === 'info'  ? (console.info  ?? console.log)
                 : level === 'warn'  ? console.warn
                 : level === 'error' ? console.error
                 : console.log;
    target.call(console, prefix, ...args);
  };
  return {
    debug: (...a) => emit('debug', a),
    info:  (...a) => emit('info',  a),
    log:   (...a) => emit('log',   a),
    warn:  (...a) => emit('warn',  a),
    error: (...a) => emit('error', a),
    isEnabled: (level: LogLevel = 'debug') => enabledAt(level),
    child:     (suffix) => createLogger(`${namespace}:${suffix}`),
  };
}
