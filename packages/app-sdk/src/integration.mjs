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
