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
  integrations: [auraAppIntegration()],
  vite: {
    server: { hmr: false },
  },
});
