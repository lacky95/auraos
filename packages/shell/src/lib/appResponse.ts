import { join } from 'node:path';
import { auraErrorOf, getAppManager, lifecyclePath, RELAY_CLAIM_HEADER, sourceClosedBody } from '@aura/core';
import { relayClaimFor, type RelaySigner } from './access/relay.ts';
import type { AppManifest, AppInstance, AuraErrorBody } from '@aura/core';

export interface AppHealth {
  /** Process is alive (kill -0 PID succeeds). null = no PID known. */
  processAlive: boolean | null;
  /** HTTP health probe to app's /api/lifecycle/health returned 2xx. null = no port. */
  httpHealthy: boolean | null;
  /** Round-trip time of HTTP probe in ms. null if probe didn't run. */
  httpLatencyMs: number | null;
  /** Last error from probe (if any). */
  error: string | null;
}

/**
 * Scope-correct launch coordinates for an instance, resolved server-side via
 * the registry + scope registry. Exposed so CLI callers (`aura inst shell`,
 * `aura jump`) can enter a proot sandbox with the RIGHT host paths for the
 * app's scope (system/global/user) instead of hardcoding `/workspace/apps`
 * and `/data/apps`, which only work for system-scope apps.
 */
export interface InstanceLaunch {
  /** Scoped host path to the app's source dir (`<scope.appsDir>/<appId>`). */
  appDir: string;
  /** Scoped host path to this instance's data dir. */
  instanceDataDir: string;
  /** The app's declared tool allowlist (`manifest.tools`). */
  tools: string[];
}

export interface InstanceDTO {
  instance: Omit<AppInstance, 'owner'>;
  health: AppHealth;
  /** Present when the app's manifest resolves; carries scope-correct paths. */
  launch?: InstanceLaunch;
}

/** DTO for a single app: manifest + all its running instances. */
export interface AppDTO {
  manifest: AppManifest;
  instances: InstanceDTO[];
}

const HEALTH_TIMEOUT_MS = 1000;

async function probeHealth(instance: AppInstance): Promise<AppHealth> {
  const health: AppHealth = {
    processAlive: null,
    httpHealthy: null,
    httpLatencyMs: null,
    error: null,
  };

  if (instance.pid !== null) {
    try {
      process.kill(instance.pid, 0);
      health.processAlive = true;
    } catch {
      health.processAlive = false;
    }
  }

  if (instance.port !== null) {
    const start = Date.now();
    // For container-sandbox instances the host is the docker container name
    // on the shared network, not 127.0.0.1. getUpstreamUrl encapsulates that.
    const mgr = getAppManager();
    const up = mgr.getUpstreamUrl?.(instance.instanceId);
    const upHost = up?.host ?? 'localhost';
    const path = lifecyclePath('health');
    try {
      // An owner agent's server answers the shell only with its relay claim (D89 B4, strict since 5-main): this probe is the shell's own.
      const relay = relayClaimFor(mgr as unknown as RelaySigner, { appId: instance.appId, instanceId: instance.instanceId, method: 'GET', path }, { caller: 'system' });
      const res = await fetch(`http://${upHost}:${instance.port}${path}`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        ...(relay ? { headers: { [RELAY_CLAIM_HEADER]: relay } } : {}),
      });
      health.httpLatencyMs = Date.now() - start;
      health.httpHealthy = res.ok;
      if (!res.ok) health.error = `HTTP ${res.status}`;
    } catch (err) {
      health.httpLatencyMs = Date.now() - start;
      health.httpHealthy = false;
      health.error = err instanceof Error ? err.message : String(err);
    }
  }

  return health;
}

export async function buildInstanceDTO(instanceId: string): Promise<InstanceDTO | null> {
  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return null;
  const health = await probeHealth(instance);
  return { instance, health, launch: resolveLaunch(instanceId, instance.appId) };
}

