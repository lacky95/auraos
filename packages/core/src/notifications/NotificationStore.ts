/**
 * Valkey layout of the notification store (central KvServer, `/data/kv`).
 *
 *   notif:item:<id>              JSON StoredNotification
 *   notif:idx:all                ZSET  id → createdAt
 *   notif:idx:active             ZSET  id → createdAt   (state === 'active')
 *   notif:idx:sender:<senderKey> ZSET  id → createdAt
 *   notif:idx:expiry             ZSET  id → expiresAt   (active with a timeout)
 *   notif:idx:ended              ZSET  id → endedAt     (resolved / removed; phase 5
 *                                                        retention deletes from here)
 *   notif:meta:endedBackfill     "1" once the ended index was backfilled
 *   notif:events                 STREAM {id, event, state, at}, MAXLEN ~ 10000
 *
 * `notif:` is not a valid KvClient namespace, so the public `/api/kv` proxy
 * cannot read or write any of this.
 *
 * Every mutation is ONE `MULTI`: item + indexes + stream entry land together.
 * Read-modify-write serialisation is the caller's job (NotificationService
 * holds a per-id lock; the shell is the only writer).
 */
import type { Redis } from '@aura/kv-store';
import type { LifecycleEvent, LifecycleEventName, NotificationState, StoredNotification } from './types.js';

export const NOTIF_PREFIX = 'notif:';
export const KEY_ALL = 'notif:idx:all';
export const KEY_ACTIVE = 'notif:idx:active';
export const KEY_EXPIRY = 'notif:idx:expiry';
export const KEY_EVENTS = 'notif:events';
export const KEY_ENDED = 'notif:idx:ended';
export const KEY_ENDED_BACKFILL = 'notif:meta:endedBackfill';
export const EVENTS_MAXLEN = 10_000;
export const itemKey = (id: string) => `notif:item:${id}`;
export const senderIndexKey = (senderKey: string) => `notif:idx:sender:${senderKey}`;

export type RedisProvider = () => Redis;

/** Compare two stream ids (`<ms>-<seq>`). */
export function compareStreamIds(a: string, b: string): number {
  const [am = '0', as = '0'] = a.split('-');
  const [bm = '0', bs = '0'] = b.split('-');
  const d = BigInt(am) - BigInt(bm);
  if (d !== 0n) return d < 0n ? -1 : 1;
  const e = BigInt(as) - BigInt(bs);
  return e === 0n ? 0 : e < 0n ? -1 : 1;
}

export function isStreamId(s: string): boolean {
  return /^\d{1,20}-\d{1,20}$/.test(s);
}

function fieldsToEvent(eventId: string, fields: string[]): LifecycleEvent {
  const m: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) m[fields[i]!] = fields[i + 1]!;
  return {
    eventId,
    id: m['id'] ?? '',
    event: (m['event'] ?? 'updated') as LifecycleEventName,
    state: (m['state'] ?? 'active') as NotificationState,
    at: Number(m['at'] ?? 0),
  };
}

/** When an item ended (resolved / removed), or null while active. */
export function endedAtOf(rec: Pick<StoredNotification, 'state' | 'removedAt' | 'resolvedAt' | 'updatedAt'>): number | null {
  if (rec.state === 'active') return null;
  if (rec.state === 'removed') return rec.removedAt ?? rec.updatedAt;
  return rec.resolvedAt ?? rec.updatedAt;
}

/** Read-time normalisation of older records (phase 6: scope 'desktop' → 'system'). */
export function normalizeStored(rec: StoredNotification): StoredNotification {
  if ((rec.scope as string) === 'desktop') rec.scope = 'system';
  return rec;
}

export class NotificationStore {
  constructor(private readonly redis: RedisProvider) {}

  async load(id: string): Promise<StoredNotification | null> {
    const raw = await this.redis().get(itemKey(id));
    if (!raw) return null;
    try { return normalizeStored(JSON.parse(raw) as StoredNotification); } catch { return null; }
  }

