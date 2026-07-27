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
  integrations: [auraAppIntegration()],
  vite: {
    server: { hmr: false },
    // The project template lives OUTSIDE src/ and is read at request time
    // with fs.readFileSync — keep Vite from trying to transform it.
    optimizeDeps: { exclude: ['@aura/app-sdk'] },
  },
});
