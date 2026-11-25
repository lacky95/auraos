/**
 * `osClient.context`: the Aura Context values (secrets and variables) this
 * app declared, read on its server (D48).
 *
 *   // app.manifest.json: "context": ["OPENAI_API_KEY"]
 *   const key = await osClient.context.get('OPENAI_API_KEY');   // null when the owner hasn't set it
 *
 * Server side only, with the instance token: a page never sees a secret.
 * Only the keys in the manifest's `context[]` are handed out; another key is
 * refused (OsError 403 `context-undeclared`) and shows in the access report.
 *
 * This is the contract for Context from Phase 3 on. Today it reads the one
 * global Context; Phase 5 switches it to values granted per app and user
 * without an API change, and removes the raw mount. Reading `/run/context`
 * or the injected env directly still works until then, but it is not the
 * contract: the contract report lists the apps that do.
 */
import { OsError, osErrorFrom } from './errors.js';
import { isBrowser, osAuthHeaders, osBase } from './os-auth.js';

const KEY = /^[A-Z_][A-Z0-9_]*$/;

export class ContextApi {
  /**
   * The value of `key`, or null when it is not set. `opts.token`: another
   * instance token than `AURA_INSTANCE_TOKEN`.
   */
  async get(key: string, opts: { token?: string } = {}): Promise<string | null> {
    if (isBrowser()) throw new OsError(0, 'server-only', 'context.get runs on your app\'s server: a page never sees a Context value');
    if (!KEY.test(key)) throw new OsError(0, 'invalid-key', `context.get: '${key}' is not a Context key (A-Z, 0-9, _)`);
    const base = osBase({ mode: 'server' });
    if (!base) throw new OsError(0, 'no-os', 'context.get: OS_API_BASE is unset (run inside AuraOS)');
    const url = `${base}/api/os/context/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) },
    });
    if (res.status === 404) {
      const err = await osErrorFrom(res, `context.get ${key}`);
      if (err.code === 'not-set') return null;
      throw err;
    }
    if (!res.ok) throw await osErrorFrom(res, `context.get ${key}`);
    const body = await res.json().catch(() => null) as { value?: unknown } | null;
    return typeof body?.value === 'string' ? body.value : null;
  }
}