  /**
   * Phase 6 rename (once, idempotent): active items stored with
   * `scope:'desktop'` are rewritten as `scope:'system'` (the item only —
   * indexes and history are unchanged). Returns how many.
   */
  async migrateLegacyScope(): Promise<number> {
    const r = this.redis();
    const ids = await r.zrange(KEY_ACTIVE, 0, -1);
    let n = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const raws = await r.mget(...batch.map(itemKey));
      for (const raw of raws) {
        if (!raw) continue;
        let rec: StoredNotification;
        try { rec = JSON.parse(raw) as StoredNotification; } catch { continue; }
        if ((rec.scope as string) !== 'desktop') continue;
        await r.set(itemKey(rec.id), JSON.stringify(normalizeStored(rec)));
        n++;
      }
    }
    return n;
  }

  async loadMany(ids: string[]): Promise<StoredNotification[]> {
    if (ids.length === 0) return [];
    const raws = await this.redis().mget(...ids.map(itemKey));
    const out: StoredNotification[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      try { out.push(normalizeStored(JSON.parse(raw) as StoredNotification)); } catch { /* skip corrupt */ }
    }
    return out;
  }

  /**
   * Persist `rec` with all its index memberships and append one lifecycle
   * event — atomically. Returns the event (with its stream id).
   */
  async write(rec: StoredNotification, event: LifecycleEventName, at: number): Promise<LifecycleEvent> {
    const m = this.redis().multi();
    m.set(itemKey(rec.id), JSON.stringify(rec));
    m.zadd(KEY_ALL, rec.createdAt, rec.id);
    m.zadd(senderIndexKey(rec.senderKey), rec.createdAt, rec.id);
    if (rec.state === 'active') m.zadd(KEY_ACTIVE, rec.createdAt, rec.id);
    else m.zrem(KEY_ACTIVE, rec.id);
    if (rec.state === 'active' && rec.expiresAt !== undefined) m.zadd(KEY_EXPIRY, rec.expiresAt, rec.id);
    else m.zrem(KEY_EXPIRY, rec.id);
    // Phase 5: ended items wait in `ended` for the retention sweep.
    const endedAt = endedAtOf(rec);
    if (endedAt !== null) m.zadd(KEY_ENDED, endedAt, rec.id);
    else m.zrem(KEY_ENDED, rec.id);
    m.xadd(KEY_EVENTS, 'MAXLEN', '~', EVENTS_MAXLEN, '*',
      'id', rec.id, 'event', event, 'state', rec.state, 'at', String(at));
    const res = await m.exec();
    if (!res) throw new Error('[notifications] MULTI aborted');
    for (const [err] of res) if (err) throw err;
    const last = res[res.length - 1];
    const eventId = String(last?.[1] ?? '');
    return { eventId, id: rec.id, event, state: rec.state, at };
  }

  /**
   * Page through a ZSET newest-first. `cursor` is the last item of the
   * previous page (`<score>:<id>`); ties on score are ordered by id
   * (descending), matching ZREVRANGE.
   */
  async *iterateDesc(key: string, cursor?: { score: number; id: string }, batch = 100): AsyncGenerator<{ id: string; score: number }> {
    const max = cursor ? String(cursor.score) : '+inf';
    let offset = 0;
    for (;;) {
      const flat = await this.redis().zrevrangebyscore(key, max, '-inf', 'WITHSCORES', 'LIMIT', offset, batch);
      if (flat.length === 0) return;
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const id = flat[i]!;
        const score = Number(flat[i + 1]);
        if (cursor && score === cursor.score && id >= cursor.id) continue;
        yield { id, score };
      }
      if (flat.length / 2 < batch) return;
      offset += batch;
    }
  }

  /**
   * Delete items for good (retention / clear history): item JSON and every
   * index membership, in one MULTI. The history lives in the item, so it
   * goes with it. Stream entries stay (content-free ids; trimmed by MAXLEN).
   */
  async deleteItems(items: Array<{ id: string; senderKey?: string }>): Promise<number> {
    if (items.length === 0) return 0;
    const m = this.redis().multi();
    const delAt: number[] = [];
    let k = 0;
    for (const it of items) {
      delAt.push(k);
      m.del(itemKey(it.id));
      m.zrem(KEY_ALL, it.id);
      m.zrem(KEY_ACTIVE, it.id);
      m.zrem(KEY_EXPIRY, it.id);
      m.zrem(KEY_ENDED, it.id);
      k += 5;
      if (it.senderKey) { m.zrem(senderIndexKey(it.senderKey), it.id); k++; }
    }
    const res = await m.exec();
    if (!res) throw new Error('[notifications] MULTI aborted');
    for (const [err] of res) if (err) throw err;
    return delAt.filter((i) => res[i]?.[1] === 1).length;
  }

  /** Drop index entries whose item no longer exists (list's safety net). */
  async pruneDangling(ids: string[], indexKey?: string): Promise<void> {
    if (ids.length === 0) return;
    const m = this.redis().multi();
    for (const id of ids) {
      m.zrem(KEY_ALL, id);
      m.zrem(KEY_ACTIVE, id);
      m.zrem(KEY_EXPIRY, id);
      m.zrem(KEY_ENDED, id);
      if (indexKey) m.zrem(indexKey, id);
    }
    await m.exec();
  }

  /** Ended ids with endedAt < `before`, oldest first. */
  async endedBefore(before: number, max = 500): Promise<Array<{ id: string; endedAt: number }>> {
    const flat = await this.redis().zrangebyscore(KEY_ENDED, '-inf', `(${before}`, 'WITHSCORES', 'LIMIT', 0, max);
    const out: Array<{ id: string; endedAt: number }> = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push({ id: flat[i]!, endedAt: Number(flat[i + 1]) });
    return out;
  }

  /**
   * One-time migration: put every already-ended item into `ended` (items
   * from before phase 5 were never indexed there). Idempotent; marks itself
   * done in `notif:meta:endedBackfill`.
   */
  async backfillEnded(): Promise<number | null> {
    const r = this.redis();
    if (await r.get(KEY_ENDED_BACKFILL)) return null;
    let n = 0;
    let batch: string[] = [];
    const flush = async () => {
      const recs = await this.loadMany(batch);
      batch = [];
      const m = r.multi();
      let any = false;
      for (const rec of recs) {
        const at = endedAtOf(rec);
        if (at === null) continue;
        m.zadd(KEY_ENDED, 'NX', at, rec.id);
        any = true;
        n++;
      }
      if (any) await m.exec();
    };
    for await (const e of this.iterateDesc(KEY_ALL)) {
      batch.push(e.id);
      if (batch.length >= 200) await flush();
    }
    if (batch.length) await flush();
    await r.set(KEY_ENDED_BACKFILL, '1');
    return n;
  }

  /** Ids whose expiresAt ≤ now. */
  async expiredIds(now: number, max = 500): Promise<string[]> {
    return this.redis().zrangebyscore(KEY_EXPIRY, '-inf', String(now), 'LIMIT', 0, max);
  }

  /** Oldest and newest stream ids, or null when the stream is empty. */
  async eventBounds(): Promise<{ first: string; last: string } | null> {
    const r = this.redis();
    const [first] = await r.xrange(KEY_EVENTS, '-', '+', 'COUNT', 1);
    const [last] = await r.xrevrange(KEY_EVENTS, '+', '-', 'COUNT', 1);
    if (!first || !last) return null;
    return { first: first[0], last: last[0] };
  }

  /**
   * Events strictly after `sinceId`, oldest first.
   * `reset: true` when `sinceId` is older than the trimmed stream (or newer
   * than anything in it, e.g. after a wipe) — the client must reload the
   * full list instead of trusting a partial catch-up.
   */
  async eventsSince(sinceId: string, max = 1000): Promise<{ events: LifecycleEvent[]; reset: boolean }> {
    const bounds = await this.eventBounds();
    if (!bounds) return { events: [], reset: true };
    // Conservative: if the id itself was trimmed we can't prove nothing
    // after it was trimmed too.
    if (compareStreamIds(sinceId, bounds.first) < 0) return { events: [], reset: true };
    if (compareStreamIds(sinceId, bounds.last) > 0) return { events: [], reset: true };
    const raw = await this.redis().xrange(KEY_EVENTS, `(${sinceId}`, '+', 'COUNT', max);
    const events = raw.map(([eid, fields]) => fieldsToEvent(eid, fields));
    return { events, reset: false };
  }
}
