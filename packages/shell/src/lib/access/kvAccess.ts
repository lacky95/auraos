/**
 * Who may read a KV namespace: `os` is readable by every app, `app/<id>` only
 * by that app. The KV route and the app event views both ask here, so a
 * value can't reach a caller over the event stream that the route would refuse.
 */
export const kvReadAllowed = (namespace: string, callerAppId: string): boolean =>
  namespace === 'os' || namespace === `app/${callerAppId}`;

/**
 * The `os` keys whose changes an app's event view carries (`kv:changed`):
 * the desktop preferences an app follows to look and behave like the rest of
 * the OS. An allowlist, so a new `os` key (the lock screen, workspaces and
 * their windows, notification settings, Nexus sources, ...) stays out of
 * every app's stream until it is added here.
 */
export const OS_KV_EVENT_KEYS: ReadonlySet<string> = new Set(['theme', 'keymap', 'clockFormat', 'locale', 'timeZone']);

/** Whether an app's event view carries `kv:changed` for this key. */
export const kvEventAllowed = (namespace: string, key: unknown, callerAppId: string): boolean =>
  namespace === 'os'
    ? typeof key === 'string' && OS_KV_EVENT_KEYS.has(key)
    : kvReadAllowed(namespace, callerAppId);
