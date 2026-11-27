/**
 * `osClient.apps`: app composition (D104). Read ANOTHER app's pages and
 * read-only API for the user, on your app's server.
 *
 *   // app.manifest.json: "permissions": ["apps.view"]
 *   const sentinel = await osClient.apps.view({ appId: 'com.aura.sentinel', desktop: '10-1-2-3.nip.io:3000' });
 *   const res = await sentinel.fetch('/api/findings');   // GET, as the user, read-only
 *
 * The first call asks the owner (one click in AuraOS's dialog; the request
 * may wait while the owner holds it). Approving grants `apps.view` for that
 * target until the owner revokes it (`aura revoke perms <app> apps.view
 * --target <target>`). Every refusal is an `OsError` whose `hint` says what is
 * missing: the manifest permission, the owner's grant, a target that is not a
 * normal app or that opted out (`composition.view: "deny"`).
 *
 * What it can do: GET and HEAD on the target's own App Host (its pages,
 * assets and API), as the user; no other method, no WebSocket, no event
 * stream, no AuraOS API through the target. The target sees
 * `x-aura-access: view` and `x-aura-access-by: <your app id>` and may refuse.
 *
 * The credential (a short-lived restricted cookie) stays in this object, on
 * your server: never send it to a page, and `fetch()` never follows a
 * redirect or reaches any other host with it. It is renewed by itself; a
 * revoke ends it on the next request.
 *
 * Targets: an app id plus the desktop host your users open AuraOS at
 * (`appHostUrlFromRequest(request, …)` or the request's Host tells it), or
 * an App Host address (`{ host: 'sentinel--10-1-2-3.nip.io:3000' }`).
 *
 * For a target: `delegatedAccess(request)` tells you a request is such a read.
 */
import { ApprovalsApi, approvalHeader, type ApprovalWaitOptions } from './approvals.js';
import { OsError, osErrorFrom } from './errors.js';
import { isBrowser, osAuthHeaders, osBase } from './os-auth.js';

/** Which app to read: its id and the desktop host, or one of its App Host addresses. */
export type AppViewTarget = { appId: string; desktop: string } | { host: string };

export interface AppViewFetchInit {
  method?: 'GET' | 'HEAD';
  /** Request headers. Cookie, Host and Authorization are AuraOS's and are dropped. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** One target, read as the user. */
export interface AppView {
  /** The target's app id. */
  readonly appId: string;
  /** The target's App Host name, e.g. `sentinel--10-1-2-3.nip.io:3000`. */
  readonly host: string;
  /**
   * GET or HEAD `path` (`/…`, same host only) on the target. Redirects come
   * back as they are (3xx with `location`); never followed with the credential.
   */
  fetch(path: string, init?: AppViewFetchInit): Promise<Response>;
}

interface Handoff { url: string; origin: string; host: string; appId: string; expiresAt: number }

const RENEW_BEFORE_MS = 30_000;
const DROPPED_HEADERS = new Set(['cookie', 'host', 'authorization', 'connection', 'transfer-encoding', 'content-length']);

/** A request's delegated access, for a target app's server: `{level:'view', by}` or null. */
export function delegatedAccess(request: Request): { level: 'view'; by: string } | null {
  if (request.headers.get('x-aura-access') !== 'view') return null;
  const by = request.headers.get('x-aura-access-by');
  return by ? { level: 'view', by } : null;
}

/** node:http, loaded only on the server (a page never reads another app). */
async function nodeHttp(): Promise<typeof import('node:http')> {
  const name = 'node:http';
  return import(/* @vite-ignore */ name);
}

/**
 * One HTTP request to the shell with a Host of `host` (the App Host), raw:
 * Node's fetch can't set Host, and must not follow redirects anyway.
 */
async function hostRequest(
  base: string, host: string, path: string, method: string, headers: Record<string, string>, signal?: AbortSignal,
): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null; setCookie: string[] }> {
  const http = await nodeHttp();
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method, path,
      headers: { ...headers, host }, signal,
    }, (res) => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (k === 'set-cookie' || v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [String(v)]) out.append(k, one);
      }
      const setCookie = res.headers['set-cookie'] ?? [];
      const body = method === 'HEAD' ? null : new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          res.on('end', () => controller.close());
          res.on('error', (err) => controller.error(err));
        },
        cancel() { res.destroy(); },
      });
      if (method === 'HEAD') res.resume();
      resolve({ status: res.statusCode ?? 502, headers: out, body, setCookie });
    });
    req.on('error', reject);
    req.end();
  });
}

export class AppsApi {
  private readonly approvals = new ApprovalsApi();

