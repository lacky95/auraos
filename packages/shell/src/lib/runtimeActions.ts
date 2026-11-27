/**
 * A runtime module's actions, for the admin routes (5b PR, D100 §4): the
 * route authorizes (the route manifest; an owner action for a mutating one)
 * and audits; the module only executes, on the privileged argv runner handed
 * to it. No route runs runtime-specific commands itself.
 */
import * as core from '@aura/core';
import type { RuntimeAction } from '@aura/core';
import { json } from './approvals/service.ts';
import { runArgv } from './privilegedExec.ts';

/** The executor every action gets: one program by argv (lib/privilegedExec.ts). */
export const actionHost = { run: runArgv };

/** An action of an installed runtime, or the refusal (unknown runtime: 404; no such action: unsupported-operation). */
export function runtimeAction(
  runtime: string, action: string, mgr: Pick<ReturnType<typeof core.getAppManager>, 'runtimes'> = core.getAppManager(),
): RuntimeAction | Response {
  const module = mgr.runtimes.get(runtime);
  if (!module) return json({ error: 'runtime-not-installed', category: 'runtime-unavailable', message: `runtime ${runtime} is not installed` }, 404);
  const a = module.actions?.[action];
  if (!a) return json({ error: 'feature-unsupported', category: 'unsupported-operation', message: `runtime ${runtime} has no action ${action}` }, 501);
  return a;
}

/** GET of a read-only diagnostic action, answered as JSON. */
export async function readAction(runtime: string, action: string, input: Record<string, unknown> = {}): Promise<Response> {
  const a = runtimeAction(runtime, action);
  if (a instanceof Response) return a;
  if (a.mutating) return json({ error: 'invalid-request', message: `${runtime}.${action} changes the host` }, 405);
  return new Response(JSON.stringify(await a.run(input, actionHost), null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
