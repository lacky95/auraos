import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

// Sync `<html class="dark">` with the AuraOS color-mode resolution BEFORE
// React hydrates. The shell proxy injects `<meta name="aura-resolved-mode">`
// into every iframe (themeStrategy='inherit'), and our scificn/fumadocs
// CSS tokens are already bound to `var(--aura-color-*)` so they paint in
// the right palette automatically — this script only flips the `.dark`
// class so fumadocs's dark-variant utilities + our `.dark .scanlines`
// overlay match the OS's current tone.
//
// We also listen for `aura.mode.changed` postMessages from the shell so
// a live color-mode flip (Settings → light/dark) updates the iframe
// without a reload.
const darkBootstrap = `
try {
  function applyMode(mode) {
    var root = document.documentElement;
    if (mode === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
  }
  var m = document.querySelector('meta[name="aura-resolved-mode"]');
  applyMode(m && m.getAttribute('content') === 'light' ? 'light' : 'dark');
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'aura.mode.changed' && typeof d.resolvedMode === 'string') {
      applyMode(d.resolvedMode);
    }
  });
} catch (e) {}
`;

// The search dialog's default fetch URL is built as
// `new URL("/api/search", window.location.origin)` inside fumadocs-core,
// which bypasses Next.js's basePath and lands at the SHELL origin instead
// of this app's proxy prefix. We override the `api` prop so the request
// goes to the right place. basePath is derived from APP_INSTANCE_ID at
// server-start (next.config.mjs) and the same env var is available here
// at SSR; Next inlines the string at build time so the client gets a
// concrete URL.
const INSTANCE_ID = process.env.APP_INSTANCE_ID || process.env.APP_ID || 'com.aura.docs';
const SEARCH_API = `/api/proxy/${INSTANCE_ID}/api/search`;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: darkBootstrap }} />
      </head>
      <body className="flex flex-col min-h-screen scanlines">
        <RootProvider
          theme={{ enabled: false }}
          search={{ options: { api: SEARCH_API } }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
