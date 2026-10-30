/**
 * Lifecycle handler factories — Android-`Activity` lifecycle stubs for Aura apps.
 *
 * Apps that don't override a hook get a no-op handler that just logs and returns
 * `{ ok: true }`. Apps that DO want to react pass an `impl` callback.
 *
 * Usage in `src/pages/api/lifecycle/onCreate.ts`:
 *
 *   export const POST = createLifecycleHandler('onCreate');
 *
 * Or with custom behaviour:
 *
 *   export const POST = createLifecycleHandler('onDestroy', async () => {
 *     state.activities.clear();
 *   });
 *
 * Replaces the byte-identical 5-line APIRoute every app used to copy.
 */

import type { APIRoute } from 'astro';
import { IntentRejectedError, parseIntentPayload, type IntentPayload } from './intent.js';

const APP_ID = () => process.env['APP_ID'] ?? 'unknown';
const INSTANCE_ID = () => process.env['APP_INSTANCE_ID'] ?? null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =========================================================================
//  Health
// =========================================================================

/**
 * GET /api/lifecycle/health — the OS calls this during spawn (`waitHealthy`)
 * and during reconciliation to verify the upstream is who we expect. The
 * identity body { ok, appId, instanceId } is the security contract: a port
 * squatter's reply won't match `(appId, instanceId)` and the spawn fails.
 *
 * Apps no longer ship `health.ts` — the SDK integration injects this route
 * by default. Apps that need to extend it can override their own.
 */
export function createHealthEndpoint(): APIRoute {
  return () => json({
    ok: true,
    appId: APP_ID(),
    instanceId: INSTANCE_ID(),
  });
}

// =========================================================================
//  Plain lifecycle hooks: onCreate / onStart / onResume / onPause / onStop / onDestroy
// =========================================================================

export type LifecycleHookName =
  | 'onCreate' | 'onStart' | 'onResume'
  | 'onPause'  | 'onStop'  | 'onDestroy';

/**
 * Factory for the six plain lifecycle hooks. Default behaviour: log + return
 * `{ ok: true }`. Pass `impl` to run app code; errors propagate as 500.
 */
export function createLifecycleHandler(
  hook: LifecycleHookName,
  impl?: () => void | Promise<void>,
): APIRoute {
  return async () => {
    console.log(`[${APP_ID()}] ${hook}`);
    try {
      if (impl) await impl();
    } catch (err) {
      console.error(`[${APP_ID()}] ${hook} failed:`, err);
      return json({ ok: false, error: String(err) }, 500);
    }
    return json({ ok: true });
  };
}

// =========================================================================
//  onActivityCreate — single hook, body { activityId, data? }, returns { path?, title?, metadata? }
// =========================================================================

export interface ActivityCreateRequest {
  activityId: string;
  /** Launch data — for intent launches this is `intent.extras`. */
  data?: Record<string, unknown>;
  /** Set when the activity was opened by `startIntent`. */
  intent?: IntentPayload;
  /**
   * Set when the OS recreates an activity after a restart (desktop session
   * restore): the id the activity had before, and the state the app saved for
   * it (`osClient.activity.saveState()` / `onSaveState`). `activityId` is the
   * same as `previousActivityId` when the OS could keep it.
   */
  restore?: ActivityRestore;
}

export interface ActivityRestore {
  previousActivityId: string;
  state: unknown;
}

export interface ActivityCreateResult {
  /** Initial iframe path; defaults to '/'. */
  path?: string;
  /** Optional window-title hint surfaced in the slot chrome. */
  title?: string;
  /** Free-form bag returned to the OS (currently observational only). */
  metadata?: Record<string, unknown>;
  /**
   * Intent launches only: the intent was handled without a window (Android
   * `Theme.NoDisplay`) — the OS registers no activity. Ignored for plain
   * openActivity calls, which always get their window.
   */
  noActivity?: boolean;
  /** Intent launches only: handed back to the caller as `startIntent(...).result`. */
  result?: Record<string, unknown>;
}

/**
 * Factory for `onActivityCreate`. The app's impl receives the parsed activity
 * id + launch data and may return path/title/metadata. The factory handles
 * request parsing, error catching, and JSON response shaping so the app code
 * stays a single async function.
 */
export function createActivityCreateHandler(
  impl?: (req: ActivityCreateRequest) => ActivityCreateResult | Promise<ActivityCreateResult>,
): APIRoute {
  return async ({ request }) => {
    const body = await request.json().catch(() => ({})) as Partial<ActivityCreateRequest>;
    const activityId = typeof body.activityId === 'string' ? body.activityId : '';
    if (!activityId) {
      return json({ ok: false, error: 'missing activityId' }, 400);
    }
    const data = body.data ?? undefined;
    const intent = parseIntentPayload(body.intent);
    const r = body.restore as Partial<ActivityRestore> | undefined;
    const restore = r && typeof r.previousActivityId === 'string'
      ? { previousActivityId: r.previousActivityId, state: r.state ?? null }
      : undefined;
    try {
      const result = impl ? await impl({ activityId, ...(data ? { data } : {}), ...(intent ? { intent } : {}), ...(restore ? { restore } : {}) }) : {};
      const out: ActivityCreateResult & { ok: boolean } = { ok: true, ...result };
      console.log(`[${APP_ID()}] onActivityCreate ${activityId}`);
      return json(out);
    } catch (err) {
      if (err instanceof IntentRejectedError) {
        console.warn(`[${APP_ID()}] onActivityCreate ${activityId} rejected the intent: ${err.code} — ${err.message}`);
        return json({ ok: false, rejected: err.toReply() });
      }
      console.error(`[${APP_ID()}] onActivityCreate ${activityId} failed:`, err);
      return json({ ok: false, error: String(err) }, 500);
    }
  };
}

