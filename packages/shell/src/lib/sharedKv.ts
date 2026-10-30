/**
 * One long-lived KV client for the shell's hot request paths (the desktop
 * page render, /api/kv, /api/os/theme.css, the app proxy's HTML rewrite).
 *
 * `defaultKv()` builds a new KvClient — a new ioredis TCP connection — per
 * call, and every caller closes it again: a connect + QUIT round trip around
 * each single GET. KvClient only issues plain commands (no blocking reads,
 * no subscriptions), so these paths can share one connection.
 *
 * `close()` on the shared client is a no-op, so code written for
 * `defaultKv()` (try … finally close) keeps working unchanged. Pinned on
 * globalThis (survives dev-server module reloads); re-created if the KV
 * server came back on another URI.
 */
import { KvClient, kvServer } from '@aura/kv-store';

class SharedKvClient extends KvClient {
  override async close(): Promise<void> { /* shared: never closed by a caller */ }
}

const KEY = '__auraSharedKvClient';
type Pinned = { uri: string; client: SharedKvClient };

export function sharedKv(): KvClient {
  const uri = kvServer.getUri();
  if (!uri) throw new Error('[sharedKv] kvServer is not running');
  const g = globalThis as unknown as Record<string, Pinned | undefined>;
  const cur = g[KEY];
  if (cur && cur.uri === uri) return cur.client;
  const client = new SharedKvClient(uri);
  g[KEY] = { uri, client };
  return client;
}
