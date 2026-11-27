/**
 * `osClient.setup`: the app's own setup values (D108).
 *
 *   // on your app's server only:
 *   const cfg = await osClient.setup.config();
 *   if (cfg.values.auth === 'native') { … }
 *   const key = await osClient.credentials.get(cfg.secrets.sessionKey);   // secrets are handles
 *
 * `config()` reads `GET /api/setup/self` with the instance token: the
 * effective values of the active fields of YOUR installation (a field whose
 * `when` is false is absent), secrets as D56 vault handles (never values),
 * the unmet optional requirements (`degraded`) and the `configDigest`. A
 * page never calls it; another app's or another user's values are never
 * reachable. Sidecars get their values as `services[].env` references
 * (`fromSetup`/`fromSecret`) at spawn instead.
 *
 * Errors: `OsError` with the D105 code, e.g. `setup-required` (the setup is
 * not complete), `unavailable` (503: this AuraOS has no setup engine).
 *
 * Hooks (P3): `createSetupHandler`, `createValidateHandler` and
 * `createMigrateConfigHandler` serve the kernel's maintenance start
 * (reason `setup`) at `/api/lifecycle/setup`, `/api/lifecycle/validate` and
 * `/api/lifecycle/migrate-config`, like `createLifecycleHandler`.
 */
import { OsError, osErrorFrom } from './errors.js';
import { isBrowser, osAuthHeaders, osBase } from './os-auth.js';
import type { APIRoute } from 'astro';
import type { MigrateConfigInput, MigrateConfigResult, SetupConfig, SetupHookInput, SetupReason, ValidateResult } from './setup-types.js';

// ── P4: config ──────────────────────────────────────────────────────────────

function isSetupConfig(v: unknown): v is SetupConfig {
  const c = v as Partial<SetupConfig> | null;
  return !!c && typeof c === 'object' && typeof c.appId === 'string' && typeof c.installationId === 'string'
    && (c.profile === null || typeof c.profile === 'string') && !!c.values && typeof c.values === 'object'
    && !!c.secrets && typeof c.secrets === 'object' && Array.isArray(c.degraded) && typeof c.configDigest === 'string';
}

export class SetupApi {
  /**
   * Your installation's effective setup values, on your app's server.
   * `opts.token`: another instance token than `AURA_INSTANCE_TOKEN`.
   */
  async config(opts: { token?: string } = {}): Promise<SetupConfig> {
    if (isBrowser()) throw new OsError(0, 'server-only', 'setup.config runs on your app\'s server: a page never sees setup values');
    const base = osBase({ mode: 'server' });
    if (!base) throw new OsError(0, 'no-os', 'setup.config: OS_API_BASE is unset (run inside AuraOS)');
    const url = `${base}/api/setup/self`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) },
    });
    if (!res.ok) throw await osErrorFrom(res, 'setup.config');
    const body: unknown = await res.json().catch(() => null);
    if (!isSetupConfig(body)) throw new OsError(res.status, 'invalid-response', 'setup.config: not a setup configuration');
    return body;
  }
}

// ── P3: hooks ───────────────────────────────────────────────────────────────
/*
 * The app's setup hooks (D108 decision 8). The kernel calls them on the
 * app's own server in a maintenance start (no traffic routed), with the
 * app's identity: put each in its route file,
 *
 *   // src/pages/api/lifecycle/setup.ts
 *   export const POST = createSetupHandler(async ({ configDigest, attempt, reason }) => {
 *     const cfg = await osClient.setup.config();   // the values being set up
 *     await migrateMyData(cfg);                     // MUST be idempotent: it may run again
 *   });
 *
 *   // src/pages/api/lifecycle/validate.ts
 *   export const POST = createValidateHandler(async () => ({ ok: await canLogIn() }));
 *
 * A thrown error (or `{ ok: false, message }`) fails the setup: the owner
 * sees your message, labelled as your app's words. Never put a secret in it.
 */

