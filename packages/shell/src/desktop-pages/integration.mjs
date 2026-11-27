/**
 * The Web Shell half of the build (D76, Phase 6 W): React and the desktop pages,
 * injected at their routes. Only the `desktop` composition loads this file
 * (astro.config.mjs imports it dynamically); `server` builds without it.
 */
import react from '@astrojs/react';
import { DESKTOP_PAGES } from '../integrations/composition.mjs';

export default function desktopComposition() {
  return [
    react(),
    {
      name: 'aura-desktop-pages',
      hooks: {
        'astro:config:setup': ({ injectRoute }) => {
          for (const p of DESKTOP_PAGES) {
            injectRoute({ pattern: p.pattern, entrypoint: new URL(`./${p.file}`, import.meta.url) });
          }
        },
      },
    },
  ];
}
