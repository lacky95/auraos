/**
 * Opens an http(s) address in a browser tab of its own: no opener (the page
 * cannot reach or navigate the desktop) and no Referer. The desktop is the
 * one top-level, unsandboxed document, so a tab it opens carries no App Host
 * sandbox either; that is what sign-in and payment flows that fail inside an
 * app frame need. Browsers allow it only right after a user gesture (the
 * popup blocker), which reaches the desktop from a click in an app frame too.
 */
import { safeHttpUrl } from './notifications/format.ts';

export function openExternalTab(href: unknown): boolean {
  const safe = safeHttpUrl(typeof href === 'string' ? href : null);
  if (!safe) return false;
  window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}
