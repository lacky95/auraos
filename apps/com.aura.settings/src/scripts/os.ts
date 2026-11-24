/**
 * The shell API for `<script is:inline>` blocks, which cannot import the SDK.
 * Every page that has one imports this from its bundled `<script>`. Modules run
 * after the inline scripts, so an inline script reads `window.auraOs` when it
 * acts (a click, a timer), never while the page is still being parsed.
 *
 *   url(path)          osUrl(): the shell's root on the proxy route, the
 *                      same-origin gateway on an App Host
 *   bodylessHeaders()  what a mutation without a body needs at the gateway
 *   appHost()          the App Host bootstrap, or null on the proxy route
 */
import { postToShell, isFromShell } from '@aura/app-sdk';
import { appHostRuntime, bodylessMutationHeaders, osUrl } from '@aura/app-sdk/os-auth';

declare global {
  interface Window {
    auraOs?: {
      url: typeof osUrl;
      bodylessHeaders: typeof bodylessMutationHeaders;
      appHost: typeof appHostRuntime;
      postToShell: typeof postToShell;
      isFromShell: typeof isFromShell;
    };
  }
}

window.auraOs = {
  url: osUrl,
  bodylessHeaders: bodylessMutationHeaders,
  appHost: appHostRuntime,
  postToShell,
  isFromShell,
};
