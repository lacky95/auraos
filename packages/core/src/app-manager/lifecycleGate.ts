import { randomBytes } from 'node:crypto';
import { LIFECYCLE_TOKEN_HEADER } from '../types/hostRules.js';
import { securityEnvValue } from '../security/options.js';

/**
 * The kernel side of the lifecycle token and the health identity check,
 * shared by both runners (ContainerRunner, ProotRunner) so the rule is stated
 * once.
 *
 *   • Token: a random `AURA_LIFECYCLE_TOKEN` per start, in the app's env, sent
 *     as `x-aura-lifecycle` on every lifecycle call and the spawn health
 *     probes. The app SDK refuses lifecycle routes without it (401). The runner
 *     sends it only to a destination it has bound to the instance it started
 *     (container id and address; PRoot: the listener's process tree).
 *   • Health identity: the `{ appId, instanceId }` a health answer claims.
 *   • Runtime check: after ready, one health probe with a deliberately wrong
 *     token. Evidence for the health endpoint's guard only.
 *   • Mode: `AURA_LIFECYCLE_STRICT=warn|strict` (default `warn`).
 */

export type LifecycleStrictMode = 'warn' | 'strict';

let cachedMode: LifecycleStrictMode | null = null;

/** The mode, read once from `AURA_LIFECYCLE_STRICT` (anything else is `warn`). */
export function lifecycleStrictMode(): LifecycleStrictMode {
  if (cachedMode) return cachedMode;
  const raw = (process.env['AURA_LIFECYCLE_STRICT'] ?? '').trim().toLowerCase();
  if (raw && raw !== 'warn' && raw !== 'strict') {
    console.warn(`[lifecycle] AURA_LIFECYCLE_STRICT=${raw} is not warn|strict; using warn`);
  }
  // The security options registry (D64) parses it, so the list shows what runs.
  cachedMode = securityEnvValue('lifecycle-strict') === 'strict' ? 'strict' : 'warn';
  return cachedMode;
}

/**
 * D89 B4: whether the Terminal and aurashelld refuse a call from the shell's
 * address without a valid relay claim (`relay-strict`, AURA_RELAY_STRICT,
 * default `strict` since 5-main). Read by the shell at each start and always
 * handed to the app (`relayStrictEnv`): the app's own default is strict too,
 * so only an explicit `warn` relaxes it.
 */
export function relayStrictMode(env: Record<string, string | undefined> = process.env): LifecycleStrictMode {
  return securityEnvValue('relay-strict', env) === 'warn' ? 'warn' : 'strict';
}

/** The app env that carries the relay mode (app-sdk shell-peer reads it). */
export function relayStrictEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return { AURA_RELAY_STRICT: relayStrictMode(env) };
}

/** Tests only: forget the cached mode so the next read sees the env again. */
export function resetLifecycleStrictModeForTests(): void { cachedMode = null; }

/**
 * Apps whose health answer carries no identity and that `warn` still admits.
 * Verified 2026-11-25 against every installed app (system, global and user
 * scope): each one answers with `{ appId, instanceId }` — the SDK health
 * route (0.0.1 included), `runtime/next`, `sidecars.createServer`, and the
 * raw registry and improvement-board servers. So the list is empty; an app
 * goes on it only by name, after the same check.
 */
export const KNOWN_LEGACY_HEALTH_APPS: ReadonlySet<string> = new Set<string>([]);

/**
 * What a health answer says about who answered:
 *   • match    — both `appId` and `instanceId`, both as expected;
 *   • legacy   — neither field (or a body that is not JSON);
 *   • partial  — only one of them;
 *   • mismatch — a different app or instance.
 */
export type HealthIdentityClass = 'match' | 'legacy' | 'partial' | 'mismatch';

export interface HealthIdentity {
  kind: HealthIdentityClass;
  claimedApp: string | null;
  claimedInstance: string | null;
}

