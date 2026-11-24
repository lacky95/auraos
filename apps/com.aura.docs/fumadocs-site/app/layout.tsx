import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { AURA_RUNTIME_LOADER_JS } from '@aura/app-sdk/runtime/loader';

// Sync `<html class="dark">` with the AuraOS color-mode resolution BEFORE
// React hydrates. The resolved mode comes from the bootstrap of
// `/_aura/runtime.js` (loaded by AURA_RUNTIME_LOADER_JS, which therefore runs
// first in <head>).
// Our scificn/fumadocs CSS tokens are already bound to `var(--aura-color-*)`
// so they paint in the right palette automatically — this script only flips the `.dark`
// class so fumadocs's dark-variant utilities + our `.dark .scanlines`
// overlay match the OS's current tone.
//
// We also listen for `aura.mode.changed` postMessages from the shell so
// a live color-mode flip (Settings → light/dark) updates the iframe
// without a reload. Only the Shell itself may send it: the runtime names
// its exact origin, and it is the top window.
const darkBootstrap = `
try {
  function applyMode(mode) {
    var root = document.documentElement;
    if (mode === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
  }
  var B = window.AuraRuntimeBootstrap;
  applyMode(B && B.theme.resolvedMode === 'light' ? 'light' : 'dark');
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (!B || ev.origin !== B.shellOrigin || ev.source !== window.top) return;
    if (d.type === 'aura.mode.changed' && typeof d.resolvedMode === 'string') {
      applyMode(d.resolvedMode);
    }
  });
} catch (e) {}
`;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: AURA_RUNTIME_LOADER_JS }} />
        <script dangerouslySetInnerHTML={{ __html: darkBootstrap }} />
      </head>
      <body className="flex flex-col min-h-screen scanlines">
        <RootProvider theme={{ enabled: false }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
