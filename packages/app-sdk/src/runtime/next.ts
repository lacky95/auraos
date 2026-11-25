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
 *   • POST /api/lifecycle/onAssign         (optional, a warm-pool instance handed to a user)
 *
 * Every hook runs through the same functions as the Astro factories
 * (`run*` in ../lifecycle.ts), so the bodies, the user, the stop reason and
 * `IntentRejectedError` work the same in both runtimes.
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
 *   // Node.js runtime (Next 15.5+): this module's lifecycle guard uses node:crypto, which Edge can't load.
 *   export const config = { matcher: '/(.*)', runtime: 'nodejs' };
 *
 * Implementation note: we deliberately do NOT take a runtime dependency on `next`.
 * The Route Handler signature `(req: Request, ctx: { params: ... }) => Response` is
 * web-standard; the middleware helper returns plain header pairs the caller stamps
 * onto whichever NextResponse they construct.
 */

import {
  healthResponse, lifecycleContextOf, runActivityCreate, runActivityDestroy, runAssign, runIntent, runPlainHook, runSaveState,
  type ActivityCreateRequest, type ActivityCreateResult, type AssignRequest, type IntentHandlerResult, type IntentRequest,
  type LifecycleContext, type LifecycleHookName, type SaveStateRequest, type SaveStateResult,
} from '../lifecycle.js';
import { identityResponseHeaders } from '../context.js';
import { LIFECYCLE_TOKEN_HEADER, lifecycleRefusalResponse, lifecycleRequestRefused } from './lifecycle-guard.js';
export type { IntentPayload } from '../intent.js';
// One set of hook types for both runtimes (they used to be copied here).
export type {
  ActivityCreateRequest, ActivityCreateResult, AssignRequest, IntentRequest, LifecycleContext, LifecycleHookName,
  SaveStateRequest, SaveStateResult,
} from '../lifecycle.js';
export { lifecycleContextOf };

/** The shared pre-handler check: a 401 response, or null to go on. */
function refused(request: Request): Response | null {
  return lifecycleRequestRefused(new URL(request.url).pathname, request.headers.get(LIFECYCLE_TOKEN_HEADER))
    ? lifecycleRefusalResponse()
    : null;
}

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
 * `process.env.APP_ID` + `APP_INSTANCE_ID` are set by the runner at spawn.
 * Unset (the app started by hand outside Aura): no headers.
 */
export function auraIdentityHeaders(): Record<string, string> {
  return identityResponseHeaders();
}

// =========================================================================
//  Lifecycle catch-all (POST /api/lifecycle/[...hook])
// =========================================================================

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
  /** Optional handler for `onIntent` (Android onNewIntent / onStartCommand). Return `{ result }` for the caller. */
  onIntent?: (req: IntentRequest) => IntentHandlerResult | Promise<IntentHandlerResult>;
  /** Optional handler for `onSaveState` (before a planned restart). Return each activity's state. */
  onSaveState?: (req: SaveStateRequest) => SaveStateResult | Promise<SaveStateResult>;
  /** Optional handler for `onAssign` (D46): a warm-pool instance now runs for `userId`. */
  onAssign?: (req: AssignRequest) => void | Promise<void>;
}

const PLAIN_HOOKS: readonly LifecycleHookName[] = ['onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy'];

/**
 * Returns `{ POST }` for `app/api/lifecycle/[...hook]/route.ts`.
 *
 * Routes by the catch-all segment in `ctx.params.hook` (an array — Next's
 * convention). The catch-all simplifies the on-disk layout from 6–8 separate
 * route files to a single one; apps wanting per-hook files can still ship
 * them — Next's filesystem routes win over the catch-all on path collision.
 * An optional hook without an impl (onIntent, onSaveState, onAssign) answers
 * 404, which the OS reads as "not implemented".
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

      if ((PLAIN_HOOKS as readonly string[]).includes(hook)) return runPlainHook(hook, request, impl[hook as LifecycleHookName]);
      if (hook === 'onActivityCreate') return runActivityCreate(request, impl.onActivityCreate);
      if (hook === 'onActivityDestroy') return runActivityDestroy(segments[1] ? decodeURIComponent(segments[1]) : '', impl.onActivityDestroy);
      if (hook === 'onIntent' && impl.onIntent) return runIntent(request, impl.onIntent);
      if (hook === 'onSaveState' && impl.onSaveState) return runSaveState(request, impl.onSaveState);
      if (hook === 'onAssign' && impl.onAssign) return runAssign(request, impl.onAssign);

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
    GET: async (request: Request): Promise<Response> => refused(request) ?? healthResponse(),
  };
}
