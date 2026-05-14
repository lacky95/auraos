import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration } from '@aura/app-sdk/integration';

const port = Number(process.env['APP_PORT'] ?? 4001);

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  // Dev toolbar lives at the document root and tries to use Vite HMR — both
  // useless inside the shell's iframe. Disable it to keep the iframe clean.
  devToolbar: { enabled: false },
  integrations: [auraAppIntegration()],
  vite: {
    // Disable HMR: the app is loaded inside the shell's iframe and its dev
    // port (e.g. 4001) is not reachable from the browser. Iframe reload picks
    // up code changes; we accept that over a broken WebSocket reconnect loop.
    server: { hmr: false },
  },
});
