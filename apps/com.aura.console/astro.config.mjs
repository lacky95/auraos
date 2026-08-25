import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { auraAppIntegration , resolveAppPort } from '@aura/app-sdk/integration';

// APP_PORT when the OS assigned one, otherwise a free port picked at
// startup — so running this app by hand (or `astro check`) never fights
// whatever already holds 4001.
const port = await resolveAppPort();

function logWsIntegration() {
  return {
    name: 'aura-console-log-ws',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        const { getLogWss, getLogFilePath } = await server.ssrLoadModule('/src/log-server.ts');
        const wss = getLogWss();

        server.httpServer?.on('upgrade', (req, socket, head) => {
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (pathname === '/ws') {
            wss.handleUpgrade(req, socket, head, (client) => {
              wss.emit('connection', client, req);
            });
          }
        });

        console.log(`[console] log WebSocket attached on /ws, file=${getLogFilePath()}`);
      },
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  integrations: [auraAppIntegration(), react(), logWsIntegration()],
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
    server: { hmr: false },
    // SSR-process @aura/ui through Vite (it ships .css + .tsx).
    ssr: { noExternal: ['@aura/ui'] },
    // react-dom/client and react/jsx-runtime are CJS — without explicit
    // optimizeDeps pre-bundling, Vite serves them with default-only exports
    // and astro-island hydration blows up with
    //   SyntaxError: doesn't provide an export named: 'createRoot'
    optimizeDeps: {
      include: ['react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
  },
});
