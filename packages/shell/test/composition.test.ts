// Phase 6 W (D76): one Astro project, two compositions. The desktop pages live outside src/pages and
// are injected only for `desktop`; `server` loads no Web Shell code. The build-output half of this
// (no desktop routes or client chunks in a `server` build) is checked on the VM build
// (auraos-e2e hardening/phase6/headless-bootstrap step 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPOSITION_MARKER, DESKTOP_PAGES, compositionMarker, compositionOf } from '../src/integrations/composition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AURA_COMPOSITION: server or desktop (default); anything else is desktop', () => {
  assert.equal(compositionOf({ AURA_COMPOSITION: 'server' }), 'server');
  assert.equal(compositionOf({}), 'desktop');
  assert.equal(compositionOf({ AURA_COMPOSITION: 'Server' }), 'desktop');
});

test('src/pages holds no page: every desktop page is in src/desktop-pages with an injected route', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const pages = walk(path.join(root, 'src/pages')).filter((f) => f.endsWith('.astro') || f.endsWith('.md'));
  assert.deepEqual(pages, [], 'a page in src/pages would be in the server composition too');
  for (const p of DESKTOP_PAGES) assert.ok(fs.existsSync(path.join(root, 'src/desktop-pages', p.file)), p.file);
  assert.deepEqual(DESKTOP_PAGES.map((p) => p.pattern), ['/', '/login', '/setup', '/launcher', '/dev/notification-controls']);
});

test('the build config loads React and the desktop pages only for desktop', () => {
  const cfg = fs.readFileSync(path.join(root, 'astro.config.mjs'), 'utf8');
  assert.doesNotMatch(cfg, /from '@astrojs\/react'/, 'no static React import in the config');
  assert.match(cfg, /COMPOSITION === 'desktop' \? \(await import\('\.\/src\/desktop-pages\/integration\.mjs'\)\)/);
  const desktop = fs.readFileSync(path.join(root, 'src/desktop-pages/integration.mjs'), 'utf8');
  assert.match(desktop, /import react from '@astrojs\/react'/);
  assert.match(desktop, /injectRoute/);
});

test('the server composition answers / itself, before readiness, with no desktop', () => {
  const mw = fs.readFileSync(path.join(root, 'src/middleware.ts'), 'utf8');
  const root0 = mw.indexOf("ctx.url.pathname === '/' && compositionOf(process.env) === 'server'");
  assert.ok(root0 > 0 && root0 < mw.indexOf('kernelReady(ctx.url.pathname)'));
});

test('the build records its composition and pages next to the output', () => {
  const out = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'aura-comp-'));
  try {
    for (const composition of ['server', 'desktop'] as const) {
      const m = compositionMarker(composition);
      (m.hooks['astro:config:done'] as (a: unknown) => void)({ config: { outDir: new URL(`file://${out}/`) } });
      (m.hooks['astro:build:done'] as (a: unknown) => void)({});
      const rec = JSON.parse(fs.readFileSync(path.join(out, COMPOSITION_MARKER), 'utf8'));
      assert.equal(rec.composition, composition);
      assert.deepEqual(rec.pages, composition === 'server' ? [] : DESKTOP_PAGES.map((p) => p.pattern));
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
