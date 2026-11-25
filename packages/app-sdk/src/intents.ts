/**
 * `osClient.intents`: start an intent (Android `startActivity(intent)`).
 *
 * Implicit (no `appId`): the OS picks the highest-scored handler from the
 * declared `intentFilters` of every installed app. Explicit (`appId` set):
 * that app gets the intent directly. The answer is the OS's verdict: one
 * handler started, a disambiguation list, or `noHandler`. The handler gets the
 * whole intent: multi-activity apps in `onActivityCreate` (`data` = extras),
 * everything else in `onIntent` (see `createIntentHandler`).
 * `intentDelivered` is false when the handler has no such hook.
 *
 * Throws OsError on transport errors and refusals; HTTP 404 (no handler) is
 * `{ kind: 'noHandler' }`, and a handler declining is `{ kind: 'rejected' }`.
 * `OsClient.startIntent` is a deprecated alias.
 */
import { OsError, statusCode } from './errors.js';
import { osAuthHeaders } from './os-auth.js';

export interface StartIntent {
  action:    string;
  /** Explicit target app (Android `setPackage`): skips resolution + chooser; no filter needed. */
  appId?:    string;
  category?: string[];
  type?:     string;
  uri?:      string;
  extras?:   Record<string, unknown>;
  /** Deliver to exactly this running instance of the app (unknown/dead → error). */
  instanceId?: string;
  /** Launch flags: `NEW_INSTANCE` starts a fresh instance (multi-instance apps only). */
  flags?:    string[];
}

export type StartIntentResult =
  | { kind: 'started'; appId: string; instanceId: string; activityId?: string; intentDelivered?: boolean; result?: Record<string, unknown> }
  | { kind: 'rejected'; appId: string; instanceId: string; code: string; message: string; hint?: string; status: number }
  | { kind: 'disambiguation'; candidates: Array<{ appId: string; score: number }> }
  | { kind: 'noHandler' };

export class IntentsApi {
  constructor(private readonly base: () => string) {}

  async start(intent: StartIntent): Promise<StartIntentResult> {
    const url = `${this.base()}/api/intents/start`;
    // Server side, the instance token says which app asks (OPEN_TERMINAL grants, D29).
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...osAuthHeaders(url) },
      body: JSON.stringify(intent),
    });
    const body = await res.json().catch(() => null) as { kind?: string; error?: string; code?: string; hint?: string } | null;
    // The handler declining is an answer, not a failure — whatever status it chose.
    if (body?.kind === 'rejected') return body as StartIntentResult;
    if (res.status === 404 && body?.kind !== 'error') return { kind: 'noHandler' };
    if (!res.ok) {
      const detail = body?.error ? `: ${body.code ? `${body.code} — ` : ''}${body.error}${body.hint ? ` (${body.hint})` : ''}` : '';
      throw new OsError(res.status, body?.code ?? statusCode(res.status), `startIntent: HTTP ${res.status}${detail}`);
    }
    return body as StartIntentResult;
  }
}
