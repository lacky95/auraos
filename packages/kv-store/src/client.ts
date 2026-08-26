/**
 * Server-side KV client. Lives inside the shell process; API routes
 * import it to read + write Valkey. The browser does NOT touch this
 * class — it goes through the shell's HTTP `/api/kv/...` endpoints.
 *
 * Wraps `ioredis` so we can swap implementations later (a standalone
 * Valkey, cluster mode, etc.) without rewriting consumers. Valkey speaks
 * the Redis wire protocol, so ioredis is the right client either way.
 */

// `ioredis` is named for the protocol, not the server — it drives Valkey
// unchanged, and `redis://` stays the correct URI scheme.
import { Redis } from 'ioredis';
import { isValidKey, isValidNamespace, type KvNamespace, type KvValue } from './types.js';

export class KvClient {
  private redis: Redis;

  constructor(uri: string) {
    // Lazy connect — ioredis auto-connects on first command. We pass
    // `lazyConnect: false` (the default) so the first GET/SET goes
    // through immediately; reconnection is handled by ioredis internally.
    this.redis = new Redis(uri, {
      // Retry strategy: exponential backoff capped at 2s. The shell's
      // own restart will outlive a Valkey hiccup, so we want commands to
      // queue + retry rather than throw mid-handler.
      retryStrategy: (times) => Math.min(times * 100, 2000),
      maxRetriesPerRequest: 5,
    });
  }

  private compose(ns: KvNamespace | string, key: string): string {
    if (!isValidNamespace(ns)) {
      throw new Error(`[KvClient] invalid namespace: ${ns}`);
    }
    if (!isValidKey(key)) {
      throw new Error(`[KvClient] invalid key: ${key}`);
    }
    return `${ns}:${key}`;
  }

  /** Read a value. Returns `null` if the key is absent. */
  async get<T = unknown>(ns: KvNamespace | string, key: string): Promise<KvValue<T> | null> {
    const raw = await this.redis.get(this.compose(ns, key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as KvValue<T>;
    } catch (err) {
      // A non-JSON value is a sign someone wrote to the same key via
      // raw Valkey — surface loudly. Better to throw than silently
      // return wrong-shaped data.
      throw new Error(`[KvClient] non-JSON value at ${ns}:${key}: ${(err as Error).message}`);
    }
  }

  /** Read just the inner value (`null` if absent). Helper for the common case. */
  async getValue<T = unknown>(ns: KvNamespace | string, key: string): Promise<T | null> {
    const entry = await this.get<T>(ns, key);
    return entry ? entry.value : null;
  }

  /** Write a value. Wraps in `KvValue` with the current timestamp. */
  async set<T = unknown>(ns: KvNamespace | string, key: string, value: T): Promise<KvValue<T>> {
    const entry: KvValue<T> = { value, updatedAt: Date.now() };
    await this.redis.set(this.compose(ns, key), JSON.stringify(entry));
    return entry;
  }

  async del(ns: KvNamespace | string, key: string): Promise<boolean> {
    const removed = await this.redis.del(this.compose(ns, key));
    return removed > 0;
  }

  async exists(ns: KvNamespace | string, key: string): Promise<boolean> {
    const n = await this.redis.exists(this.compose(ns, key));
    return n > 0;
  }

  /**
   * List every key in a namespace. The HTTP layer caps this with a
   * `limit` arg so a runaway scan can't lock up the shell — Valkey
   * `SCAN` is cursor-based but we still don't want to dump 100k keys.
   */
  async list(ns: KvNamespace | string, opts: { limit?: number } = {}): Promise<string[]> {
    if (!isValidNamespace(ns)) throw new Error(`[KvClient] invalid namespace: ${ns}`);
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const prefix = `${ns}:`;
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      for (const k of batch) {
        out.push(k.slice(prefix.length));
        if (out.length >= limit) return out;
      }
      cursor = next;
    } while (cursor !== '0');
    return out;
  }

  /** Close the connection. Safe to call multiple times. */
  async close(): Promise<void> {
    try { await this.redis.quit(); } catch { /* already disconnected */ }
  }
}
