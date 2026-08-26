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
