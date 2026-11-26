import { defineConfig, passthroughImageService } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attachAppHosts, attachSio, attachWsProxy } from './server/attach.mjs';
import { attachExecBridge } from './server/exec-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The shell's non-Astro servers live in ./server/attach.mjs, shared with the
// production entry (server.mjs). In dev they attach to Vite's HTTP server:

/** App hosts (server/app-hosts.mjs): in front of Vite, like in front of the prod handler. */
function appHostsPlugin() {
  return {
    name: 'aura-app-hosts',
    configureServer(server) {
      if (server.httpServer) attachAppHosts(server.httpServer);
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

/** The exec bridge (server/exec-bridge.mjs): `aura exec`/`jump`/`logs` through the shell. The shell runs in dev on every install. */
function execBridgePlugin() {
  return {
    name: 'aura-exec-bridge',
    configureServer(server) {
      if (server.httpServer) attachExecBridge(server.httpServer);
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
  // No image transcoding: the shell doesn't use astro:assets, so Sharp behind
  // `/_image` would only be an image decoder anyone can feed
  // (GHSA-26w7-cxv4-gfx2 was one). Apps: the same via auraAppIntegration.
  image: { service: passthroughImageService() },
  // Astro 7 defaults to 'jsx', which drops the whitespace between inline
  // elements. Keep Astro 6's lossless compression (apps: auraAppIntegration).
  compressHTML: true,
  // Astro's floating dev toolbar (audits / settings / x-ray) sits in the
  // bottom-right of every page in dev mode and gets in the way of OS
  // chrome — covers the launcher button, intercepts clicks on the dock
  // edge. Apps all opt out of it; the shell should too.
  devToolbar: { enabled: false },
  security: {
    // Astro's check covers form posts only. The shell's one Origin check runs
    // in front of Astro for every write and WebSocket upgrade instead
    // (server/host-policy.mjs `browserBoundaryError`, policy `shell`).
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
      // socket.io-client (lib/osEvents.ts) and lucide (via @aura/core) are only reached from
      // the desktop's client scripts. Left out, Vite discovers them on the
      // very first page load, re-optimizes and invalidates the modules that
      // page is still importing — on a fresh install the first desktop then
      // dies with "Failed to fetch dynamically imported module
      // .../astro:scripts/before-hydration.js" (dead clock, no notifications)
      // until the user reloads. Pre-bundling them at server start avoids it.
      include: ['react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'socket.io-client', '@aura/core > lucide'],
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
    plugins: [tailwindcss(), appHostsPlugin(), wsProxyPlugin(), execBridgePlugin(), sioPlugin()],
  },
});
