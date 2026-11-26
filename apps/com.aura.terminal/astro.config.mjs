import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration , resolveAppPort } from '@aura/app-sdk/integration';
import { fileURLToPath } from 'node:url';
import { shellWriteIgnore } from './watch-ignore.mjs';
import { RELAY_CLAIM_HEADER, checkShellRelay } from '@aura/app-sdk/shell-peer';

// APP_PORT when the OS assigned one, otherwise a free port picked at
// startup — so running this app by hand (or `astro check`) never fights
// whatever already holds 4001.
const port = await resolveAppPort();

/** The PTY upgrade came through the shell (app-sdk shell-peer, D89 B4 relay claim). */
const shellRelayed = async (req) => (await checkShellRelay({
  peer: req.socket.remoteAddress, header: req.headers[RELAY_CLAIM_HEADER], method: req.method ?? 'GET', path: req.url ?? '/',
})).ok;

function ptyWsIntegration() {
  return {
    name: 'aura-pty-ws',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        const { getPtyWss } = await server.ssrLoadModule('/src/pty-server.ts');
        const ptyWss = getPtyWss();

        server.httpServer?.on('upgrade', async (req, socket, head) => {
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (pathname === '/ws') {
            // Only the shell relays a PTY socket (src/middleware.ts, H4 stopgap).
            // D89 B4: and carries its relay claim (warn: reported; strict: required).
            if (!(await shellRelayed(req))) { socket.destroy(); return; }
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
    // If a reload still shows STALE inline CSS, a content edit to this file
    // restarts the dev server and recompiles it (same for new src/pages routes).
    // The terminal's own PTY WebSocket on `/ws` is unaffected (handled in the
    // ptyWsIntegration above, with its own upgrade hook).
    // watch.ignored: programs run from the shells hosted here write into this
    // tree (dotfiles, dot-dirs, logs, tmux socket dirs); none of that may
    // reload or restart the dev server under the live sessions — see
    // watch-ignore.mjs.
    server: {
      hmr: false,
      watch: { ignored: [shellWriteIgnore(fileURLToPath(new URL('.', import.meta.url)))] },
    },
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
