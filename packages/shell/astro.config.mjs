import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attachShellSseMux, attachSio, attachWsProxy, proxyQueryEscapeMiddleware,
} from './server/attach.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The shell's non-Astro servers live in ./server/attach.mjs, shared with the
// production entry (server.mjs). In dev they attach to Vite's HTTP server:

/**
 * Rewrite `/api/proxy/<id>/<path>?astro|?vue|?svelte` BEFORE vite-plugin-astro
 * sees it (it would try to compile the app's file relative to packages/shell).
 * Registered WITHOUT returning a function from configureServer so it lands
 * BEFORE Vite's internal middlewares.
 */
function proxyViteQueryEscape() {
  return {
    name: 'aura-proxy-vite-query-escape',
    configureServer(server) {
      server.middlewares.use(proxyQueryEscapeMiddleware);
    },
  };
}

function wsProxyPlugin() {
  return {
    name: 'aura-ws-proxy',
    configureServer(server) {
      if (server.httpServer) attachWsProxy(server.httpServer);
    },
  };
}

function sseMuxPlugin() {
  return {
    name: 'aura-sse-mux',
    async configureServer(server) {
      if (server.httpServer) await attachShellSseMux(server.httpServer);
    },
  };
}

function sioPlugin() {
  return {
    name: 'aura-sio',
    async configureServer(server) {
      if (server.httpServer) await attachSio(server.httpServer);
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  // Astro's floating dev toolbar (audits / settings / x-ray) sits in the
  // bottom-right of every page in dev mode and gets in the way of OS
  // chrome — covers the launcher button, intercepts clicks on the dock
  // edge. Apps all opt out of it; the shell should too.
  devToolbar: { enabled: false },
  security: {
    checkOrigin: false,
  },
  server: {
    port: 3000,
    host: true,
  },
  vite: {
    // Point workspace packages to their TypeScript source for full hot
    // reload — bare imports only. Subpath imports (`@aura/ui/styles/...`,
    // `@aura/ui/lib/...`) flow through pnpm's `node_modules/@aura/ui`
    // symlink so the `exports` map in @aura/ui's package.json kicks in,
    // and `ssr.noExternal: ['@aura/ui']` below can match by package name
    // (it would not match a pre-resolved file path).
    resolve: {
      alias: [
        { find: /^@aura\/core$/, replacement: resolve(__dirname, '../core/src/index.ts') },
        { find: /^@aura\/ui$/,   replacement: resolve(__dirname, '../ui/src/index.ts') },
      ],
    },
    server: {
      watch: {
        ignored: ['**/node_modules/**', '**/.git/**'],
      },
      // Sibling-container apps call back into the shell at `http://aura-shell:3000`
      // (the aura-net hostname). Vite 5+ rejects Host headers it hasn't been
      // told about, so without this the CLI from inside any container app
      // gets a 403 "Blocked request" on every call. `true` allows any host —
      // safe in our dev container, the shell isn't reachable from the public
      // internet.
      allowedHosts: true,
    },
    optimizeDeps: {
      // Exclude workspace-source packages so Vite reads them fresh from
      // their .ts source on each change (full HMR). @aura/ui used to be
      // here too, but its Radix sub-deps need pre-bundling for proper CJS
      // named-export interop (Vite can't surface `createRoot` from
      // react-dom/client otherwise — hydration explodes).
      exclude: ['@aura/core'],
      include: ['react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
    // SSR-process @aura/ui through Vite (it ships .css + .tsx). Vite would
    // otherwise treat workspace packages as external and Node's native
    // loader would choke on `.css` ("Unknown file extension").
    //
    // @aura/core is here too so subpath imports (`@aura/core/keymap`,
    // `@aura/core/theme`) flow through Vite's HMR-aware loader instead
    // of Node's process-lifetime module cache — otherwise a `tsc` build
    // of @aura/core's dist requires a full container restart before the
    // shell sees the new code. The bare `@aura/core` import is already
    // aliased to src/index.ts above, but subpath imports bypass that
    // alias and hit the package's `exports` map → dist files → Node
    // loader cache.
    ssr: {
      noExternal: ['@aura/ui', '@aura/core', '@aura/kv-store', '@aura/app-sdk'],
    },
    // tailwindcss() must come before wsProxyPlugin so its content-scanning
    // hooks run on every transformed module.
    plugins: [tailwindcss(), proxyViteQueryEscape(), wsProxyPlugin(), sseMuxPlugin(), sioPlugin()],
  },
});
