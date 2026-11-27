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
 * D108 P4: the config part. P3 adds the hook handlers (`createSetupHandler`,
 * `createValidateHandler`) to this file in its own region.
 */
import { OsError, osErrorFrom } from './errors.js';
import { isBrowser, osAuthHeaders, osBase } from './os-auth.js';
import type { SetupConfig } from './setup-types.js';

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
