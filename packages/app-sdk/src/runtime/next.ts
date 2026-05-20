/**
 * Next.js runtime adapter for AuraOS apps that opt into `manifest.runtime: 'raw'`.
 *
 * Aura's AppManager calls a small HTTP contract on every app instance:
 *   • POST /api/lifecycle/{onCreate,onStart,onResume,onPause,onStop,onDestroy}
 *   • GET  /api/lifecycle/health           (with identity in the body)
 *   • POST /api/lifecycle/onActivityCreate (activity-mode apps only)
 *   • POST /api/lifecycle/onActivityDestroy/[activityId]
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
 * Header pairs every raw-mode app should stamp onto its responses. The shell
 * proxy's identity gate at `packages/shell/src/pages/api/proxy/[id]/[...path].ts:167`
 * verifies these match the resolved instance — without the headers the gate
 * is silently bypassed, which works at first but breaks the moment a port
 * gets reused after a crash.
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
}

export interface ActivityCreateResult {
  path?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface NextLifecycleImpl {
  onCreate?: () => void | Promise<void>;
  onStart?:  () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  onPause?:  () => void | Promise<void>;
  onStop?:   () => void | Promise<void>;
  onDestroy?: () => void | Promise<void>;
  /** Optional handler for `onActivityCreate`. Return path/title/metadata. */
  onActivityCreate?: (req: ActivityCreateRequest) => ActivityCreateResult | Promise<ActivityCreateResult>;
  /** Optional handler for `onActivityDestroy/[activityId]`. */
  onActivityDestroy?: (activityId: string) => void | Promise<void>;
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
  type NextCtx = { params: Promise<{ hook?: string | string[] }> | { hook?: string | string[] } };

  return {
    POST: async (request: Request, ctx: NextCtx): Promise<Response> => {
      const params = await Promise.resolve(ctx.params);
      const raw = params?.hook;
      const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const hook = segments[0] ?? '';

      // Plain lifecycle hooks — onCreate / onStart / onResume / onPause / onStop / onDestroy.
      const plain: Record<string, (() => void | Promise<void>) | undefined> = {
        onCreate:  impl.onCreate,
        onStart:   impl.onStart,
        onResume:  impl.onResume,
        onPause:   impl.onPause,
        onStop:    impl.onStop,
        onDestroy: impl.onDestroy,
      };
      if (hook in plain) {
        console.log(`[${APP_ID()}] ${hook}`);
        try {
          const fn = plain[hook];
          if (fn) await fn();
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
        try {
          const result = impl.onActivityCreate
            ? await impl.onActivityCreate({ activityId, ...(data ? { data } : {}) })
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
 * Returns `{ GET }` for `app/api/lifecycle/health/route.ts`. The shell's
 * `verifyHealthIdentity` (`ProotRunner.ts:427`) parses the body as
 * `{ ok, appId, instanceId }` and matches against the resolved instance —
 * a mismatch fails the spawn (port-squat protection).
 */
export function createNextHealthRoute() {
  return {
    GET: async (): Promise<Response> => json({
      ok: true,
      appId: APP_ID(),
      instanceId: INSTANCE_ID(),
    }),
  };
}
