/**
 * The intent as the OS delivers it to a handler app — the `intent` field of
 * the `onIntent` and `onActivityCreate` lifecycle bodies. Mirrors `Intent`
 * from @aura/core. Dependency-free so both the Astro lifecycle factories and
 * the Next.js runtime adapter can share it.
 */
export interface IntentPayload {
  action:    string;
  /** Set on explicit intents: the app that was addressed directly. */
  appId?:    string;
  category?: string[];
  type?:     string;
  uri?:      string;
  extras?:   Record<string, unknown>;
}

/** Validate an untrusted `intent` field; null unless it has a string `action`. */
export function parseIntentPayload(raw: unknown): IntentPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  if (typeof action !== 'string' || action.length === 0) return null;
  const category = Array.isArray(r['category'])
    ? r['category'].filter((c): c is string => typeof c === 'string')
    : [];
  const extras = r['extras'];
  return {
    action,
    ...(typeof r['appId'] === 'string' ? { appId: r['appId'] } : {}),
    ...(category.length > 0 ? { category } : {}),
    ...(typeof r['type'] === 'string' ? { type: r['type'] } : {}),
    ...(typeof r['uri']  === 'string' ? { uri:  r['uri']  } : {}),
    ...(extras && typeof extras === 'object' && !Array.isArray(extras)
      ? { extras: extras as Record<string, unknown> }
      : {}),
  };
}
