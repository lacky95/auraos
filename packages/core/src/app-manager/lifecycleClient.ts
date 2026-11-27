/**
 * The lifecycle client and the health loop, once for every runner (5b plan
 * §3.9 #7 and #8, Phase 6 ari-rest). A runner names where its instance
 * answers (`LifecycleDestination`) and how it proves the listener there is
 * that instance's before the lifecycle token goes out: PRoot by the
 * listener's ownership in /proc (its apps share the shell's network), the
 * container by the address `docker run` bound at spawn. Everything else is
 * one implementation: the hook calls, their error words, the health probe
 * with the identity check (lifecycleGate.ts) and the two clocks of the boot
 * budget (provisioning.ts `nextHealthDeadline`).
 *
 * Unified on the owner's decision (unify behind tests, "throw" for required
 * hooks): a required hook on an unknown or unbound instance throws, as does
 * a non-2xx answer; an optional hook answers its JSON body or null. What
 * must stay per runtime is data (`LifecycleTraits`): the log name, the boot
 * budget, the probe timeout.
 *
 * Lives beside the runners in app-manager (runtimes/ may not import
 * app-manager at runtime, D97, and the gate helpers live here).
 */
import { lifecyclePath } from '../types/manifest.js';
import {
  classifyHealthIdentity, healthIdentityRefusal, lifecycleHeaders, type HealthIdentityClass,
} from './lifecycleGate.js';
import { PROVISION_TIMEOUT_MS, nextHealthDeadline } from './provisioning.js';

/** Where an instance answers its lifecycle routes, with this start's token. */
export interface LifecycleDestination {
  /** An address or a host name. */
  host: string;
  port: number;
  /** This start's lifecycle token; undefined for an instance adopted from before tokens (sent without one). */
  token: string | undefined;
  /**
   * Proof the listener is the instance's, asked before every call that
   * carries the token: null when proven, else why not (the call is not sent).
   */
  unbound(): string | null;
}

/** What differs per runtime, as data. */
export interface LifecycleTraits {
  /** The runner's log name (`[ProotRunner]`). */
  name: string;
  /** Boot budget of the health loop (after provisioning). */
  bootBudgetMs: number;
  /** One health probe's timeout. */
  probeTimeoutMs: number;
}

/** Shared by every runner. */
export const HEALTH_CHECK_INTERVAL_MS = 200;
export const LIFECYCLE_TIMEOUT_MS = 5_000;

/**
 * The app did not come up: it exited while booting or never answered its
 * health check. Distinct from an identity mismatch (someone else owns the
 * port), which a retry in another serve mode can't fix.
 */
export class StartupFailure extends Error {}

/**
 * The port's listener does not belong to the instance just started (or that
 * can't be confirmed), or its health identity is refused. A retry in another
 * serve mode can't fix either.
 */
export class DestinationBindingError extends Error {}

/** `http://<host>:<port>/api/lifecycle/<hook>`; an IPv6 address gets brackets. */
export function lifecycleUrl(host: string, port: number, hook: string): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}${lifecyclePath(hook)}`;
}

/**
 * A required hook (`onCreate`, `onStart`, `onStop`, ...): throws when the
 * instance is unknown (`dest` null), its listener is not proven to be its
 * own, the app answers non-2xx, or the call times out.
 */
export async function callRequiredHook(
  traits: LifecycleTraits, instanceId: string, dest: LifecycleDestination | null, hook: string, opts: { reason?: string } = {},
): Promise<void> {
  if (!dest) throw new Error(`${traits.name} ${instanceId} is not running; ${hook} not sent`);
  const why = dest.unbound();
  if (why) throw new Error(`${traits.name} ${instanceId}: ${why}; ${hook} not sent`);
  const res = await fetch(lifecycleUrl(dest.host, dest.port, hook), {
    method: 'POST',
    headers: lifecycleHeaders(dest.token, opts.reason ? { 'x-aura-stop-reason': opts.reason } : {}),
    signal: AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${traits.name} ${instanceId} lifecycle hook ${hook} returned ${res.status}`);
}

/**
 * An optional hook (`onIntent`, `onActivityCreate`, `onSaveState`, ...): its
 * JSON answer, or null when the instance is unknown or unbound, the app
 * doesn't implement it (404) or fails, or the answer is empty or not JSON.
 */
