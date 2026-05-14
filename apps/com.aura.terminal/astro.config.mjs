import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

const port = Number(process.env['APP_PORT'] ?? 4001);

function ptyWsIntegration() {
  return {
    name: 'aura-pty-ws',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        const { getPtyWss } = await server.ssrLoadModule('/src/pty-server.ts');
        const ptyWss = getPtyWss();

        server.httpServer?.on('upgrade', (req, socket, head) => {
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (pathname === '/ws') {
            ptyWss.handleUpgrade(req, socket, head, (client) => {
              ptyWss.emit('connection', client, req);
            });
          }
        });

        console.log('[terminal] PTY WebSocket attached on /ws');
      },
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  integrations: [ptyWsIntegration()],
});
