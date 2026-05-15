import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

// File-based logger written to a workspace-volume path so we can `tail` it
// from the host without needing docker access. Set AURA_DEBUG=1 to enable.
const DEBUG_LOG = '/workspace/.aura-debug.log';
function dbg(tag, ...args) {
  try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${tag} ${args.join(' ')}\n`); } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Vite plugin: proxy WebSocket upgrades for /api/proxy/[appId]/[path] */
function wsProxyPlugin() {
  return {
    name: 'aura-ws-proxy',
    configureServer(server) {
      if (!server.httpServer) return;
      server.httpServer.on('upgrade', async (req, socket, head) => {
        const url = req.url ?? '';
        const t0 = Date.now();
        dbg('WS-PROXY', 'upgrade', url);
        // Match path + (optional) query separately so we can strip _aura_sub
        const m = url.match(/^\/api\/proxy\/([^/]+)\/([^?]*)(\?.*)?$/);
        if (!m) { dbg('WS-PROXY', 'no-match', url); return; }
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

        // Resolve the upstream port. The first segment can be either a real
        // instanceId (e.g. "com.aura.terminal-3") or an app id (the iframe
        // uses the app id for the bare /ws path). Prefer:
        //   1. exact instanceId match
        //   2. for an app id: a NON-pool, resumed instance — pool members
        //      are spawn-warmed but not user-attached; routing the WS at one
        //      can send bash output to a tab that doesn't own it, and after
        //      restarts a transient pool member is a common [0] match.
        //   3. fall back to any healthy instance of that app.
        let port;
        let chosenInstanceId = null;
        try {
          const tLoadStart = Date.now();
          const core = await server.ssrLoadModule('@aura/core');
          dbg('WS-PROXY', 'ssrLoadModule', `${Date.now() - tLoadStart}ms`);
          const mgr = core.getAppManager?.();
          const direct = mgr?.getInstance?.(instanceId);
          if (direct) { port = direct.port; chosenInstanceId = direct.instanceId; }
          else if (mgr) {
            const candidates = mgr.getInstancesByApp(instanceId) ?? [];
            dbg('WS-PROXY', 'candidates', JSON.stringify(candidates.map((i) => ({ id: i.instanceId, port: i.port, state: i.state, inPool: i.inPool }))));
            const preferred = candidates.find((i) => !i.inPool && (i.state === 'resumed' || i.state === 'started'));
            const fallback = candidates.find((i) => i.state === 'resumed' || i.state === 'started');
            const chosen = preferred ?? fallback;
            port = chosen?.port;
            chosenInstanceId = chosen?.instanceId;
          }
        } catch (err) { dbg('WS-PROXY', 'resolve-err', String(err)); }

        if (!port) { dbg('WS-PROXY', 'no-port → destroy', instanceId, `t=${Date.now() - t0}ms`); socket.destroy(); return; }
        dbg('WS-PROXY', 'chose', chosenInstanceId, `port=${port}`, `t=${Date.now() - t0}ms`);

        // Inject activity header for the upstream upgrade request
        if (activityId) req.headers['x-aura-activity-id'] = activityId;

        const { WebSocket, WebSocketServer } = await import('ws');
        const upstreamUrl = `ws://localhost:${port}/${proxyPath}${upstreamQuery}`;
        const tUpstreamStart = Date.now();
        dbg('WS-PROXY', 'upstream-dial', upstreamUrl);
        const upstream = new WebSocket(upstreamUrl, {
          headers: activityId ? { 'x-aura-activity-id': activityId } : undefined,
        });

        upstream.once('open', () => {
          dbg('WS-PROXY', 'upstream-open', `${Date.now() - tUpstreamStart}ms total=${Date.now() - t0}ms`);
          const wss = new WebSocketServer({ noServer: true });
          wss.handleUpgrade(req, socket, head, (client) => {
            dbg('WS-PROXY', 'client-handshake-done', `total=${Date.now() - t0}ms`);
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

        upstream.on('error', (e) => { dbg('WS-PROXY', 'upstream-error', String(e), `t=${Date.now() - tUpstreamStart}ms`); socket.destroy(); });
      });
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  security: {
    checkOrigin: false,
  },
  server: {
    port: 3000,
    host: true,
  },
  vite: {
    // Point workspace packages to their TypeScript source for full hot
    // reload — bare imports only. Subpath imports (`@aura/ui/styles/...`,
    // `@aura/ui/lib/...`) flow through pnpm's `node_modules/@aura/ui`
    // symlink so the `exports` map in @aura/ui's package.json kicks in,
    // and `ssr.noExternal: ['@aura/ui']` below can match by package name
    // (it would not match a pre-resolved file path).
    resolve: {
      alias: [
        { find: /^@aura\/core$/, replacement: resolve(__dirname, '../core/src/index.ts') },
        { find: /^@aura\/ui$/,   replacement: resolve(__dirname, '../ui/src/index.ts') },
      ],
    },
    server: {
      watch: {
        ignored: ['**/node_modules/**', '**/.git/**'],
      },
    },
    optimizeDeps: {
      // Exclude workspace-source packages so Vite reads them fresh from
      // their .ts source on each change (full HMR). @aura/ui used to be
      // here too, but its Radix sub-deps need pre-bundling for proper CJS
      // named-export interop (Vite can't surface `createRoot` from
      // react-dom/client otherwise — hydration explodes).
      exclude: ['@aura/core'],
      include: ['react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
    // SSR-process @aura/ui through Vite (it ships .css + .tsx). Vite would
    // otherwise treat workspace packages as external and Node's native
    // loader would choke on `.css` ("Unknown file extension").
    ssr: {
      noExternal: ['@aura/ui'],
    },
    // tailwindcss() must come before wsProxyPlugin so its content-scanning
    // hooks run on every transformed module.
    plugins: [tailwindcss(), wsProxyPlugin()],
  },
});
