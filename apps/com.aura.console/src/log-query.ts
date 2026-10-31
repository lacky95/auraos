// Reading and shaping the collected log for the MCP (src/mcp/logs.ts).
//
// The log is one append-only JSONL file with no rotation, so nothing here
// reads it whole: `readTailLines` opens it and reads only the last N bytes.
// Everything else is pure functions over the parsed entries, testable
// without the app.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isLogEntry, type LogEntry } from './log-server.ts';

export type { LogEntry };

export const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
export type Level = (typeof LEVELS)[number];

/** The newest entries that fit in the last `maxBytes` of the file (oldest
 *  first). `truncated` says the window started mid-file, i.e. older lines
 *  exist beyond it. A missing file is an empty log. */
export function readTailLines(path: string, maxBytes: number): { entries: LogEntry[]; truncated: boolean } {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return { entries: [], truncated: false }; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let text = buf.toString('utf-8', 0, got);
    const truncated = start > 0;
    if (truncated) {
      // The window almost surely starts inside a line: drop that partial one.
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    const entries: LogEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isLogEntry(parsed)) entries.push(parsed);
      } catch { /* a torn or foreign line: skip */ }
    }
    return { entries, truncated };
  } finally {
    closeSync(fd);
  }
}

export interface Filter {
  levels?: readonly string[];
  /** Exact `source` (an appId, or "shell"). */
  source?: string;
  /** Case-insensitive substring over source + args, or `/pattern/flags`. */
  contains?: string;
  sinceMs?: number;
  untilMs?: number;
}

/** `contains` → a predicate over one entry's searchable text. A bad regex
 *  throws a RangeError-free Error the caller can turn into bad-arguments. */
export function textMatcher(contains: string): (text: string) => boolean {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(contains);
  if (m) {
    let re: RegExp;
    try { re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i'); }
    catch (err) { throw new Error(`invalid regex ${contains}: ${(err as Error).message}`); }
    return (text) => re.test(text);
  }
  const needle = contains.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

export function searchableText(e: LogEntry): string {
  return `${e.source} ${e.args.join(' ')}`;
}

export function filterEntries(entries: readonly LogEntry[], f: Filter): LogEntry[] {
  const levels = f.levels?.length ? new Set(f.levels) : null;
  const match = f.contains ? textMatcher(f.contains) : null;
  return entries.filter((e) =>
    (!levels || levels.has(e.level)) &&
    (f.source == null || e.source === f.source) &&
    (f.sinceMs == null || e.timestamp >= f.sinceMs) &&
    (f.untilMs == null || e.timestamp <= f.untilMs) &&
    (!match || match(searchableText(e))));
}

const MAX_ARG_CHARS = 2000;

/** `2026-10-31T14:05:03.123Z WARN  [io.lakner.foo] arg1 arg2` */
export function formatEntry(e: LogEntry): string {
  const ts = Number.isFinite(e.timestamp) ? new Date(e.timestamp).toISOString() : String(e.timestamp);
  const args = e.args.map((a) => (a.length > MAX_ARG_CHARS ? a.slice(0, MAX_ARG_CHARS) + '…' : a)).join(' ');
  return `${ts} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${args}`;
}

export function formatEntries(entries: readonly LogEntry[]): string {
  return entries.map(formatEntry).join('\n');
}

export interface SourceSummary {
  source: string;
  count: number;
  byLevel: Record<string, number>;
  firstTs: number;
  lastTs: number;
}

/** Per-source counts, most recently active first. */
export function summarizeSources(entries: readonly LogEntry[]): SourceSummary[] {
  const by = new Map<string, SourceSummary>();
  for (const e of entries) {
    let s = by.get(e.source);
    if (!s) { s = { source: e.source, count: 0, byLevel: {}, firstTs: e.timestamp, lastTs: e.timestamp }; by.set(e.source, s); }
    s.count++;
    s.byLevel[e.level] = (s.byLevel[e.level] ?? 0) + 1;
    if (e.timestamp < s.firstTs) s.firstTs = e.timestamp;
    if (e.timestamp > s.lastTs) s.lastTs = e.timestamp;
  }
  return [...by.values()].sort((a, b) => b.lastTs - a.lastTs);
}

export function formatSources(rows: readonly SourceSummary[]): string {
  if (!rows.length) return '(no entries)';
  const w = Math.max(6, ...rows.map((r) => r.source.length));
  const head = `${'source'.padEnd(w)}  count  error  warn  last`;
  const lines = rows.map((r) =>
    `${r.source.padEnd(w)}  ${String(r.count).padStart(5)}  ${String(r.byLevel['error'] ?? 0).padStart(5)}  ${String(r.byLevel['warn'] ?? 0).padStart(4)}  ${new Date(r.lastTs).toISOString()}`);
  return [head, ...lines].join('\n');
}

/** "5m", "2h", "30s", "1d", an ISO date, or epoch ms → epoch ms. */
export function parseSince(value: string | number, now: number = Date.now()): number {
  if (typeof value === 'number') return value;
  const v = value.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
    return now - n * unit;
  }
  if (/^\d{10,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`cannot parse since="${value}" (use 5m, 2h, 30s, an ISO date or epoch ms)`);
  return t;
}
