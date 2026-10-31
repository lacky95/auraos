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
  // Pages are server-rendered; ClientRouter (Layout.astro) swaps them in
  // place, and prefetching on hover / when links scroll into view on touch
  // makes a tab or an app's detail page open without a visible load.
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  integrations: [auraAppIntegration()],
  vite: {
    server: { hmr: false },
  },
});
