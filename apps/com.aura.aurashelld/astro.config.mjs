import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration, resolveAppPort } from '@aura/app-sdk/integration';

// APP_PORT when the OS assigned one, otherwise a free port picked at startup —
// so running this service by hand (or `astro check`) never fights 4001.
const port = await resolveAppPort();

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  devToolbar: { enabled: false },
  // Wires up identity headers, injects /api/lifecycle/health, and logs the
  // app id at server start. A service has no page; the routes are the app.
  integrations: [auraAppIntegration()],
  vite: { server: { hmr: false } },
});