const SETUP_REASONS: ReadonlySet<string> = new Set(['setup', 'reconfigure', 'repair', 'migrate']);

function hookJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function hookBody(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return null; }
}

/** The kernel's `onSetup` input, or null when the body is not one. */
export function parseSetupHookInput(raw: unknown): SetupHookInput | null {
  const b = raw as Partial<SetupHookInput> | null;
  if (!b || typeof b !== 'object' || typeof b.configDigest !== 'string' || !Number.isSafeInteger(b.attempt)
    || (b.previousDigest !== null && typeof b.previousDigest !== 'string') || typeof b.reason !== 'string' || !SETUP_REASONS.has(b.reason)) return null;
  return { configDigest: b.configDigest, previousDigest: b.previousDigest ?? null, attempt: b.attempt as number, reason: b.reason as SetupReason };
}

/** `onSetup`, framework-neutral: the input checked, `impl`, `{ ok }`; a failure is `{ ok: false, message }` (500). */
export async function runSetupHook(request: Request, impl?: (input: SetupHookInput) => void | Promise<void>): Promise<Response> {
  const input = parseSetupHookInput(await hookBody(request));
  if (!input) return hookJson({ ok: false, message: 'not a setup hook call' }, 400);
  try {
    if (impl) await impl(input);
  } catch (err) {
    return hookJson({ ok: false, message: err instanceof Error ? err.message : String(err) }, 500);
  }
  return hookJson({ ok: true });
}

/** `onValidate`, framework-neutral: `impl`'s `ValidateResult` (default `{ ok: true }`); it cannot change state. */
export async function runValidateHook(request: Request, impl?: (input: { configDigest: string }) => ValidateResult | Promise<ValidateResult>): Promise<Response> {
  const raw = await hookBody(request) as { configDigest?: unknown } | null;
  const configDigest = typeof raw?.configDigest === 'string' ? raw.configDigest : '';
  try {
    const r = impl ? await impl({ configDigest }) : { ok: true };
    if (!r || typeof r.ok !== 'boolean') return hookJson({ ok: false, message: 'onValidate returned no { ok }' }, 500);
    return hookJson(r);
  } catch (err) {
    return hookJson({ ok: false, message: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** `onMigrateConfig` (P8 calls it after the declarative renames): the migrated values. */
export async function runMigrateConfigHook(request: Request, impl: (input: MigrateConfigInput) => MigrateConfigResult | Promise<MigrateConfigResult>): Promise<Response> {
  const raw = await hookBody(request) as Partial<MigrateConfigInput> | null;
  if (!raw || !Number.isSafeInteger(raw.fromVersion) || !Number.isSafeInteger(raw.toVersion) || !raw.values || typeof raw.values !== 'object') {
    return hookJson({ ok: false, message: 'not a migrate-config call' }, 400);
  }
  try {
    const r = await impl({ fromVersion: raw.fromVersion as number, toVersion: raw.toVersion as number, values: raw.values });
    return hookJson({ values: r.values });
  } catch (err) {
    return hookJson({ ok: false, message: err instanceof Error ? err.message : String(err) }, 500);
  }
}

/** `POST /api/lifecycle/setup`: the app's idempotent initialization for a configuration. */
export function createSetupHandler(impl?: (input: SetupHookInput) => void | Promise<void>): APIRoute {
  return ({ request }) => runSetupHook(request, impl);
}

/** `POST /api/lifecycle/validate`: field checks and connection tests after init. */
export function createValidateHandler(impl?: (input: { configDigest: string }) => ValidateResult | Promise<ValidateResult>): APIRoute {
  return ({ request }) => runValidateHook(request, impl);
}

/** `POST /api/lifecycle/migrate-config`: the values of an older `setup.version`, migrated. */
export function createMigrateConfigHandler(impl: (input: MigrateConfigInput) => MigrateConfigResult | Promise<MigrateConfigResult>): APIRoute {
  return ({ request }) => runMigrateConfigHook(request, impl);
}
