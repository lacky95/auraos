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
  data?: Record<string, unknown>;
}

export interface ActivityCreateResult {
  /** Initial iframe path; defaults to '/'. */
  path?: string;
  /** Optional window-title hint surfaced in the slot chrome. */
  title?: string;
  /** Free-form bag returned to the OS (currently observational only). */
  metadata?: Record<string, unknown>;
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
    try {
      const result = impl ? await impl({ activityId, ...(data ? { data } : {}) }) : {};
      const out: ActivityCreateResult & { ok: boolean } = { ok: true, ...result };
      console.log(`[${APP_ID()}] onActivityCreate ${activityId}`);
      return json(out);
    } catch (err) {
      console.error(`[${APP_ID()}] onActivityCreate ${activityId} failed:`, err);
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
