import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraIdentityIntegration } from '@aura/app-sdk/integration';

const port = Number(process.env['APP_PORT'] ?? 4001);

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
  integrations: [auraIdentityIntegration(), logWsIntegration()],
  devToolbar: { enabled: false },
  vite: {
    server: { hmr: false },
  },
});
