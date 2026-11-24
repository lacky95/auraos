/**
 * The one inline script that makes a document load `/_aura/runtime.js` on an
 * App Host. `auraAppIntegration()` adds it to every Astro page; another
 * framework puts it in its document head:
 *
 *   <script dangerouslySetInnerHTML={{ __html: AURA_RUNTIME_LOADER_JS }} />
 *
 * It is the app's own output, not something a proxy adds (D43). Off an App
 * Host (outside AuraOS, or a host with no app label) it does nothing and
 * requests nothing. While the
 * document is parsing it uses `document.write`, the only way an inline script
 * can load another one that blocks the parser: the bootstrap must exist before
 * any app script reads it, and the theme before first paint. A client-side
 * navigation re-runs it after parsing, where `document.write` would erase the
 * page, so that case appends instead.
 */
import { AURA_RESERVED_PATHS, HOST_NAME_RE, RESERVED_HOST_NAMES } from '../hostRules.js';

/** The shell's public assets that app markup links by absolute path. */
const SHELL_ASSET_RE = /^\/api\/os\/(?:theme\.css|icons\.svg|icons\/[A-Za-z0-9_-]+\.svg)$/;

/** Route patterns for the assets above, for a framework's router. */
export const SHELL_ASSET_ROUTES = ['/api/os/theme.css', '/api/os/icons.svg', '/api/os/icons/[name].svg'] as const;

/**
 * Where an App Host sends a request for a shell asset, or null for any other
 * path or route. `/api/*` is the app's own there, so the app's server answers
 * with this redirect and existing `<link>`, `<use>` and `url()` references work
 * unchanged.
 */
export function appHostAssetLocation(route: string | string[] | null | undefined, url: string): string | null {
  // `//host/…` would parse as another authority.
  if (route !== 'host' || /^[/\\]{2}/.test(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url, 'http://app.invalid'); } catch { return null; }
  if (!SHELL_ASSET_RE.test(parsed.pathname)) return null;
  return `${AURA_RESERVED_PATHS.os}${parsed.pathname.slice(1)}${parsed.search}`;
}

export const AURA_RUNTIME_LOADER_JS = `(function(){try{
if(window.AuraRuntimeBootstrap)return;
var h=location.hostname,a=h.indexOf('--');if(a<=0)return;
var n=h.slice(0,a);if(!${HOST_NAME_RE.toString()}.test(n)||${JSON.stringify([...RESERVED_HOST_NAMES])}.indexOf(n)>=0)return;
var u=${JSON.stringify(AURA_RESERVED_PATHS.runtime)};
if(document.readyState==='loading')document.write('<script src="'+u+'"><\\/script>');
else{var s=document.createElement('script');s.src=u;document.head.appendChild(s);}
}catch(_){}})();`;
