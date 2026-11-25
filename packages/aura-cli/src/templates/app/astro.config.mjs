import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration } from '@aura/app-sdk/integration';

const port = Number(process.env['APP_PORT'] ?? 4001);

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  devToolbar: { enabled: false },
  // Wires up identity headers, injects /api/lifecycle/health, and logs the
  // app id at server start. Apps that need to extend any of these can still
  // ship their own files — Astro's filesystem routes win on collision.
  integrations: [auraAppIntegration()],
  vite: {
    // HMR off: a page reload picks up code changes. The page is served from
    // `/` on its own App Host, which forwards WebSocket upgrades on any path
    // to this server (packages/shell/server/app-hosts.mjs), so Vite's
    // `vite-hmr` socket may well work with this removed — but that is not
    // verified yet. If you turn it on, path-check your own `upgrade`
    // handlers so they leave Vite's socket alone (see CLAUDE.md).
    server: { hmr: false },
  },
});
