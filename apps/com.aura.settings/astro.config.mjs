import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { auraAppIntegration } from '@aura/app-sdk/integration';

const port = Number(process.env['APP_PORT'] ?? 4001);

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  // Dev toolbar lives at the document root and tries to use Vite HMR — both
  // useless inside the shell's iframe. Disable it to keep the iframe clean.
  devToolbar: { enabled: false },
  integrations: [auraAppIntegration(), react()],
  vite: {
    plugins: [tailwindcss()],
    // Disable HMR: the app is loaded inside the shell's iframe and its dev
    // port (e.g. 4001) is not reachable from the browser. Iframe reload picks
    // up code changes; we accept that over a broken WebSocket reconnect loop.
    server: { hmr: false },
    // SSR-process @aura/ui through Vite (it ships .css + .tsx).
    ssr: { noExternal: ['@aura/ui'] },
    // Force-pre-bundle React for the client. Without these entries, Vite's
    // dep scanner doesn't see react-dom/client imported on the client side
    // (it's only imported dynamically from @astrojs/react's runtime), so it
    // never converts the CJS package to ESM. The browser then tries to
    // `import { createRoot } from 'react-dom/client'` against a raw CJS
    // file and fails with "doesn't provide an export named 'createRoot'".
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ],
    },
  },
});
