/**
 * App hosts from inside an app: the URL of a host your manifest declares in
 * `hosts[]`, `{name}--{the host AuraOS is open at}`, same scheme and port
 * (docs: /docs/app-hosts). Pure: the same rule as @aura/core app-hosts.
 *
 *   // in the page (any iframe on the desktop's origin, or the top window)
 *   frame.src = appHostUrl('marklayer') + '/s/' + room;
 *   // on the server, from a request the shell proxied to you
 *   const url = appHostUrlFromRequest(request, 'marklayer');
 *
 * Both return null when AuraOS was opened by raw IP (`http://10.0.0.2:3000`):
 * there is no label to prepend — ask the user to use the nip.io address.
 */

import { HOST_NAME_RE, desktopPart, isRawIpHost } from './hostRules.js';

/**
 * URL of app host `name` for a desktop at `desktop` (default: this page's
 * `location`). Inside an app iframe `location` is the desktop's own origin.
 */
export function appHostUrl(name: string, desktop?: { protocol: string; host: string }): string | null {
  const d = desktop ?? (typeof location !== 'undefined' ? location : null);
  if (!d || !HOST_NAME_RE.test(name) || isRawIpHost(d.host)) return null;
  const scheme = d.protocol.replace(/:$/, '') === 'https' ? 'https' : 'http';
  return `${scheme}://${name}--${desktopPart(d.host)}`;
}

/** Same, for a request the shell proxied to your server (reads `X-Forwarded-Proto` / `-Host`). */
export function appHostUrlFromRequest(request: Request, name: string): string | null {
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host') || u.host;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol;
  return appHostUrl(name, { protocol: proto, host });
}
