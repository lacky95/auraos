// Namespace import: the running shell may cache an older core build.
import * as core from '@aura/core';
import type { NotificationViewer, Principal } from '@aura/core';

/**
 * Phase 5: who is READING a notification route.
 *
 * A shell screen identifies its client session (one per browser tab) with
 *   header  X-Aura-Client-Session: <sid>       (fetch)
 *   query   ?cs=<sid>                          (EventSource can't set headers)
 *
 * The sid is NOT a credential: it only picks the lock-screen view of an
 * otherwise anonymous caller. Its lock state is resolved here, server-side —
 * missing / invalid / unknown / expired → `locked`. Verified principals
 * (apps, API keys, admin) are not screens; their sid is ignored.
 *
 * `X-Aura-Sender-Token` (from create) proves ownership of one item (get /
 * waitFor), so a browser sender reads its own notification back.
 */
export const CLIENT_SESSION_HEADER = 'x-aura-client-session';

export function clientSessionIdFrom(request: Request, url?: URL): string | null {
  const h = request.headers.get(CLIENT_SESSION_HEADER);
  if (h && h.trim()) return h.trim();
  const q = (url ?? new URL(request.url)).searchParams.get('cs');
  return q && q.trim() ? q.trim() : null;
}

export async function viewerFor(request: Request, principal: Principal, opts: { url?: URL; senderToken?: string } = {}): Promise<NotificationViewer> {
  const viewer: NotificationViewer = { principal: principal as NotificationViewer['principal'] };
  if (opts.senderToken) viewer.senderToken = opts.senderToken;
  if (principal.kind !== 'anonymous') return viewer;
  const sid = clientSessionIdFrom(request, opts.url);
  if (!sid) return viewer;
  const store = (core.getAuthServices() as { clientSessions?: { effectiveLock(sid: string): Promise<'locked' | 'unlocked'> } }).clientSessions;
  const lock = store ? await store.effectiveLock(sid) : 'locked';
  viewer.screen = { sid, lock };
  return viewer;
}