  /**
   * Read `target` as the user, from your server. Asks the owner the first time
   * (waits like `approvals.wait`); rejects with an `OsError` whose `hint` says
   * what is missing when the answer is no.
   */
  async view(target: AppViewTarget, opts: ApprovalWaitOptions = {}): Promise<AppView> {
    if (isBrowser()) throw new OsError(0, 'server-only', 'apps.view runs on your app\'s server: a page never gets another app\'s access', {
      facts: { hint: 'Call osClient.apps.view(...) in a server route and send your page only what it needs.', permission: 'apps.view' },
    });
    const base = osBase({ mode: 'server' });
    if (!base) throw new OsError(0, 'no-os', 'apps.view: OS_API_BASE is unset (run inside AuraOS)');
    const askUrl = `${base}/api/app-hosts/view`;
    const ask = (approvalId?: string) => fetch(askUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...osAuthHeaders(askUrl, opts.token !== undefined ? { token: opts.token } : {}),
        ...(approvalId ? approvalHeader(approvalId) : {}),
      },
      body: JSON.stringify(target),
    });

    const handoff = async (): Promise<Handoff> => {
      let res = await ask();
      if (res.status === 202) {
        const asked = await res.json().catch(() => ({})) as { approvalId?: unknown; hint?: unknown; target?: unknown };
        if (typeof asked.approvalId !== 'string') throw new OsError(202, 'invalid-response', 'apps.view: no approval id');
        const answer = await this.approvals.wait(asked.approvalId, opts);
        if (!answer.approved) {
          const named = typeof asked.target === 'string' ? asked.target : 'the target';
          throw new OsError(403, 'access-denied', `apps.view for ${named} was not granted (${answer.outcome})`, {
            facts: { reason: 'approval-required', permission: 'apps.view', ...(typeof asked.hint === 'string' ? { hint: asked.hint } : {}),
              ...(typeof asked.target === 'string' ? { target: asked.target } : {}) },
          });
        }
        res = await ask(asked.approvalId);
      }
      if (!res.ok) throw await osErrorFrom(res, 'apps.view');
      const body = await res.json() as Partial<Handoff>;
      if (typeof body.url !== 'string' || typeof body.host !== 'string' || typeof body.appId !== 'string' || typeof body.expiresAt !== 'number') {
        throw new OsError(res.status, 'invalid-response', 'apps.view: no handoff');
      }
      return body as Handoff;
    };

    /** Redeem a handoff on the target's own App Host: the restricted cookie, kept here. */
    const redeem = async (h: Handoff): Promise<{ cookie: string; until: number }> => {
      const u = new URL(h.url);
      if (u.host !== h.host) throw new OsError(0, 'invalid-response', 'apps.view: the handoff names another host');
      const r = await hostRequest(base, h.host, `${u.pathname}${u.search}`, 'GET', {});
      void r.body?.cancel();
      const cookie = r.setCookie.map((c) => c.split(';', 1)[0]!.trim()).find((c) => /_view=/.test(c));
      if (r.status !== 303 || !cookie) throw new OsError(r.status, 'access-denied', 'apps.view: the target refused the handoff (revoked meanwhile?)');
      return { cookie, until: h.expiresAt };
    };

    let h = await handoff();
    let cred = await redeem(h);
    const renew = async () => { h = await handoff(); cred = await redeem(h); };

    const view: AppView = {
      appId: h.appId,
      host: h.host,
      fetch: async (path, init = {}) => {
        const method = init.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') throw new OsError(0, 'access-denied', `apps.view is read-only: ${method} is refused`, {
          facts: { reason: 'rule-denied', permission: 'apps.view', hint: 'Read with GET or HEAD.' },
        });
        // Same host only: an absolute URL, `//host` or a backslash could carry the credential elsewhere.
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\s]/.test(path)) {
          throw new OsError(0, 'invalid-request', `apps.view: '${String(path).slice(0, 80)}' is not a path on ${h.host}`, {
            facts: { hint: 'Pass a path like /page?x=1; the view reads its own target only.' },
          });
        }
        if (Date.now() > cred.until - RENEW_BEFORE_MS) await renew();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(init.headers ?? {})) if (!DROPPED_HEADERS.has(k.toLowerCase())) headers[k] = v;
        const send = () => hostRequest(base, h.host, path, method, { ...headers, cookie: cred.cookie }, init.signal);
        let r = await send();
        if (r.status === 403 && r.headers.get('content-type')?.includes('json')) {
          // Expired or revoked: one fresh handoff (asks the owner again if the grant is gone).
          const peek = await new Response(r.body).json().catch(() => null) as { reason?: unknown } | null;
          if (peek?.reason !== 'approval-required') return new Response(JSON.stringify(peek), { status: 403, headers: r.headers });
          await renew();
          r = await send();
        }
        const nullBody = r.status === 204 || r.status === 205 || r.status === 304 || r.status < 200;
        if (nullBody) void r.body?.cancel();
        return new Response(nullBody ? null : r.body, { status: r.status, headers: r.headers });
      },
    };
    return view;
  }
}
