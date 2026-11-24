/**
 * The shell API for the `<script is:inline>` blocks, which re-run on every
 * ClientRouter swap and cannot import the SDK. Layout.astro loads this once.
 * Modules run after the inline scripts of a first load, so an inline script
 * reads `window.auraOs` when it acts (a click), or waits for `astro:page-load`.
 *
 *   url(path)          osUrl(): the shell's root on the proxy route, the
 *                      same-origin gateway on an App Host
 *   bodylessHeaders()  what a mutation without a body needs at the gateway
 */
import { bodylessMutationHeaders, osUrl } from '@aura/app-sdk/os-auth';

declare global {
  interface Window {
    auraOs?: { url: typeof osUrl; bodylessHeaders: typeof bodylessMutationHeaders };
  }
}

window.auraOs = { url: osUrl, bodylessHeaders: bodylessMutationHeaders };
