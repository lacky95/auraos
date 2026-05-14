/**
 * Astro integration: stamps every response with the app's identity headers
 * (X-Aura-App-Id, X-Aura-Instance-Id). The shell's reverse proxy compares
 * these against the AppManager record when forwarding to the iframe — any
 * mismatch indicates a port squatter and the proxy aborts. Adding this
 * integration is a hard requirement of the AuraOS routing contract.
 *
 * This file is `.mjs` (not `.ts`) so that an app's `astro.config.mjs` can
 * import it through plain Node module resolution, before Vite/Astro have
 * started up.
 *
 * @returns {import('astro').AstroIntegration}
 */
export function auraIdentityIntegration() {
  return {
    name: 'aura-identity-headers',
    hooks: {
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
        console.log(`[aura-identity] stamping responses with app=${appId} instance=${instanceId}`);
      },
    },
  };
}
