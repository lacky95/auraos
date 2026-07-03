import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration } from '@aura/app-sdk/integration';

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
  integrations: [auraAppIntegration(), ptyWsIntegration()],
  // Dev toolbar lives at the document root and tries to use Vite HMR — both
  // useless inside the shell's iframe. Disable it to keep the iframe clean.
  devToolbar: { enabled: false },
  vite: {
    // Disable HMR: the app is loaded inside the shell's iframe and its dev
    // port (e.g. 4001) is not reachable from the browser. Iframe reload picks
    // up code changes; we accept that over a broken WebSocket reconnect loop.
    // The terminal's own PTY WebSocket on `/ws` is unaffected (handled in the
    // ptyWsIntegration above, with its own upgrade hook).
    server: { hmr: false },
    // Force pre-bundle for the xterm packages. Vite's dep scanner picks them
    // up from the `<script>` block in index.astro on FIRST server start, but
    // subsequent re-scans (triggered by the "optimized dependencies changed
    // → reloading" cycle) intermittently drop them from _metadata.json.
    // Result: /node_modules/.vite/deps/@xterm_xterm.js 404s and the browser
    // errors with NS_ERROR_CORRUPTED_CONTENT / disallowed MIME type. Listing
    // them explicitly pins them into every optimization pass.
    optimizeDeps: {
      include: ['@xterm/xterm', '@xterm/addon-fit'],
    },
  },
});
