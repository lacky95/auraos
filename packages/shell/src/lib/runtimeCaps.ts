/**
 * Per-instance runtime gates for shell code (5b G, ARI §9.5): the effective
 * capabilities of an instance (its runtime's, narrowed by its installation's
 * facts; core `AppManager.instanceCapabilities`) and the one refusal shape. A
 * route asks for a capability, never compares a runtime id: a runtime that
 * declares the capability gets the feature, whatever it is called.
 */
import * as core from '@aura/core';
import type { RuntimeCapabilities } from '@aura/core';
import { errorResponse } from './appResponse.js';

type Mgr = Pick<ReturnType<typeof core.getAppManager>, 'instanceCapabilities' | 'getInstance'>;

/** The effective capabilities of an instance; null for an unknown instance or one not started yet. */
export function runtimeCaps(instanceId: string, mgr: Mgr = core.getAppManager()): RuntimeCapabilities | null {
  return mgr.instanceCapabilities(instanceId);
}

/**
 * Null when the instance's runtime can do what `needs` asks (or the instance
 * has no runtime yet: the operation itself reports that), else the 409
 * `capability-missing` refusal (`refusalResponse`). Never a fallback.
 */
export function capabilityRefusal(instanceId: string, needs: Partial<RuntimeCapabilities>, what: string, mgr: Mgr = core.getAppManager()): Response | null {
  const caps = runtimeCaps(instanceId, mgr);
  if (!caps) return null;
  const missing = core.missingCapabilities(caps, needs);
  if (!missing.length) return null;
  const runtime = mgr.getInstance(instanceId)?.sandbox ?? 'unknown';
  const err = new core.RuntimeCapabilityError(runtime, missing,
    `${instanceId} runs on runtime '${runtime}', which can't do ${what} (missing: ${missing.join(', ')})`);
  return refusalResponse(err, mgr.getInstance(instanceId)?.appId)!;
}

/**
 * A runtime refusal as the 409 answer: the one error body (D105,
 * `core.runtimeErrorBody`: `error` the code, `message`, `category`,
 * `missing`, `suggest`, `hint`, the runtime in `details`). For a missing
 * capability another runtime has, the hint names the owner's move (never a
 * weaker mount). Null for anything else.
 */
export function refusalResponse(err: unknown, appId?: string): Response | null {
  const r = core.runtimeRefusal(err);
  if (!r) return null;
  const hint = r.code === 'capability-missing' && r.suggest?.length
    ? `the owner can move ${appId ?? 'the app'} to a runtime that has it: aura runtime set ${appId ?? '<app>'} ${r.suggest[0]} (or Settings → Runtimes)`
    : undefined;
  return errorResponse(409, core.runtimeErrorBody(r, hint));
}
