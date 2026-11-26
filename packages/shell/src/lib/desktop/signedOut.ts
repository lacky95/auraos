/**
 * The desktop's login ended while the tab was open (it expired, was revoked,
 * or the owner signed out elsewhere): in `enforce` the shell answers the
 * desktop's reads 401. The tab then goes to the sign-in once, returning to
 * this page, instead of asking again every few seconds. DOM-free but for the
 * `location` it is given.
 */

/**
 * The sign-in for this page, with the same `next` as the server's redirect
 * (authSurface.ts `loginLocation`): the path and query, left out for `/`.
 * The fragment stays on the URL; the sign-in page adds it back (login.astro).
 */
export function signInUrl(loc: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  const here = `${loc.pathname}${loc.search}`;
  const next = here === '/' || loc.pathname === '/login' ? '' : `?next=${encodeURIComponent(here)}`;
  return `/login${next}${loc.hash}`;
}

let leaving = false;

/**
 * Call with the status of a desktop read of the shell. A 401 sends the tab to
 * the sign-in, once per page. True when the tab is leaving.
 */
export function leaveIfSignedOut(status: number, loc: Location | undefined = globalThis.location): boolean {
  if (status !== 401 || !loc) return false;
  if (!leaving) {
    leaving = true;
    loc.replace(signInUrl(loc));
  }
  return true;
}

/** Test hook. */
export function _resetSignedOut(): void {
  leaving = false;
}
