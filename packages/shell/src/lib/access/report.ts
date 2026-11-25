import type { AccessEvent } from './types.ts';

/**
 * The aggregated access report. Every stored field is a closed label (see
 * `AccessEvent`), so a raw path, query, header, token or KV key has no way in.
 *
 *   access:report:<YYYY-MM-DD>   HASH  event key -> count, 14-day TTL
 *   access:report-samples        STREAM  the first sample of each new would-deny
 *
 * Fields starting `#` are counters about the report itself.
 */

export const MAX_REPORT_KEYS = 5000;
export const FLUSH_INTERVAL_MS = 45_000;
export const REPORT_TTL_SECONDS = 14 * 24 * 60 * 60;
export const SAMPLE_STREAM = 'access:report-samples';
export const SAMPLE_MAX = 1000;
export const reportKey = (day: string) => `access:report:${day}`;
export const reportDay = (now: number) => new Date(now).toISOString().slice(0, 10);

const FIELDS = ['surface', 'subject', 'method', 'variant', 'principal', 'appId', 'decision', 'reason', 'status', 'via'] as const;
/** `wouldEnforce` is the key's last part, `1` or `0`. Keys written before it have none and read as false. */
export type AccessReportRow = Record<(typeof FIELDS)[number], string> & { wouldEnforce: boolean; count: number };
type Row = AccessReportRow;

export const eventKey = (e: AccessEvent): string => [
  e.surface, e.subject, e.method, e.variant ?? '-', e.principal, e.appId ?? '-', e.decision, e.reason, e.status, e.via,
  e.wouldEnforce ? '1' : '0',
].join('|');

function parseKey(key: string, count: number): Row | null {
  const parts = key.split('|');
  if (parts.length !== FIELDS.length && parts.length !== FIELDS.length + 1) return null;
  const flag = parts[FIELDS.length];
  if (flag !== undefined && flag !== '0' && flag !== '1') return null;
  return { ...Object.fromEntries(FIELDS.map((f, i) => [f, parts[i]!])), wouldEnforce: flag === '1', count } as Row;
}

const isWouldDeny = (key: string): boolean => parseKey(key, 0)?.decision !== 'allow';

/** The slice of ioredis the report uses. */
export interface ReportRedis {
  pipeline(): {
    hincrby(key: string, field: string, by: number): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  xadd(...args: Array<string | number>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface AccessReportOptions {
  /** A connected client, or null: a flush then waits for the next tick. */
  redis: () => ReportRedis | null;
  now?: () => number;
  maxKeys?: number;
}

export class AccessReport {
  private counts = new Map<string, number>();
  private meta = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly opts: AccessReportOptions) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? MAX_REPORT_KEYS;
  }

  add(event: AccessEvent): void {
    this.bump(eventKey(event), 1);
  }

  /** A counter about the report: `dropped`, `early`, `event|…`, `cred|…`. */
  note(name: string, by = 1): void {
    if (by > 0) this.meta.set(name, (this.meta.get(name) ?? 0) + by);
  }

  private bump(key: string, by: number): void {
    const current = this.counts.get(key);
    if (current === undefined && this.counts.size >= this.maxKeys) {
      this.note('overflow', by);
      return;
    }
    this.counts.set(key, (current ?? 0) + by);
  }

  /** What hasn't been flushed yet. */
  pending(): { keys: number; events: number; meta: Record<string, number> } {
    let events = 0;
    for (const n of this.counts.values()) events += n;
    return { keys: this.counts.size, events, meta: Object.fromEntries(this.meta) };
  }

  start(intervalMs = FLUSH_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Write everything pending. Skipped unless Valkey is ready; a failure keeps the counts. */
  async flush(): Promise<void> {
    if (this.flushing || (this.counts.size === 0 && this.meta.size === 0)) return;
    let redis: ReportRedis | null;
    try { redis = this.opts.redis(); } catch { redis = null; }
    if (!redis) return;

    this.flushing = true;
    const counts = this.counts;
    const meta = this.meta;
    this.counts = new Map();
    this.meta = new Map();
    const entries = [...counts];
    const metaEntries = [...meta];
    const key = reportKey(reportDay(this.now()));
    let results: Array<[Error | null, unknown]> | null = null;
    try {
      const p = redis.pipeline();
      for (const [field, n] of entries) p.hincrby(key, field, n);
      for (const [field, n] of metaEntries) p.hincrby(key, `#${field}`, n);
      p.expire(key, REPORT_TTL_SECONDS);
      results = await p.exec();
    } catch {
      results = null;
    } finally {
      this.flushing = false;
    }

    if (!results) {
      for (const [field, n] of entries) this.bump(field, n);
      for (const [field, n] of metaEntries) this.note(field, n);
      return;
    }
    const fresh: string[] = [];
    entries.forEach(([field, n], i) => {
      const [err, value] = results![i] ?? [new Error('missing'), null];
      if (err) this.bump(field, n);
      else if (Number(value) === n && isWouldDeny(field)) fresh.push(field);
    });
    metaEntries.forEach(([field, n], i) => {
      if (results![entries.length + i]?.[0]) this.note(field, n);
    });
    await this.writeSamples(redis, fresh);
  }

  private async writeSamples(redis: ReportRedis, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      for (const key of keys.slice(0, SAMPLE_MAX)) {
        const row = parseKey(key, 1);
        if (!row) continue;
        const pairs = [...FIELDS.flatMap((f) => [f, row[f]]), 'wouldEnforce', String(row.wouldEnforce)];
        await redis.xadd(SAMPLE_STREAM, 'MAXLEN', '~', SAMPLE_MAX, '*', 'at', this.now(), ...pairs);
      }
      await redis.expire(SAMPLE_STREAM, REPORT_TTL_SECONDS);
    } catch { /* a lost sample is not worth retrying */ }
  }
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface ReportReader {
  hgetall(key: string): Promise<Record<string, string>>;
  xrevrange(key: string, end: string, start: string, countToken: 'COUNT', count: number): Promise<Array<[string, string[]]>>;
}

export interface AccessReportDay {
  day: string;
  rows: Row[];
  counters: Record<string, number>;
}

export async function readAccessReport(redis: ReportReader, days: number, now: number, sampleLimit = 200): Promise<{
  days: AccessReportDay[];
  samples: Array<Record<string, string>>;
}> {
  const out: AccessReportDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = reportDay(now - i * 86_400_000);
    const raw = await redis.hgetall(reportKey(day));
    const rows: Row[] = [];
    const counters: Record<string, number> = {};
    for (const [field, value] of Object.entries(raw)) {
      const n = Number(value);
      if (field.startsWith('#')) counters[field.slice(1)] = n;
      else {
        const row = parseKey(field, n);
        if (row) rows.push(row);
      }
    }
    rows.sort((a, b) => b.count - a.count);
    out.push({ day, rows, counters });
  }
  const stream = await redis.xrevrange(SAMPLE_STREAM, '+', '-', 'COUNT', sampleLimit);
  const samples = stream.map(([, pairs]) => {
    const sample: Record<string, string> = {};
    for (let i = 0; i + 1 < pairs.length; i += 2) sample[pairs[i]!] = pairs[i + 1]!;
    return sample;
  });
  return { days: out, samples };
}
