/**
 * `osClient.credentials`: ask the owner for a secret, get a handle (D56).
 *
 *   // app.manifest.json: "permissions": ["credentials.request"]
 *   const r = await osClient.credentials.request({
 *     name: 'GITHUB_TOKEN', label: 'GitHub token', purpose: 'Push your notes to your repository',
 *   });
 *   if (r.ok) await saveSetting('github', r.handle);   // keep the handle, not a value
 *
 *   // later, on your server only:
 *   const token = await osClient.credentials.get(handle);
 *
 * `request()` makes AuraOS show its own dialog: the verified requesting app,
 * the app that will use the secret, and your `label` and `purpose` labelled
 * as your words. The owner types the secret there, never into your page, and
 * AuraOS keeps it in the owner's personal vault. You get back only
 * `{ handle, name }`. `scope`: `'app'` (default) for this app, or
 * `{ app: '<app id>' }` for another installed app that will use it.
 *
 * `get(handle)` reads the value on your app's server, with its instance
 * token, never in a page. The first read asks the owner once more, with their
 * password (a `fresh` approval: the request waits in the desktop's pending
 * list); approving it grants this app `credential.read:<NAME>` for that user
 * until the owner revokes it in Settings → Users & Identities → Secrets.
 * After that, `osClient.context.get(NAME)` returns it too.
 *
 * A handle is not a secret by itself, but it works only for the app it was
 * made for and only for the user who typed the secret.
 */
import { ApprovalsApi, approvalHeader, type ApprovalOutcome, type ApprovalWaitOptions } from './approvals.js';
import { OsError, osErrorFrom } from './errors.js';
import { isBrowser, osAuthHeaders, osBase } from './os-auth.js';

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HANDLE = /^cred_[A-Za-z0-9_-]{22}$/;

export interface CredentialRequest {
  /** The secret's name in the vault, like a Context key: `GITHUB_TOKEN`. */
  name: string;
  /** What it is, shown to the owner as your words, e.g. `GitHub token`. */
  label?: string;
  /** Why you need it, shown to the owner as your words. */
  purpose?: string;
  /** Who uses it: this app (default), or another installed app. */
  scope?: 'app' | { app: string };
}

export type CredentialResult =
  | { ok: true; handle: string; name: string }
  | { ok: false; outcome: ApprovalOutcome };

export class CredentialsApi {
  private readonly approvals = new ApprovalsApi();

  /**
   * Ask the owner for `name` in AuraOS's dialog. Resolves `{ok: false}` for
   * every kind of "no"; rejects (OsError) on a bad request or a missing
   * `credentials.request` permission.
   */
  async request(req: CredentialRequest, opts: ApprovalWaitOptions = {}): Promise<CredentialResult> {
    if (!NAME.test(req.name)) throw new OsError(0, 'invalid-name', `credentials.request: '${req.name}' is not a credential name (A-Z, 0-9, _)`);
    const base = osBase({ mode: isBrowser() ? 'relative' : 'server' });
    const auth = (url: string) => osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {});
    const scope = req.scope ?? 'app';
    const askUrl = `${base}/api/credentials/requests`;
    const res = await fetch(askUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(askUrl) },
      body: JSON.stringify({ name: req.name, scope, ...(req.label ? { label: req.label } : {}), ...(req.purpose ? { purpose: req.purpose } : {}) }),
    });
    if (!res.ok) {
      const err = await osErrorFrom(res, 'credentials.request');
      if (res.status === 403 && err.code === 'blocked') return { ok: false, outcome: 'blocked' };
      if (res.status === 429) return { ok: false, outcome: 'busy' };
      throw err;
    }
    const created = await res.json().catch(() => ({})) as { id?: unknown };
    if (typeof created.id !== 'string') throw new OsError(res.status, 'invalid-response', 'credentials.request: no request id');
    const answer = await this.approvals.wait(created.id, opts);
    if (!answer.approved) return { ok: false, outcome: answer.outcome };
    const collectUrl = `${base}/api/credentials/requests/${encodeURIComponent(created.id)}`;
    const got = await fetch(collectUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(collectUrl) },
      body: JSON.stringify({ name: req.name, scope }),
    });
    if (!got.ok) throw await osErrorFrom(got, 'credentials.request');
    const body = await got.json().catch(() => ({})) as { handle?: unknown; name?: unknown };
    if (typeof body.handle !== 'string' || typeof body.name !== 'string') throw new OsError(got.status, 'invalid-response', 'credentials.request: no handle');
    return { ok: true, handle: body.handle, name: body.name };
  }

  /**
   * The value behind `handle`, on your app's server. The first read waits for
   * the owner's approval (with their password). Null when the owner said no,
   * or the handle is unknown or revoked.
   */
  async get(handle: string, opts: ApprovalWaitOptions = {}): Promise<string | null> {
    if (isBrowser()) throw new OsError(0, 'server-only', 'credentials.get runs on your app\'s server: a page never sees a credential value');
    if (!HANDLE.test(handle)) throw new OsError(0, 'invalid-handle', 'credentials.get: not a credential handle');
    const base = osBase({ mode: 'server' });
    if (!base) throw new OsError(0, 'no-os', 'credentials.get: OS_API_BASE is unset (run inside AuraOS)');
    const url = `${base}/api/credentials/${encodeURIComponent(handle)}`;
    const read = (approvalId?: string) => fetch(url, {
      headers: {
        accept: 'application/json',
        ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}),
        ...(approvalId ? approvalHeader(approvalId) : {}),
      },
    });
    let res = await read();
    if (res.status === 202) {
      const asked = await res.json().catch(() => ({})) as { approvalId?: unknown };
      if (typeof asked.approvalId !== 'string') return null;
      const answer = await this.approvals.wait(asked.approvalId, opts);
      if (!answer.approved) return null;
      res = await read(asked.approvalId);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw await osErrorFrom(res, 'credentials.get');
    const body = await res.json().catch(() => null) as { value?: unknown } | null;
    return typeof body?.value === 'string' ? body.value : null;
  }
}