export function classifyHealthIdentity(rawBody: string, expectedAppId: string, expectedInstanceId: string): HealthIdentity {
  let body: { appId?: unknown; instanceId?: unknown } = {};
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch { /* not JSON: no identity */ }
  const claimedApp      = typeof body.appId      === 'string' ? body.appId      : null;
  const claimedInstance = typeof body.instanceId === 'string' ? body.instanceId : null;
  const kind: HealthIdentityClass =
    claimedApp === null && claimedInstance === null ? 'legacy'
    : claimedApp === null || claimedInstance === null ? 'partial'
    : claimedApp === expectedAppId && claimedInstance === expectedInstanceId ? 'match'
    : 'mismatch';
  return { kind, claimedApp, claimedInstance };
}

/**
 * Whether the start may go on with this health identity. Partial or
 * mismatched fails in every mode; legacy passes only in `warn` and only for a
 * known legacy app. Returns the refusal reason, or null to admit.
 */
export function healthIdentityRefusal(id: HealthIdentity, appId: string, instanceId: string, mode = lifecycleStrictMode()): string | null {
  switch (id.kind) {
    case 'match':
      return null;
    case 'legacy':
      if (mode === 'warn' && KNOWN_LEGACY_HEALTH_APPS.has(appId)) return null;
      return `health identity missing for ${instanceId} (${mode} mode${mode === 'warn' ? `, ${appId} is not a known legacy app` : ''})`;
    case 'partial':
    case 'mismatch':
      return `health identity mismatch for ${instanceId}: expected appId=${appId} instanceId=${instanceId}, ` +
        `got appId=${id.claimedApp} instanceId=${id.claimedInstance}`;
  }
}

/** Outcome of the runtime check (health with a deliberately wrong token). */
export type HealthGuardCheck = '401' | 'accepted-wrong-token' | 'inconclusive';

/** Per-instance result the owner reads in `aura get inst -o wide`. */
export interface LifecycleStatus {
  identity: HealthIdentityClass;
  guard: HealthGuardCheck;
}

/** A fresh per-start lifecycle secret. */
export function newLifecycleToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Headers for one lifecycle call (the token, plus the stop reason on stop hooks). */
export function lifecycleHeaders(token: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(token ? { [LIFECYCLE_TOKEN_HEADER]: token } : {}), ...extra };
}

const GUARD_CHECK_TIMEOUT_MS = 2_000;

/**
 * The runtime check: GET health with a token that can't be right. 401 means
 * the health guard is active; a 2xx means it accepted a wrong token (no
 * guard); anything else (timeout, 5xx, network, other status) is
 * inconclusive. A successful call with the right token is never evidence.
 */
export async function checkHealthGuard(healthUrl: string, timeoutMs = GUARD_CHECK_TIMEOUT_MS): Promise<HealthGuardCheck> {
  try {
    const res = await fetch(healthUrl, {
      headers: { [LIFECYCLE_TOKEN_HEADER]: `wrong-${randomBytes(16).toString('base64url')}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401) return '401';
    if (res.ok) return 'accepted-wrong-token';
    return 'inconclusive';
  } catch {
    return 'inconclusive';
  }
}

/**
 * Apply the mode to a finished start: `strict` needs a matching identity and a
 * 401 from the runtime check; `warn` admits and reports. Returns the refusal
 * reason, or null to admit. Logs one line per instance either way.
 */
export function lifecycleStatusRefusal(instanceId: string, status: LifecycleStatus, mode = lifecycleStrictMode()): string | null {
  const ok = status.identity === 'match' && status.guard === '401';
  if (ok) return null;
  const what = [
    status.identity !== 'match' ? `health answer has no identity (${status.identity})` : null,
    status.guard === 'accepted-wrong-token' ? 'app does not check the lifecycle token (health accepted a wrong token)'
      : status.guard === 'inconclusive' ? 'lifecycle token check inconclusive (health with a wrong token gave no 401)' : null,
  ].filter(Boolean).join('; ');
  if (mode === 'strict') return `${instanceId}: ${what} (AURA_LIFECYCLE_STRICT=strict)`;
  console.warn(`[lifecycle] ${instanceId}: ${what} — admitted in warn mode`);
  return null;
}
