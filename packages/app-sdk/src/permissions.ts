/**
 * `osClient.permissions`: what this app may do now, so it can hide what it
 * may not instead of hitting 403 (D48).
 *
 *   if (!(await osClient.permissions.has('sidecars.spawn'))) hideRunButton();
 *   const held = await osClient.permissions.check(['notifications.popup', 'terminal.embed']);
 *
 * The answer is AuraOS's own decision for this app (its manifest, the
 * owner's grants, and the access mode), the same one a route makes. It can
 * change while the app runs (a grant revoked), so ask when it matters, and
 * still handle a 403. Works in a page (through the App Host gateway) and on
 * the server (with the instance token).
 */
import { OsError, osErrorFrom } from './errors.js';
import { isBrowser, osAuthHeaders, osBase } from './os-auth.js';

export class PermissionsApi {
  /** Whether this app holds `permission` now. */
  async has(permission: string, opts: { token?: string } = {}): Promise<boolean> {
    return (await this.check([permission], opts))[permission] === true;
  }

  /** Each permission → held now. At most 32 per call. */
  async check(permissions: readonly string[], opts: { token?: string } = {}): Promise<Record<string, boolean>> {
    const names = [...new Set(permissions)];
    if (names.length === 0) return {};
    if (names.length > 32) throw new OsError(0, 'too-many', 'permissions.check: at most 32 permissions per call');
    const q = new URLSearchParams();
    for (const p of names) q.append('p', p);
    const url = `${osBase({ mode: isBrowser() ? 'relative' : 'server' })}/api/user/me/permissions?${q}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) },
    });
    if (!res.ok) throw await osErrorFrom(res, 'permissions.check');
    const body = await res.json().catch(() => null) as { permissions?: Record<string, unknown> } | null;
    return Object.fromEntries(names.map((p) => [p, body?.permissions?.[p] === true]));
  }
}
