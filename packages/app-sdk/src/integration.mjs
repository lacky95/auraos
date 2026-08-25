/**
 * Unified Astro integration for Aura apps. Bundles every framework concern an
 * app needs to wire up at startup:
 *
 *   • Stamps `X-Aura-App-Id` / `X-Aura-Instance-Id` response headers — the
 *     shell's reverse proxy refuses to forward responses without these,
 *     because they're the identity contract that prevents port-squatter
 *     bugs.
 *   • Injects a default `/api/lifecycle/health` route (opt-out) — the OS
 *     polls this during `waitHealthy` and the reconciler. Apps that need
 *     custom health logic can still ship their own `src/pages/api/lifecycle/
 *     health.ts`; Astro's filesystem routes take precedence on collision.
 *   • Logs identity at server start so container logs make it obvious which
 *     app each port belongs to.
 *
 * `.mjs` because `astro.config.mjs` imports it through Node's resolver before
 * Astro/Vite boot — it cannot be a `.ts` file.
 *
 * Usage:
 *   import { auraAppIntegration } from '@aura/app-sdk/integration';
 *   export default defineConfig({ integrations: [auraAppIntegration()] });
 *
 * @typedef {Object} AuraAppIntegrationOptions
 * @property {boolean} [injectHealth=true] — auto-add /api/lifecycle/health.
 *
 * @param {AuraAppIntegrationOptions} [opts]
 * @returns {import('astro').AstroIntegration}
 */
export function auraAppIntegration(opts = {}) {
  const { injectHealth = true } = opts;
  return {
    name: 'aura-app',
    hooks: {
      'astro:config:setup': ({ injectRoute, updateConfig }) => {
        // Vite's dev server in Astro 6 / Vite 5+ ships a `server.allowedHosts`
        // safelist that rejects requests with a Host header not in the list
        // (returns 403). PRoot apps are reached via 127.0.0.1 (auto-allowed)
        // so this never surfaces. Container-sandbox apps are reached by
        // their docker-network hostname (`aura-com.aura.counter-3`), which
        // is unknown to Vite → 403 on every request including health probes.
        // Allow any host because (a) the app is already network-isolated
        // (sibling container on aura-net only) and (b) the shell's HTTP
        // proxy verifies identity via X-Aura-App-Id headers anyway.
        updateConfig({ vite: { server: { allowedHosts: true } } });
        if (!injectHealth) return;
        // Resolve relative to whatever's on disk (this file ships in both
        // src/ during dev AND in dist/ after tsc, with runtime/ as a sibling
        // each way). Try the compiled .js first because that's what's
        // published; fall back to .ts for the in-monorepo source-only path
        // that older system-scope apps may still hit.
        const routeUrl = new URL('./runtime/health-route.js', import.meta.url);
        injectRoute({
          pattern: '/api/lifecycle/health',
          entrypoint: routeUrl,
        });
      },
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((_req, res, next) => {
          const appId      = process.env['APP_ID'];
          const instanceId = process.env['APP_INSTANCE_ID'];
          if (appId)      res.setHeader('X-Aura-App-Id',      appId);
          if (instanceId) res.setHeader('X-Aura-Instance-Id', instanceId);
          next();
        });
      },
      'astro:server:start': () => {
        const appId      = process.env['APP_ID']          ?? '(unset)';
        const instanceId = process.env['APP_INSTANCE_ID'] ?? '(unset)';
        console.log(`[aura-app] stamping responses with app=${appId} instance=${instanceId}`);
      },
    },
  };
}

/**
 * Back-compat alias for the previous integration name. New apps should use
 * `auraAppIntegration()`. This will be removed in a future release.
 *
 * @returns {import('astro').AstroIntegration}
 */
export function auraIdentityIntegration() {
  return auraAppIntegration({ injectHealth: false });
}

/**
 * The port this app's dev server should bind.
 *
 * Normally the OS assigns one and passes it as APP_PORT — that is the port it
 * proxies to, so it must be honoured exactly. Everywhere else (a developer
 * running the app by hand, `astro check` in CI, two checks at once) there is
 * no assigned port, and the historical fallback of a hardcoded 4001 meant the
 * second thing to start died on EADDRINUSE — as `astro check` did inside the
 * shell container, with a SIGKILL and no explanation.
 *
 * So: APP_PORT when set, otherwise ask the OS for a free one. `APP_PORT=0`
 * asks for that explicitly, which is the convention `listen(0)` already uses
 * — but Astro needs a real number, so we resolve it here rather than passing
 * 0 down.
 *
 * Async because finding a free port means binding one. Astro config files are
 * ESM and may use top-level await:
 *
 *     const port = await resolveAppPort();
 */
export async function resolveAppPort(fallbackToFree = true) {
  const raw = process.env['APP_PORT'];
  const n = Number(raw);
  if (raw !== undefined && raw !== '' && Number.isInteger(n) && n > 0) return n;
  if (!fallbackToFree) return 4001;
  return freePort();
}

/** Bind port 0, note what the OS handed out, release it. */
function freePort() {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const srv = createServer();
      // Any failure here (no permission, exotic sandbox) must not stop the app
      // from starting — fall back to the historical default.
      srv.once('error', () => resolve(4001));
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 4001;
        srv.close(() => resolve(port));
      });
    }).catch(() => resolve(4001));
  });
}