/**
 * Resolve scope-correct launch paths for an instance. Mirrors exactly what
 * `AppManager.spawnInstance` computes (`manifest.appDir` +
 * `join(scope.dataDir, 'apps', appId, instanceId)`), so a jumped/exec'd shell
 * lands where the live app actually runs, for ANY scope.
 */
function resolveLaunch(instanceId: string, appId: string): InstanceLaunch | undefined {
  const mgr = getAppManager();
  const manifest = mgr.registry.getById(appId); // ScopedManifest: has appDir + scopeId
  if (!manifest) return undefined;
  const scope = mgr.getScopeRegistry().getById(manifest.scopeId);
  return {
    appDir: manifest.appDir,
    instanceDataDir: join(scope.dataDir, 'apps', appId, instanceId),
    tools: Array.isArray(manifest.tools) ? manifest.tools : [],
  };
}

export async function buildAppDTO(appId: string): Promise<AppDTO | null> {
  const mgr = getAppManager();
  const manifest = mgr.getManifest(appId);
  if (!manifest) return null;
  const instances = await Promise.all(
    mgr.getInstancesByApp(appId).map((inst) => probeHealth(inst).then((health) => ({ instance: publicInstance(inst, mgr), health }))),
  );
  return { manifest, instances };
}

/** The runtime of an instance in the instance view (5b G): `{id, source, capabilities}`, its effective capabilities. */
export type InstanceRuntimeView = ReturnType<ReturnType<typeof getAppManager>['instanceRuntime']>;

/**
 * An instance for an API response. `owner` is server-side until Phase 3.
 * With `mgr`, it carries `runtime` (5b G): clients gate on
 * `runtime.capabilities`, never on the runtime id.
 */
export function publicInstance(inst: AppInstance, mgr?: Pick<ReturnType<typeof getAppManager>, 'instanceRuntime'>): Omit<AppInstance, 'owner'> & { runtime?: InstanceRuntimeView } {
  const { owner: _owner, ...rest } = inst;
  return mgr ? { ...rest, runtime: mgr.instanceRuntime(inst.instanceId) } : rest;
}

export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * An error answer. Two forms during the migration (error-messages review §4.3):
 *   errorResponse(status, body)   the structured body (`AuraErrorBody`: `error`
 *                                 is the code, `message` the sentence, plus
 *                                 hint/docs/permission/… when they apply), no-store
 *   errorResponse(message, status) the old form, `{error: message}`
 */
export function errorResponse(status: number, body: AuraErrorBody): Response;
export function errorResponse(message: string, status?: number): Response;
export function errorResponse(a: string | number, b?: number | AuraErrorBody): Response {
  // The old form keeps `error` as the sentence for the clients that show it,
  // and says it in `message` too, where the SDK and the CLI read it first.
  const [status, body] = typeof a === 'number' ? [a, b as AuraErrorBody] : [typeof b === 'number' ? b : 500, { error: a, message: a }];
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * The migration form of a structured body (review §4.3): every fact, the
 * right status, but `error` keeps the sentence, for a route whose clients
 * still show `error` (the Nexus app, Settings). Moves to the plain body once
 * they read `message`; tools/error-lint.mjs counts it as old-form debt.
 */
export function legacyErrorBody(body: AuraErrorBody): AuraErrorBody {
  return { ...body, error: body.message };
}

// ── failures (error-messages review §4.4 rule 5, D105 Pass B) ──────────────

/** Who reads an error body: the owner (or the host operator, a trusted owner agent), or anyone else. */
export type ErrorAudience = 'owner' | 'app';

/** Public routes and gateway paths stay readable; every other absolute path is internal. */
const ABS_PATH = /(?<![\w.:/~-])\/(?!api\/|_aura\/)(?:[\w.@+~-]+\/)*[\w.@+~-]+\/?/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const ENV_ASSIGNMENT = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*=\S+/g;
const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;
const CONTAINER = /\baura-[a-z0-9][a-z0-9_.-]*/g;
const MAX_MESSAGE = 300;

/**
 * The text of an unexpected error, without the noise a reader can't use:
 * the `Error: ` of `String(err)` and a `[ProotRunner] ` style origin tag.
 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^(?:[A-Z][A-Za-z]*Error: )+/, '').replace(/^\[[A-Za-z][\w.-]*\]\s*/, '').trim() || 'unknown error';
}

