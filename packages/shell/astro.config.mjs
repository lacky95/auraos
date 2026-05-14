import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Vite plugin: proxy WebSocket upgrades for /api/proxy/[appId]/[path] */
function wsProxyPlugin() {
  return {
    name: 'aura-ws-proxy',
    configureServer(server) {
      if (!server.httpServer) return;
      server.httpServer.on('upgrade', async (req, socket, head) => {
        const url = req.url ?? '';
        // Match path + (optional) query separately so we can strip _aura_sub
        const m = url.match(/^\/api\/proxy\/([^/]+)\/([^?]*)(\?.*)?$/);
        if (!m) return;
        const [, instanceId, proxyPath, rawQuery] = m;

        let activityId = null;
        let upstreamQuery = rawQuery ?? '';
        if (upstreamQuery) {
          const sp = new URLSearchParams(upstreamQuery.slice(1));
          if (sp.has('_aura_activity')) {
            activityId = sp.get('_aura_activity');
            sp.delete('_aura_activity');
            const s = sp.toString();
            upstreamQuery = s ? '?' + s : '';
          }
        }

        let port;
        try {
          const core = await server.ssrLoadModule('@aura/core');
          port = core.getAppManager?.()?.getInstance(instanceId)?.port
              ?? core.getAppManager?.()?.getRecord(instanceId)?.port;
        } catch {}

        if (!port) { socket.destroy(); return; }

        // Inject activity header for the upstream upgrade request
        if (activityId) req.headers['x-aura-activity-id'] = activityId;

        const { WebSocket, WebSocketServer } = await import('ws');
        const upstream = new WebSocket(`ws://localhost:${port}/${proxyPath}${upstreamQuery}`, {
          headers: activityId ? { 'x-aura-activity-id': activityId } : undefined,
        });

        upstream.once('open', () => {
          const wss = new WebSocketServer({ noServer: true });
          wss.handleUpgrade(req, socket, head, (client) => {
            client.on('message', (data, isBinary) => {
              if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
            });
            upstream.on('message', (data, isBinary) => {
              if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
            });
            client.on('close', () => upstream.terminate());
            upstream.on('close', () => { try { client.terminate(); } catch {} });
          });
        });

        upstream.on('error', () => socket.destroy());
      });
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: {
    checkOrigin: false,
  },
  server: {
    port: 3000,
    host: true,
  },
  vite: {
    // Point workspace packages to their TypeScript source for full hot reload
    resolve: {
      alias: {
        '@aura/core': resolve(__dirname, '../core/src/index.ts'),
        '@aura/ui':   resolve(__dirname, '../ui/src/index.ts'),
      },
    },
    server: {
      watch: {
        ignored: ['**/node_modules/**', '**/.git/**'],
      },
    },
    optimizeDeps: {
      exclude: ['@aura/core', '@aura/ui'],
    },
    plugins: [wsProxyPlugin()],
  },
});
