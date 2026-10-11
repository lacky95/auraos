/**
 * Android-`<intent-filter>`-equivalent resolver.
 *
 * Apps declare zero or more `intentFilters` in their manifest. When a caller
 * issues an Intent (action + optional category/type/uri), the resolver scores
 * every registered filter and returns the ranked candidates. The OS uses the
 * top-scored handler — or surfaces a chooser if multiple share the top score.
 *
 * Scoring (compatible with Android's matching priority, but condensed):
 *   • action must equal-match. No score contribution beyond "candidate or not".
 *   • mime specificity:
 *       exact match           → +100
 *       `image/*` wildcard    →  +50
 *       `* / *` catch-all     →  +10
 *       declared but no match → filter is dropped (NOT a candidate)
 *       not declared          →   0 (mime not constraining the filter)
 *   • scheme:
 *       exact match           → +30
 *       declared but no match → filter is dropped
 *       not declared          →   0
 *   • category: each matched required category → +5. Filter declared a
 *     category the intent didn't ask for → still a candidate (Android
 *     semantics: filter categories are the set the app SUPPORTS, intent
 *     categories are the set it REQUIRES the filter to support).
 *   • manifest priority → added as-is (signed int).
 *
 * A nonzero result means "candidate". The caller decides whether to auto-pick
 * the top result, present a chooser, or remember a default.
 */

import type { AppManifest } from '../types/manifest.js';

export interface Intent {
  action:   string;
  /**
   * Explicit target (Android `Intent.setPackage`). When set, resolution and
   * the chooser are skipped and this app receives the intent directly — it
   * needs no matching `intentFilters` entry, same as Android explicit intents.
   * Unset = implicit intent, resolved against every app's filters.
   */
  appId?:   string | undefined;
  category?: string[] | undefined;
  /** Media type, e.g. `text/plain`, `image/png`. */
  type?:    string | undefined;
  /** Resource URI; the scheme is what's actually compared. */
  uri?:     string | undefined;
  /**
   * Arbitrary extras for the handler. Multi-activity handlers read them as
   * `onActivityCreate`'s `data`; every other handler (activityMode 'none',
   * services) gets them inside `onIntent`'s `intent.extras`.
   */
  extras?:  Record<string, unknown> | undefined;
  /**
   * Target one running instance of the handler app. The handler opens its
   * activity / receives `onIntent` on exactly that instance. Unknown, dead,
   * or another app's instance → `IntentError` (never a silent fallback to a
   * new instance). Mutually exclusive with the `NEW_INSTANCE` flag.
   */
  instanceId?: string | undefined;
  /**
   * Launch flags, Android `FLAG_ACTIVITY_*` style. Unknown flags are refused
   * (`IntentError`) rather than ignored, so a typo can't silently degrade.
   *   • `NEW_INSTANCE` — start a fresh instance instead of reusing one
   *     (Android `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_MULTIPLE_TASK`).
   *     Only for `instanceMode: 'multi'` apps.
   */
  flags?: string[] | undefined;
}

/** Every launch flag the OS understands (see `Intent.flags`). */
export const INTENT_FLAGS = ['NEW_INSTANCE'] as const;
export type IntentFlag = (typeof INTENT_FLAGS)[number];

/**
 * An intent the OS refuses before dispatching it: an unknown flag, an unknown
 * or dead target instance, a flag the app's manifest can't honour. `status`
 * is the HTTP status the shell API answers with.
 */
export class IntentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'IntentError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/**
 * What a handler app answers instead of handling an intent — its hook replies
 * `{ rejected: { code, message, hint?, status? } }` (the extras don't make
 * sense, or the thing they name doesn't exist). The OS then opens no activity.
 */
export interface IntentRejection {
  code:    string;
  message: string;
  hint?:   string;
  /** HTTP status for the shell API; 400–499, default 422. */
  status:  number;
}

/** Read a hook reply's `rejected` field; null when the app accepted. */
export function parseIntentRejection(reply: unknown): IntentRejection | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const r = (reply as { rejected?: unknown }).rejected;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  const st = o['status'];
  return {
    code:    typeof o['code'] === 'string' && o['code'] ? o['code'] : 'rejected',
    message: typeof o['message'] === 'string' && o['message'] ? o['message'] : 'The app rejected the intent.',
    ...(typeof o['hint'] === 'string' && o['hint'] ? { hint: o['hint'] } : {}),
    status:  typeof st === 'number' && Number.isInteger(st) && st >= 400 && st <= 499 ? st : 422,
  };
}

