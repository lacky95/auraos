/**
 * The build composition (D76, Phase 6 W): one Astro project, two outputs.
 *
 *   desktop (default)  the server layer plus the Web Shell: the desktop pages
 *                      (src/desktop-pages, injected at their old paths), React
 *                      and the client bundle;
 *   server             the server layer only: the kernel, every API route, the
 *                      App Hosts, the WS proxy and socket.io; `/` answers
 *                      `{system:'aura', composition:'server'}` (middleware).
 *
 * `AURA_COMPOSITION` selects it at build time (D64 entry `composition`); the build
 * records it in `<outDir>/.aura-composition`, and server.mjs boots that composition.
 * This file is server layer: it imports no Web Shell code or UI library.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @returns {'server'|'desktop'} */
export function compositionOf(env = process.env) {
  return env.AURA_COMPOSITION === 'server' ? 'server' : 'desktop';
}

/** The Web Shell pages: route pattern -> file under src/desktop-pages (moved from src/pages, same paths). */
export const DESKTOP_PAGES = Object.freeze([
  { pattern: '/', file: 'index.astro' },
  { pattern: '/login', file: 'login.astro' },
  { pattern: '/setup', file: 'setup.astro' },
  { pattern: '/launcher', file: 'launcher.astro' },
  { pattern: '/dev/notification-controls', file: 'dev/notification-controls.astro' },
]);

export const COMPOSITION_MARKER = '.aura-composition';

/** Records the composition and its pages next to the build (status.json and the Headless test read it). */
export function compositionMarker(composition) {
  let outDir = null;
  return {
    name: 'aura-composition',
    hooks: {
      'astro:config:done': ({ config }) => { outDir = fileURLToPath(config.outDir); },
      'astro:build:done': () => {
        if (!outDir) return;
        mkdirSync(outDir, { recursive: true });
        const pages = composition === 'desktop' ? DESKTOP_PAGES.map((p) => p.pattern) : [];
        writeFileSync(`${outDir}/${COMPOSITION_MARKER}`, JSON.stringify({ composition, pages }, null, 2) + '\n');
      },
    },
  };
}