export async function callOptionalHook(
  _traits: LifecycleTraits, dest: LifecycleDestination | null, hook: string, body?: unknown,
): Promise<unknown | null> {
  if (!dest || dest.unbound()) return null;
  try {
    const res = await fetch(lifecycleUrl(dest.host, dest.port, hook), {
      method: 'POST',
      headers: lifecycleHeaders(dest.token, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(LIFECYCLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text) as unknown; } catch { return null; }
  } catch {
    return null;
  }
}

/**
 * A maintenance hook (D108 A3, stream M: `onUpdate`; 7c: `onSetup`, ...),
 * called inside a maintenance start with its own timeout and the reason in
 * `x-aura-maintenance`. Optional like every maintenance hook: an app that
 * doesn't implement it answers 404 and the result is null, never an error.
 * Otherwise unlike `callOptionalHook`, a failure is the update's failure:
 * an unknown or unbound instance, a non-2xx answer or the timeout throws.
 */
export async function callMaintenanceHook(
  traits: LifecycleTraits, instanceId: string, dest: LifecycleDestination | null, hook: string, body: unknown,
  opts: { timeoutMs: number; reason: string },
): Promise<unknown | null> {
  if (!dest) throw new Error(`${traits.name} ${instanceId} is not running; ${hook} not sent`);
  const why = dest.unbound();
  if (why) throw new Error(`${traits.name} ${instanceId}: ${why}; ${hook} not sent`);
  const res = await fetch(lifecycleUrl(dest.host, dest.port, hook), {
    method: 'POST',
    headers: lifecycleHeaders(dest.token, { 'Content-Type': 'application/json', 'x-aura-maintenance': opts.reason }),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${traits.name} ${instanceId} maintenance hook ${hook} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

/** A health loop's view of the start it waits for. */
export interface HealthTarget {
  /**
   * Before each probe: where to probe, or null to keep waiting (nothing
   * listens yet). Throws to fail the start at once: a `StartupFailure` when
   * the workload is gone, a `DestinationBindingError` when the listener is
   * someone else's.
   */
  next(): LifecycleDestination | null;
  /** The entrypoint's dependency install (keeps the boot budget open). */
  provision?: { readonly isProvisioning: boolean; readonly everProvisioned: boolean };
}

/**
 * Probe `/api/lifecycle/health` until the app answers AND its declared
 * identity matches what was spawned (a bare 200 is not enough: another app
 * squatting the port), with the lifecycle token, or fail loud. Two clocks: a
 * cold app installs its dependency tree in the entrypoint before it is asked
 * to start, so while it says it is provisioning the boot deadline is pushed
 * out, bounded by an absolute ceiling (a wedged install still fails).
 */
export async function waitHealthy(
  traits: LifecycleTraits, instanceId: string, appId: string, target: HealthTarget,
): Promise<HealthIdentityClass> {
  const startedAt    = Date.now();
  const hardDeadline = startedAt + PROVISION_TIMEOUT_MS;
  let   deadline     = startedAt + traits.bootBudgetMs;
  let lastBody: string | null = null;
  while (Date.now() < deadline) {
    const dest = target.next();
    if (dest) {
      let refusal: string | null = null;
      try {
        const res = await fetch(lifecycleUrl(dest.host, dest.port, 'health'), {
          headers: lifecycleHeaders(dest.token), signal: AbortSignal.timeout(traits.probeTimeoutMs),
        });
        // The body regardless of status, so a timeout says what the app answered (403 = host gate, etc.).
        const body = await res.text();
        lastBody = body;
        if (res.ok) {
          const identity = classifyHealthIdentity(body, appId, instanceId);
          refusal = healthIdentityRefusal(identity, appId, instanceId);
          if (!refusal) {
            if (identity.kind === 'legacy') console.warn(`${traits.name} ${instanceId} health endpoint returned no identity body; admitted as a known legacy app (warn mode).`);
            return identity.kind;
          }
        }
      } catch { /* not answering yet (connection refused, ...): keep polling */ }
      // Port poisoned or identity required: fail loud, no point waiting.
      if (refusal) throw new DestinationBindingError(`${traits.name} ${refusal} on port ${dest.port}.`);
    }
    // Re-arm only while provisioning is in flight, so the boot budget counts from when dependencies are ready.
    deadline = nextHealthDeadline({
      now: Date.now(), deadline, hardDeadline,
      isProvisioning: target.provision?.isProvisioning ?? false,
      bootBudgetMs:   traits.bootBudgetMs,
    });
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }
  const waited = Math.round((Date.now() - startedAt) / 1000);
  const said = `last body: ${lastBody?.slice(0, 200) ?? 'none'}`;
  throw new StartupFailure(target.provision?.everProvisioned
    ? `${traits.name} ${instanceId} did not become healthy ${waited}s after starting to install its dependencies (${said})`
    : `${traits.name} ${instanceId} did not become healthy within ${traits.bootBudgetMs}ms (${said})`);
}