/**
 * Wire shape of an intent as the OS posts it to a handler app — the `intent`
 * field of `onIntent` and `onActivityCreate`. Absent fields are omitted, never
 * sent as `null`, so handlers can test with `'uri' in intent` / `intent.uri`.
 */
export interface IntentPayload {
  action:    string;
  appId?:    string;
  category?: string[];
  type?:     string;
  uri?:      string;
  extras?:   Record<string, unknown>;
  instanceId?: string;
  flags?:    string[];
}

/** Strip an `Intent` down to its JSON wire shape (see `IntentPayload`). */
export function intentPayload(intent: Intent): IntentPayload {
  return {
    action: intent.action,
    ...(intent.appId !== undefined ? { appId: intent.appId } : {}),
    ...(intent.category && intent.category.length > 0 ? { category: [...intent.category] } : {}),
    ...(intent.type   !== undefined ? { type:   intent.type }   : {}),
    ...(intent.uri    !== undefined ? { uri:    intent.uri }    : {}),
    ...(intent.extras !== undefined ? { extras: intent.extras } : {}),
    ...(intent.instanceId !== undefined ? { instanceId: intent.instanceId } : {}),
    ...(intent.flags && intent.flags.length > 0 ? { flags: [...intent.flags] } : {}),
  };
}

export interface IntentFilterDecl {
  action:     string;
  category:   string[];
  dataMime:   string[];
  dataScheme: string[];
  priority:   number;
}

export interface IntentMatch {
  appId:  string;
  filter: IntentFilterDecl;
  score:  number;
}

export class IntentResolver {
  /**
   * (appId, filter) pairs flattened across the registry, kept in index order
   * so resolution is a single O(n) pass. n is small (sum of intent-filters
   * across installed apps) — no further indexing needed in practice.
   */
  private filters: Array<{ appId: string; filter: IntentFilterDecl }> = [];

  /** Replace the index with the provided manifests' filters. */
  reload(manifests: readonly AppManifest[]): void {
    const next: typeof this.filters = [];
    for (const m of manifests) {
      for (const f of m.intentFilters) {
        next.push({ appId: m.id, filter: f });
      }
    }
    this.filters = next;
  }

  /**
   * Rank candidates for an intent. Sorted by descending score. Empty array
   * means no handler — caller should treat as `ActivityNotFoundException`.
   */
  resolve(intent: Intent): IntentMatch[] {
    const matches: IntentMatch[] = [];
    for (const { appId, filter } of this.filters) {
      if (filter.action !== intent.action) continue;
      const score = scoreFilter(filter, intent);
      if (score === null) continue;  // declared but didn't match — drop
      matches.push({ appId, filter, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }
}

/**
 * Returns the score for a filter against an intent, or `null` if the filter
 * declared a constraint (mime / scheme) the intent didn't satisfy.
 */
export function scoreFilter(filter: IntentFilterDecl, intent: Intent): number | null {
  let score = filter.priority;

  // MIME
  if (filter.dataMime.length > 0) {
    const matched = matchMime(filter.dataMime, intent.type);
    if (matched === null) return null;
    score += matched;
  }

  // Scheme
  if (filter.dataScheme.length > 0) {
    const intentScheme = parseScheme(intent.uri);
    if (intentScheme === null) return null;
    if (!filter.dataScheme.includes(intentScheme)) return null;
    score += 30;
  }

  // Category
  if (intent.category && intent.category.length > 0) {
    for (const c of intent.category) {
      if (filter.category.includes(c)) score += 5;
    }
  }

  return score;
}

/**
 * Score a list of declared MIMEs against the intent's type. Returns the best
 * matching score, or `null` if NONE matched. Intent without a type and filter
 * with declared types ⇒ no match (intent must specify what it's about).
 */
function matchMime(declared: readonly string[], intentType: string | undefined): number | null {
  if (!intentType) return null;
  const [intentMajor, intentMinor] = intentType.split('/', 2);
  if (!intentMajor || !intentMinor) return null;
  let best: number | null = null;
  for (const d of declared) {
    const [major, minor] = d.split('/', 2);
    if (!major || !minor) continue;
    let s: number | null = null;
    if (d === intentType)                              s = 100;
    else if (major === intentMajor && minor === '*')   s = 50;
    else if (major === '*' && minor === '*')           s = 10;
    if (s !== null && (best === null || s > best))     best = s;
  }
  return best;
}

function parseScheme(uri: string | undefined): string | null {
  if (!uri) return null;
  const m = uri.match(/^([a-z][a-z0-9+\-.]*):/i);
  return m ? (m[1] ?? '').toLowerCase() : null;
}
