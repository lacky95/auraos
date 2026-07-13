/**
 * Shared types for the OS-wide key-value store.
 *
 * Two-tier namespacing — mirrored from the user's choice during planning:
 *   • `'os'`            — OS-wide configuration. Read public by default;
 *                          writes require explicit `system.kv.os.<topic>.write`
 *                          permissions checked at the HTTP API layer.
 *   • `'app/<appId>'`   — per-app private bucket. Each app may freely
 *                          read+write its own bucket; the HTTP layer
 *                          rejects cross-app writes via Referer check.
 *
 * The namespace string is encoded into the Redis key as a colon-separated
 * prefix (`os:theme`, `app/com.aura.notepad:lastFile`). The slash inside
 * `app/<id>` is preserved because it never collides with the `:` separator.
 */

export type KvNamespace = 'os' | `app/${string}` | `context:${string}`;

/**
 * The stored shape. The shell stores values together with a wall-clock
 * timestamp so consumers can detect stale local copies after an SSE
 * drop without an extra round-trip.
 */
export interface KvValue<T = unknown> {
  value:     T;
  updatedAt: number;
}

/**
 * Whitelist regex for the `<key>` segment of the HTTP path. Allows dots,
 * hyphens, underscores, slashes for sub-paths. Disallows control chars,
 * spaces, colons (the internal separator) and anything outside ASCII.
 *
 * Exported so the HTTP layer can validate before hitting Redis.
 */
export const KV_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-\/]{0,127}$/;

/**
 * Validation regex for the namespace as it travels in the URL/HTTP body.
 * Accepts the literal `'os'` and `'app/<appId>'` where `<appId>` follows
 * the reverse-domain shape enforced by `AppManifestSchema.id`.
 */
export const KV_NAMESPACE_PATTERN = /^(?:os|app\/[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)$/;

/**
 * OS-managed **context** namespaces (env vars / secrets). Deliberately kept
 * separate from `KV_NAMESPACE_PATTERN` and colon-delimited (`context:system`,
 * `context:app:<appId>`) so it never collides with the public `os`/`app/<id>`
 * shapes. IMPORTANT: the public `/api/kv/...` proxy additionally rejects any
 * namespace beginning with `context` — these are only reachable via the
 * dedicated `/api/os/context` API and the server-internal `ContextStore`.
 */
export const KV_CONTEXT_NAMESPACE_PATTERN =
  /^context:(?:system|app:[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)$/;

export function isValidNamespace(ns: string): ns is KvNamespace {
  return KV_NAMESPACE_PATTERN.test(ns) || KV_CONTEXT_NAMESPACE_PATTERN.test(ns);
}

export function isValidKey(key: string): boolean {
  return KV_KEY_PATTERN.test(key);
}
