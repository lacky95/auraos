import { accessMode } from '../../../server/access-mode.mjs';
import type { RequestSnapshot, VerifiedIdentity } from './types.ts';

/**
 * The only access code on the request path. Its one import has no imports
 * of its own (the AURA_ACCESS_ENFORCE read point). It copies
 * what the observer needs before the response goes out, never touches the
 * body, and hands off without awaiting. Nothing here can throw into a request.
 * The snapshot never holds a credential: identity is the resolver's verdict,
 * started by `identify` while the request is in hand.
 */

export interface AccessContext {
  request: Request;
  url: URL;
  routePattern?: string;
  params?: Record<string, string | undefined>;
}

export function captureAccess(ctx: AccessContext): RequestSnapshot | null {
  try {
    if (accessMode() === 'off') return null;
    const path = ctx.url.pathname;
    // Counted by the server.emit wrapper (server/access-bridge.mjs).
    if (path.startsWith('/_astro/') || path === '/favicon.ico') return null;
    const h = ctx.request.headers;
    return {
      method: ctx.request.method,
      routePattern: ctx.routePattern ?? '',
      pathname: path,
      search: ctx.url.search,
      params: { ...(ctx.params ?? {}) },
      https: ctx.url.protocol === 'https:',
      status: 0,
      internal: h.get('x-aura-internal-service'),
      // Presence only (lib/approvals `APPROVAL_HEADER`); the handler checks and consumes it.
      approval: h.has('x-aura-approval'),
      identity: {
        verified: null,
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
  /** Absent in an observer built before identity resolution: the snapshot stays unverified. */
  identifyAccess?(request: Request): Promise<VerifiedIdentity | null>;
}

/**
 * One guarded import: a failed load stays failed until the next build. The
 * reporter takes the snapshot and the status; `identify` starts resolving the
 * request's identity (lib/access/identify.ts) into the snapshot, without
 * awaiting it.
 */
export function createAccessReporter(load: () => Promise<AccessObserverModule>) {
  let loaded: Promise<AccessObserverModule | null> | null = null;
  const observer = () => (loaded ??= Promise.resolve().then(load).catch(() => null));
  const report = (snapshot: RequestSnapshot | null, status: number): void => {
    if (!snapshot) return;
    try {
      snapshot.status = status;
      void observer().then((m) => m?.observeRequest(snapshot)).catch(() => undefined);
    } catch { /* report-only */ }
  };
  const identify = (snapshot: RequestSnapshot | null, request: Request): void => {
    if (!snapshot) return;
    try {
      snapshot.identity.verified = observer()
        .then((m) => m?.identifyAccess?.(request) ?? null)
        .catch(() => null);
    } catch { /* report-only */ }
  };
  return Object.assign(report, { identify });
}
