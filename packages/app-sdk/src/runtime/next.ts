/**
 * Next.js runtime adapter for AuraOS apps that opt into `manifest.runtime: 'raw'`.
 *
 * Aura's AppManager calls a small HTTP contract on every app instance:
 *   • POST /api/lifecycle/{onCreate,onStart,onResume,onPause,onStop,onDestroy}
 *   • GET  /api/lifecycle/health           (with identity in the body)
 *   • POST /api/lifecycle/onActivityCreate (activity-mode apps only)
 *   • POST /api/lifecycle/onActivityDestroy/[activityId]
 *   • POST /api/lifecycle/onIntent         (non-multi-activity apps + services)
 *   • POST /api/lifecycle/onSaveState      (optional, before a planned restart)
 *
 * Both factories refuse a call without the kernel's lifecycle token with 401
 * before any hook runs (see ./lifecycle-guard); health still answers a probe
 * that sends no token.
 *
 * Astro apps get this for free via `auraAppIntegration()` + the `createLifecycleHandler`
 * factories in `../lifecycle.ts`. Next.js apps don't have an integration, so this
 * file ships three thin factories that match the App Router's Route Handler shape
 * (and one helper for response-header middleware).
 *
 * Usage in a Next.js 13+ app:
 *
 *   // app/api/lifecycle/[...hook]/route.ts
 *   import { createNextLifecycleRoutes } from '@aura/app-sdk/runtime/next';
 *   export const { POST } = createNextLifecycleRoutes({ onDestroy: async () => …  });
 *
 *   // app/api/lifecycle/health/route.ts
 *   import { createNextHealthRoute } from '@aura/app-sdk/runtime/next';
 *   export const { GET } = createNextHealthRoute();
 *
 *   // middleware.ts
 *   import { NextResponse, type NextRequest } from 'next/server';
 *   import { auraIdentityHeaders } from '@aura/app-sdk/runtime/next';
 *   export function middleware(_req: NextRequest) {
 *     const res = NextResponse.next();
 *     for (const [k, v] of Object.entries(auraIdentityHeaders())) res.headers.set(k, v);
 *     return res;
 *   }
 *   export const config = { matcher: '/(.*)' };
 *
 * Implementation note: we deliberately do NOT take a runtime dependency on `next`.
 * The Route Handler signature `(req: Request, ctx: { params: ... }) => Response` is
 * web-standard; the middleware helper returns plain header pairs the caller stamps
 * onto whichever NextResponse they construct.
 */

import { parseIntentPayload, type IntentPayload } from '../intent.js';
import { lifecycleContextOf, type LifecycleContext, type SaveStateRequest, type SaveStateResult } from '../lifecycle.js';
import { LIFECYCLE_TOKEN_HEADER, lifecycleRefusalResponse, lifecycleRequestRefused } from './lifecycle-guard.js';
export type { IntentPayload } from '../intent.js';
export type { LifecycleContext, SaveStateRequest, SaveStateResult } from '../lifecycle.js';

/** The shared pre-handler check: a 401 response, or null to go on. */
function refused(request: Request): Response | null {
  return lifecycleRequestRefused(new URL(request.url).pathname, request.headers.get(LIFECYCLE_TOKEN_HEADER))
    ? lifecycleRefusalResponse()
    : null;
}

const APP_ID = () => process.env['APP_ID'] ?? 'unknown';
const INSTANCE_ID = () => process.env['APP_INSTANCE_ID'] ?? null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =========================================================================
//  Identity headers (for middleware.ts)
// =========================================================================

/**
 * Header pairs every raw-mode app should stamp onto its responses. The shell's
 * identity gate (the App Host router, `server/app-hosts.mjs`, and the machine
 * path `/api/proxy/<id>`) verifies these match the resolved instance — without
 * the headers the gate is silently bypassed, which works at first but breaks
 * the moment a port gets reused after a crash.
 *
 * `process.env.APP_ID` + `APP_INSTANCE_ID` are set by the runner at spawn
 * (see `ProotRunner.ts:132–149`). If they're unset (e.g. running the app
 * standalone outside Aura) the headers fall back to placeholders that won't
 * match anything — the gate is permissive in that case.
 */
