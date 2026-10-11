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
  /** Set when the caller targeted this instance explicitly. */
  instanceId?: string;
  /** Launch flags the caller sent, e.g. `['NEW_INSTANCE']`. */
  flags?:    string[];
}

/**
 * Decline an intent from a handler (`createActivityCreateHandler`,
 * `createIntentHandler`): throw this and the OS opens no activity, stops an
 * instance it started just for this intent, and answers the caller with
 * `{ kind: 'rejected', code, message, hint }` at HTTP `status` (default 422).
 * Throw it for bad extras or ids that name nothing — never fall back to
 * doing something else silently.
 */
export class IntentRejectedError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number;
  constructor(code: string, message: string, opts: { hint?: string; status?: number } = {}) {
    super(message);
    this.name = 'IntentRejectedError';
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status ?? 422;
  }
  /** The `rejected` field of the hook reply. */
  toReply(): { code: string; message: string; hint?: string; status: number } {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}), status: this.status };
  }
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
  const flags = Array.isArray(r['flags']) ? r['flags'].filter((f): f is string => typeof f === 'string') : [];
  return {
    action,
    ...(typeof r['appId'] === 'string' ? { appId: r['appId'] } : {}),
    ...(category.length > 0 ? { category } : {}),
    ...(typeof r['type'] === 'string' ? { type: r['type'] } : {}),
    ...(typeof r['uri']  === 'string' ? { uri:  r['uri']  } : {}),
    ...(extras && typeof extras === 'object' && !Array.isArray(extras)
      ? { extras: extras as Record<string, unknown> }
      : {}),
    ...(typeof r['instanceId'] === 'string' ? { instanceId: r['instanceId'] } : {}),
    ...(flags.length > 0 ? { flags } : {}),
  };
}