/**
 * The same text for a reader who is not the owner (review §4.4 rules 5 and
 * 6): no host or container path, no container name, no credential in a URL,
 * no bearer token, no env name or value. Docker, git and fs messages keep
 * what they say, not where.
 */
export function redactInternal(text: string): string {
  const out = text
    .replace(URL_USERINFO, '$1<redacted>@')
    .replace(BEARER, 'Bearer <redacted>')
    .replace(ENV_ASSIGNMENT, '<redacted>')
    .replace(ENV_NAME, '<env>')
    .replace(ABS_PATH, '<path>')
    .replace(CONTAINER, '<container>');
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

export interface FailureOptions {
  /** The status when the error carries none (default 500). */
  status?: number;
  /**
   * The closed code. Without it, and without `coded`, the answer is the
   * migration form (`legacyErrorBody`: `error` is the sentence) for the
   * clients that show `error`; the ratchet lint (tools/error-lint.mjs) counts
   * those.
   */
  error?: string;
  /** Answer a carried code (`AuraError`) as the plain body: the route's clients read `message`. */
  coded?: boolean;
  hint?: string;
  category?: AuraErrorBody['category'];
  /** The app the request works on, as the caller named it: an EROFS under it is `source-closed`. */
  appId?: string;
  /** What failed, said before the error's text (`navigate failed: …`). */
  what?: string;
}

/**
 * The body of a failure for one reader. An error that carries its D105 body
 * (`AuraError`, matched by shape) is answered as is; a write that hit a
 * read-only install is `source-closed`; anything else says its text, whole
 * to the owner and redacted to everyone else.
 */
export function failureBody(err: unknown, audience: ErrorAudience, opts: FailureOptions = {}): { status: number; body: AuraErrorBody } {
  const carried = auraErrorOf(err);
  if (carried) return carried;
  if ((err as NodeJS.ErrnoException | null)?.code === 'EROFS') {
    return opts.appId
      ? { status: 409, body: sourceClosedBody(opts.appId) }
      : { status: 409, body: { error: 'read-only', category: 'not-grantable', message: 'This is read-only here (a closed install, or the release).' } };
  }
  const text = `${opts.what ? `${opts.what}: ` : ''}${errorText(err)}`;
  const message = audience === 'owner' ? text : redactInternal(text);
  return {
    status: opts.status ?? 500,
    body: {
      error: opts.error ?? 'internal-error', message,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.hint ? { hint: opts.hint } : {}),
    },
  };
}

/** Who reads the answer to this request (the access gate's own view; anyone unverified is not the owner). */
export async function errorAudience(ctx: { request: Request; locals?: App.Locals }): Promise<ErrorAudience> {
  try {
    const [{ identifyAccess, liveDeps }, { refusalView }] = await Promise.all([
      import('./access/observer.ts'), import('./access/enforce.ts'),
    ]);
    const identity = ctx.locals?.access ?? await identifyAccess(ctx.request);
    if (!identity) return 'app';
    return refusalView(liveDeps, identity.principal as Parameters<typeof refusalView>[1], identity.via).audience;
  } catch {
    return 'app';
  }
}

/** An unexpected failure as an answer, for this request's reader (see `failureBody`, `FailureOptions.error`). */
export async function failureResponse(ctx: { request: Request; locals?: App.Locals }, err: unknown, opts: FailureOptions = {}): Promise<Response> {
  const { status, body } = failureBody(err, auraErrorOf(err) ? 'app' : await errorAudience(ctx), opts);
  return errorResponse(status, opts.error || opts.coded ? body : legacyErrorBody(body));
}
