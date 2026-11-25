/**
 * The user a request acts for (D46), from its verified principal only:
 *
 *   user       a login session (the desktop, the CLI's login, an App Host
 *              session, the owner through a trusted UI): its user
 *   instance   the user it acts for (the gateway claim's session user, the
 *              token's `u` claim or the instance's server-side owner)
 *   otherwise  the operator, an API key, or an instance that names nobody:
 *              the local owner, the one account of the alpha
 *
 * Never a header, a query parameter or a body field: an app can't choose
 * whose data it reaches.
 */
import * as core from '@aura/core';
import type { AppManager } from '@aura/core';
import type { CallerPrincipal } from './access/identify.js';

/**
 * The bootstrap account (D47 rule 2: local ids stay, the owner stays
 * `default`). The only place the shell names it for "nobody in particular".
 */
export const localOwnerId = (): string => core.DEFAULT_OWNER_ID;

/** The verified user of a principal, or undefined when it names none. */
export function principalUserId(p: CallerPrincipal): string | undefined {
  if (p.kind === 'user') return p.userId;
  if (p.kind === 'instance') return p.userId;
  return undefined;
}

/** The user a principal acts for, falling back to the instance's owner, then the local owner. */
export function actingUserId(p: CallerPrincipal, mgr?: Pick<AppManager, 'getInstance'> | null): string {
  const direct = principalUserId(p);
  if (direct) return direct;
  if (p.kind === 'instance') {
    const owner = (mgr?.getInstance(p.instanceId) as { owner?: string } | undefined)?.owner;
    if (owner) return owner;
  }
  return localOwnerId();
}

/** The user `request` acts for. An unverifiable credential acts for nobody's data: null. */
export async function requestUserId(request: Request): Promise<string | null> {
  const { authenticate } = await import('./auth.js');
  const p = await authenticate(request);
  if (p instanceof Response) return null;
  let mgr: Pick<AppManager, 'getInstance'> | null = null;
  try { mgr = core.getAppManager(); } catch { mgr = null; }
  return actingUserId(p, mgr);
}