// =========================================================================
//  onSaveState — before a planned OS restart: hand the OS each activity's state
// =========================================================================

export interface SaveStateRequest {
  /** This instance's activities the OS is about to recreate after the restart. */
  activityIds: string[];
}
export interface SaveStateResult {
  /** activityId → JSON state (≤ 64 KB each), returned as `restore.state`. */
  states: Record<string, unknown>;
}

/**
 * Factory for the optional `onSaveState` hook (POST /api/lifecycle/onSaveState).
 * Called once before a planned restart, with a short deadline (~2 s). Apps
 * that save their activity state as it changes (`osClient.activity.saveState`)
 * do not need it; it is the catch-up for state that is expensive to push on
 * every change.
 */
export function createSaveStateHandler(
  impl: (req: SaveStateRequest) => SaveStateResult | Promise<SaveStateResult>,
): APIRoute {
  return async ({ request }) => {
    const body = await request.json().catch(() => ({})) as Partial<SaveStateRequest>;
    const activityIds = Array.isArray(body.activityIds) ? body.activityIds.filter((x): x is string => typeof x === 'string') : [];
    try {
      const res = await impl({ activityIds });
      return json({ ok: true, states: res?.states ?? {} });
    } catch (err) {
      console.error(`[${APP_ID()}] onSaveState failed:`, err);
      return json({ ok: false, error: String(err) }, 500);
    }
  };
}

// =========================================================================
//  onActivityDestroy/[activityId] — dynamic route, param :activityId
// =========================================================================

/**
 * Factory for `onActivityDestroy/[activityId].ts`. Pulls the activityId out
 * of route params (URL-decoded) and forwards to the app's impl for any
 * teardown. Default impl is a no-op.
 */
export function createActivityDestroyHandler(
  impl?: (activityId: string) => void | Promise<void>,
): APIRoute {
  return async ({ params }) => {
    const raw = params['activityId'];
    const activityId = raw ? decodeURIComponent(raw) : '';
    if (!activityId) {
      return json({ ok: false, error: 'missing activityId' }, 400);
    }
    try {
      if (impl) await impl(activityId);
      console.log(`[${APP_ID()}] onActivityDestroy ${activityId}`);
      return json({ ok: true });
    } catch (err) {
      console.error(`[${APP_ID()}] onActivityDestroy ${activityId} failed:`, err);
      return json({ ok: false, error: String(err) }, 500);
    }
  };
}

// =========================================================================
//  onIntent — body { intent, newInstance }  (Android onNewIntent / onStartCommand)
// =========================================================================

export interface IntentRequest {
  intent: IntentPayload;
  /** True when this instance was spawned for this intent; false = it was already running. */
  newInstance: boolean;
}

/**
 * Factory for `src/pages/api/lifecycle/onIntent.ts`. The OS posts it on every
 * `startIntent` that resolves to this app when the app is NOT a multi-activity
 * app (activityMode='none' apps and services) — including when the instance
 * was already running. Multi-activity apps get intents in `onActivityCreate`.
 *
 *   export const POST = createIntentHandler(async ({ intent }) => {
 *     if (intent.action === 'aura.intent.action.VIEW') openUrl(String(intent.extras?.url));
 *   });
 */
export function createIntentHandler(
  impl?: (req: IntentRequest) => void | { result?: Record<string, unknown> } | Promise<void | { result?: Record<string, unknown> }>,
): APIRoute {
  return async ({ request }) => {
    const body = await request.json().catch(() => ({})) as { intent?: unknown; newInstance?: unknown };
    const intent = parseIntentPayload(body.intent);
    if (!intent) return json({ ok: false, error: 'missing intent.action' }, 400);
    try {
      const out = impl ? await impl({ intent, newInstance: body.newInstance === true }) : undefined;
      console.log(`[${APP_ID()}] onIntent ${intent.action}`);
      return json({ ok: true, ...(out && out.result ? { result: out.result } : {}) });
    } catch (err) {
      if (err instanceof IntentRejectedError) {
        console.warn(`[${APP_ID()}] onIntent ${intent.action} rejected: ${err.code} — ${err.message}`);
        return json({ ok: false, rejected: err.toReply() });
      }
      console.error(`[${APP_ID()}] onIntent ${intent.action} failed:`, err);
      return json({ ok: false, error: String(err) }, 500);
    }
  };
}
