export { KvServer, kvServer } from './server.js';
export type { KvServerOpts } from './server.js';
export { KvClient } from './client.js';
export {
  isValidKey,
  isValidNamespace,
  KV_KEY_PATTERN,
  KV_NAMESPACE_PATTERN,
  KV_CONTEXT_NAMESPACE_PATTERN,
} from './types.js';
export type { KvNamespace, KvValue } from './types.js';

/**
 * Build a `KvClient` against the singleton `KvServer` URI. Throws if the
 * server hasn't been started yet — call `kvServer.start(...)` once in
 * shell init before any consumer constructs a client.
 *
 * Each call returns a NEW client (so individual API handlers can hold
 * their own connection without sharing socket state). ioredis maintains
 * one TCP connection per server though, so the cost is just an
 * extra event-emitter not an extra socket.
 */
import { kvServer } from './server.js';
import { KvClient } from './client.js';
export function defaultKv(): KvClient {
  const uri = kvServer.getUri();
  if (!uri) {
    throw new Error('[kv-store] kvServer is not running — call kvServer.start() before defaultKv()');
  }
  return new KvClient(uri);
}

/**
 * Raw ioredis access for server-internal stores that need data structures
 * `KvClient` deliberately doesn't expose (ZSETs, streams, MULTI) — e.g. the
 * notification store in `@aura/core`. Such stores use their own key prefix
 * (`notif:` …) that is NOT a valid `KvNamespace`, so the public `/api/kv`
 * proxy (which only takes `isValidNamespace` namespaces) can never reach
 * them.
 *
 * `defaultRedis()` returns ONE shared, lazily-created connection on the
 * singleton `KvServer` URI (pinned on globalThis so soft-restarts reuse it;
 * re-created if the server came back on a different port). Use
 * `createRedis()` for a dedicated connection — required for blocking
 * commands (XREAD BLOCK) or anything that must not share a socket.
 */
import { Redis } from 'ioredis';
export type { Redis } from 'ioredis';

const REDIS_GLOBAL_KEY = '__auraKvSharedRedis';
type GlobalWithRedis = typeof globalThis & { [REDIS_GLOBAL_KEY]?: { uri: string; redis: Redis } };

function requireUri(): string {
  const uri = kvServer.getUri();
  if (!uri) throw new Error('[kv-store] kvServer is not running — call kvServer.start() first');
  return uri;
}

/** A NEW dedicated ioredis connection. Defaults to the singleton server's URI. */
export function createRedis(uri: string = requireUri()): Redis {
  return new Redis(uri, {
    retryStrategy: (times) => Math.min(times * 100, 2000),
    maxRetriesPerRequest: 5,
  });
}

/** The shared ioredis connection on the singleton `KvServer`. Do not `quit()` it. */
export function defaultRedis(): Redis {
  const uri = requireUri();
  const g = globalThis as GlobalWithRedis;
  const cur = g[REDIS_GLOBAL_KEY];
  if (cur && cur.uri === uri) return cur.redis;
  if (cur) cur.redis.disconnect();
  const redis = createRedis(uri);
  g[REDIS_GLOBAL_KEY] = { uri, redis };
  return redis;
}
