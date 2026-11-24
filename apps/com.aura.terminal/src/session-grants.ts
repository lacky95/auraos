/**
 * Tell the OS that a session is gone (root `exit`, or killed), so every app's
 * grant to show it goes too (D25). A later session under the same name must
 * not inherit one. Fire and forget: the OS also drops the grants when this
 * whole instance ends.
 */
import { osAuthHeaders } from '@aura/app-sdk';

const OS_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

export function releaseSessionGrants(sessionId: string): void {
  const url = `${OS_BASE}/api/terminal/sessions/ended?id=${encodeURIComponent(sessionId)}`;
  const headers = osAuthHeaders(url);
  if (!headers['Authorization']) return;   // not run by the OS (tests, by hand): nobody to tell
  fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(5_000) })
    .then((r) => { if (!r.ok) console.warn(`[terminal] session grants of ${sessionId} not released: HTTP ${r.status}`); })
    .catch((err) => console.warn(`[terminal] session grants of ${sessionId} not released: ${(err as Error).message}`));
}
