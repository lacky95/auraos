import type { RequestSnapshot } from './types.ts';

/**
 * The only access code on the request path. It has no imports to fail, copies
 * what the observer needs before the response goes out, never touches the
 * body, and hands off without awaiting. Nothing here can throw into a request.
 */

const SESSION_COOKIES = new Set(['aura_session', '__Host-aura_session']);

export const accessReportOff = (): boolean =>
  (process.env['AURA_ACCESS_REPORT'] ?? '').trim().toLowerCase() === 'off';

export interface AccessContext {
  request: Request;
  url: URL;
  routePattern?: string;
  params?: Record<string, string | undefined>;
}

export function captureAccess(ctx: AccessContext): RequestSnapshot | null {
  try {
    if (accessReportOff()) return null;
    const path = ctx.url.pathname;
    // Counted by the server.emit wrapper (server/access-bridge.mjs).
    if (path.startsWith('/_astro/') || path === '/favicon.ico') return null;
    const h = ctx.request.headers;
    const cookie = h.get('cookie');
    return {
      method: ctx.request.method,
      routePattern: ctx.routePattern ?? '',
      pathname: path,
      search: ctx.url.search,
      params: { ...(ctx.params ?? {}) },
      https: ctx.url.protocol === 'https:',
      status: 0,
      internal: h.get('x-aura-internal-service'),
      identity: {
        authorization: h.get('authorization'),
        sessionCookie: !!cookie && cookie.split(';').some((c) => SESSION_COOKIES.has(c.split('=', 1)[0]!.trim())),
        referer: h.get('referer'),
        instanceId: h.get('x-aura-instance-id'),
      },
    };
  } catch {
    return null;
  }
}

export interface AccessObserverModule {
  observeRequest(snapshot: RequestSnapshot): unknown;
}

/** One guarded import: a failed load stays failed until the next build. */
export function createAccessReporter(load: () => Promise<AccessObserverModule>) {
  let loaded: Promise<AccessObserverModule | null> | null = null;
  return (snapshot: RequestSnapshot | null, status: number): void => {
    if (!snapshot) return;
    try {
      snapshot.status = status;
      loaded ??= Promise.resolve().then(load).catch(() => null);
      void loaded.then((m) => m?.observeRequest(snapshot)).catch(() => undefined);
    } catch { /* report-only */ }
  };
}
