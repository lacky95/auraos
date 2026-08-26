/**
 * Browser-side client for the OS-wide KV store. Wraps the shell's
 * `/api/kv/<ns>/<key>` HTTP API with:
 *   • Typed JSON marshalling.
 *   • Boot-race retry on 404 (the shell's middleware ensures Valkey is up
 *     before any request returns, but cold-page-load can still race the
 *     soft-restart singleton reset).
 *   • SSE subscription helper for live updates.
 *
 * Server-side code (Astro API routes) MUST use `@aura/kv-store` directly
 * via `defaultKv()` — same process, no HTTP overhead.
 */

export interface KvValue<T = unknown> {
  value:     T;
  updatedAt: number;
}

const BASE = '/api/kv';

async function fetchWithRetry(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetch(url, init);
    // Retry the boot-race 404 (singleton missing). Other 4xx are real errors.
    if (last.status !== 404 || i === attempts - 1) return last;
    const body = await last.clone().text().catch(() => '');
    if (!body.includes('AppManager') && !body.includes('No value')) return last;
    await new Promise((r) => setTimeout(r, 200 + i * 200));
  }
  return last!;
}

function path(namespace: string, key: string): string {
  // `app/<id>` keeps its slash literally; the route at `[...path].ts` parses
  // it. Encode each segment individually so dots and dashes pass through.
  const segs = namespace.split('/').concat(key.split('/'));
  return `${BASE}/${segs.map(encodeURIComponent).join('/')}`;
}

export async function getKv<T = unknown>(namespace: string, key: string): Promise<KvValue<T> | null> {
  const res = await fetchWithRetry(path(namespace, key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`[kv] GET ${namespace}/${key} → HTTP ${res.status}`);
  return (await res.json()) as KvValue<T>;
}

/** Convenience: just the inner value. */
export async function getKvValue<T = unknown>(namespace: string, key: string): Promise<T | null> {
  const entry = await getKv<T>(namespace, key);
  return entry ? entry.value : null;
}

export async function setKv<T = unknown>(namespace: string, key: string, value: T): Promise<KvValue<T>> {
  const res = await fetchWithRetry(path(namespace, key), {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`[kv] PUT ${namespace}/${key} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as KvValue<T>;
}

export async function delKv(namespace: string, key: string): Promise<boolean> {
  const res = await fetchWithRetry(path(namespace, key), { method: 'DELETE' });
  if (!res.ok) throw new Error(`[kv] DELETE ${namespace}/${key} → HTTP ${res.status}`);
  const body = await res.json() as { removed?: boolean };
  return body.removed === true;
}

/**
 * Subscribe to KV change events over the shell's SSE feed. The callback
 * fires for every `kv:changed` event that matches the optional filter.
 * Returns an unsubscribe function.
 *
 * The shell already de-dupes the SSE connection via topic filters
 * (`?topics=kv:*`), so opening multiple subscribers in the same page
 * is cheap — they share the underlying EventSource at the network
 * layer's keep-alive level.
 */
export interface KvChangeEvent {
  type:      'kv:changed';
  namespace: string;
  key:       string;
  value:     unknown | null;
}
export function subscribeKv(
  filter: { namespace?: string; key?: string },
  cb:     (ev: KvChangeEvent) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  // Dynamic import keeps kvClient usable in SSR without dragging socket.io
  // into the server bundle of this module.
  const off = { current: () => undefined as void };
  void import('./osEvents.ts').then(({ osEvents }) => {
    off.current = osEvents.subscribe('kv:changed', (ev) => {
      const parsed = ev as unknown as KvChangeEvent;
      if (parsed.type !== 'kv:changed') return;
      if (filter.namespace && parsed.namespace !== filter.namespace) return;
      if (filter.key       && parsed.key       !== filter.key)       return;
      cb(parsed);
    });
  });
  return () => off.current();
}