export function auraIdentityHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  const appId = APP_ID();
  const instanceId = INSTANCE_ID();
  if (appId && appId !== 'unknown') out['X-Aura-App-Id'] = appId;
  if (instanceId) out['X-Aura-Instance-Id'] = instanceId;
  return out;
}

// =========================================================================
//  Lifecycle catch-all (POST /api/lifecycle/[...hook])
// =========================================================================

export type LifecycleHookName =
  | 'onCreate' | 'onStart' | 'onResume'
  | 'onPause'  | 'onStop'  | 'onDestroy';

export interface ActivityCreateRequest {
  activityId: string;
  data?: Record<string, unknown>;
  intent?: IntentPayload;
}

export interface IntentRequest {
  intent: IntentPayload;
  newInstance: boolean;
}

export interface ActivityCreateResult {
  path?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

/** A plain hook; stop hooks get `ctx.reason` (`user` | `restart`) from the kernel. */
type PlainHook = (ctx: LifecycleContext) => void | Promise<void>;

export interface NextLifecycleImpl {
  onCreate?: PlainHook;
  onStart?:  PlainHook;
  onResume?: PlainHook;
  onPause?:  PlainHook;
  onStop?:   PlainHook;
  onDestroy?: PlainHook;
  /** Optional handler for `onActivityCreate`. Return path/title/metadata. */
  onActivityCreate?: (req: ActivityCreateRequest) => ActivityCreateResult | Promise<ActivityCreateResult>;
  /** Optional handler for `onActivityDestroy/[activityId]`. */
  onActivityDestroy?: (activityId: string) => void | Promise<void>;
  /** Optional handler for `onIntent` (Android onNewIntent / onStartCommand). */
  onIntent?: (req: IntentRequest) => void | Promise<void>;
  /** Optional handler for `onSaveState` (before a planned restart). Return each activity's state. */
  onSaveState?: (req: SaveStateRequest) => SaveStateResult | Promise<SaveStateResult>;
}

/**
 * Returns `{ POST }` for `app/api/lifecycle/[...hook]/route.ts`.
 *
 * Routes by the catch-all segment in `ctx.params.hook` (an array — Next's
 * convention). The catch-all simplifies the on-disk layout from 6–8 separate
 * route files to a single one; apps wanting per-hook files can still ship
 * them — Next's filesystem routes win over the catch-all on path collision.
 */
export function createNextLifecycleRoutes(impl: NextLifecycleImpl = {}) {
  type NextCtx = { params: Promise<{ hook?: string | string[] }> };

  return {
    POST: async (request: Request, ctx: NextCtx): Promise<Response> => {
      const denied = refused(request);
      if (denied) return denied;
      const params = await Promise.resolve(ctx.params);
      const raw = params?.hook;
      const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const hook = segments[0] ?? '';

      // Plain lifecycle hooks — onCreate / onStart / onResume / onPause / onStop / onDestroy.
      const plain: Record<string, PlainHook | undefined> = {
        onCreate:  impl.onCreate,
        onStart:   impl.onStart,
        onResume:  impl.onResume,
        onPause:   impl.onPause,
        onStop:    impl.onStop,
        onDestroy: impl.onDestroy,
      };
      if (hook in plain) {
        const hookCtx = lifecycleContextOf(request.headers);
        console.log(`[${APP_ID()}] ${hook}${hookCtx.reason ? ` (${hookCtx.reason})` : ''}`);
        try {
          const fn = plain[hook];
          if (fn) await fn(hookCtx);
          return json({ ok: true });
        } catch (err) {
          console.error(`[${APP_ID()}] ${hook} failed:`, err);
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      // onActivityCreate — POST body { activityId, data? } → { ok, path?, title?, metadata? }
      if (hook === 'onActivityCreate') {
        const body = await request.json().catch(() => ({})) as Partial<ActivityCreateRequest>;
        const activityId = typeof body.activityId === 'string' ? body.activityId : '';
        if (!activityId) return json({ ok: false, error: 'missing activityId' }, 400);
        const data = body.data ?? undefined;
        const intent = parseIntentPayload(body.intent);
        try {
          const result = impl.onActivityCreate
            ? await impl.onActivityCreate({ activityId, ...(data ? { data } : {}), ...(intent ? { intent } : {}) })
            : {};
          console.log(`[${APP_ID()}] onActivityCreate ${activityId}`);
          return json({ ok: true, ...result });
        } catch (err) {
          console.error(`[${APP_ID()}] onActivityCreate ${activityId} failed:`, err);
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      // onActivityDestroy — the hook segment is followed by the activityId in the URL.
      if (hook === 'onActivityDestroy') {
        const activityId = segments[1] ? decodeURIComponent(segments[1]) : '';
        if (!activityId) return json({ ok: false, error: 'missing activityId' }, 400);
        try {
          if (impl.onActivityDestroy) await impl.onActivityDestroy(activityId);
          console.log(`[${APP_ID()}] onActivityDestroy ${activityId}`);
          return json({ ok: true });
        } catch (err) {
          console.error(`[${APP_ID()}] onActivityDestroy ${activityId} failed:`, err);
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      // onIntent — POST body { intent, newInstance } → { ok }. Without an impl
      // the hook is "not implemented" (404) so the OS reports intentDelivered=false.
      if (hook === 'onIntent' && impl.onIntent) {
        const body = await request.json().catch(() => ({})) as { intent?: unknown; newInstance?: unknown };
        const intent = parseIntentPayload(body.intent);
        if (!intent) return json({ ok: false, error: 'missing intent.action' }, 400);
        try {
          await impl.onIntent({ intent, newInstance: body.newInstance === true });
          console.log(`[${APP_ID()}] onIntent ${intent.action}`);
          return json({ ok: true });
        } catch (err) {
          console.error(`[${APP_ID()}] onIntent ${intent.action} failed:`, err);
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      // onSaveState — POST body { activityIds } → { ok, states }. Without an
      // impl it is "not implemented" (404), like onIntent.
      if (hook === 'onSaveState' && impl.onSaveState) {
        const body = await request.json().catch(() => ({})) as Partial<SaveStateRequest>;
        const activityIds = Array.isArray(body.activityIds) ? body.activityIds.filter((x): x is string => typeof x === 'string') : [];
        try {
          const res = await impl.onSaveState({ activityIds });
          return json({ ok: true, states: res?.states ?? {} });
        } catch (err) {
          console.error(`[${APP_ID()}] onSaveState failed:`, err);
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      // Unknown hook — return 404 so the AppManager's `callOptionalLifecycle`
      // path treats it as "not implemented" rather than a hard failure.
      return json({ ok: false, error: `unknown lifecycle hook: ${hook}` }, 404);
    },
  };
}

// =========================================================================
//  Health route (GET /api/lifecycle/health)
// =========================================================================

/**
 * Returns `{ GET }` for `app/api/lifecycle/health/route.ts`. The kernel's
 * health identity check (`lifecycleGate.ts`) parses the body as
 * `{ ok, appId, instanceId }` and matches it against the instance it started —
 * a mismatch fails the spawn (port-squat protection). A probe with a wrong
 * lifecycle token gets 401; one without a token still gets the body.
 */
export function createNextHealthRoute() {
  return {
    GET: async (request: Request): Promise<Response> => refused(request) ?? json({
      ok: true,
      appId: APP_ID(),
      instanceId: INSTANCE_ID(),
    }),
  };
}
