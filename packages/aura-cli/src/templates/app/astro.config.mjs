import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraIdentityIntegration } from '@aura/app-sdk/integration';

const port = Number(process.env['APP_PORT'] ?? 4001);

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  devToolbar: { enabled: false },
  integrations: [auraIdentityIntegration()],
  vite: {
    server: { hmr: false },
  },
});
