import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration , resolveAppPort } from '@aura/app-sdk/integration';

// APP_PORT when the OS assigned one, otherwise a free port picked at
// startup — so running this app by hand (or `astro check`) never fights
// whatever already holds 4001.
const port = await resolveAppPort();

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
    // Disable HMR: the app runs inside the shell's iframe and its dev port
    // (e.g. 4001) is not reachable from the browser. Iframe reload picks up
    // code changes; we accept that over a broken WebSocket reconnect loop.
    server: { hmr: false },
  },
});
