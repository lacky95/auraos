// The docs link check (offline, no build): every `/docs/<page>[#anchor]` link in the pages points at a page
// that exists, an anchor at one of that page's headings, and every page is listed in its folder's meta.json
// navigation (a page outside it is unreachable from the sidebar). D108 §9.5 item 10 names this check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The page's prose: fenced code and inline code removed (as mdx-components.test.mjs). */
const prose = (text) => text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, '').replace(/`[^`\n]*`/g, '');

const ROOT = fileURLToPath(new URL('../fumadocs-site/content/docs', import.meta.url));

function pages(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : p.endsWith('.mdx') ? [p] : [];
  });
}
const slugOf = (file) => relative(ROOT, file).replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');

/** Heading anchors as fumadocs (github-slugger) makes them: lower case, punctuation dropped, spaces → dashes. */
export function anchor(heading) {
  return heading.trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}
const headings = (text) => new Set(text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, '').split('\n')
  .filter((l) => /^#{1,6}\s/.test(l)).map((l) => anchor(l.replace(/^#+\s*/, ''))));

test('anchor() follows the slugger rules for the usual heading shapes', () => {
  assert.equal(anchor('Mounts — `aura mount …`'), 'mounts--aura-mount-');
  assert.equal(anchor('3. Start it with your app'), '3-start-it-with-your-app');
});

test('every /docs link points at an existing page and heading', () => {
  const all = pages(ROOT);
  const bySlug = new Map(all.map((f) => [slugOf(f), f]));
  const bad = [];
  for (const f of all) {
    const text = readFileSync(f, 'utf8');
    for (const m of prose(text).matchAll(/\]\(\/docs\/?([^)#\s]*)(?:#([^)\s]+))?\)/g)) {
      const target = bySlug.get(m[1].replace(/\/$/, ''));
      if (!target) { bad.push(`${slugOf(f)}: /docs/${m[1]} (no such page)`); continue; }
      if (m[2] && !headings(readFileSync(target, 'utf8')).has(m[2])) bad.push(`${slugOf(f)}: /docs/${m[1]}#${m[2]} (no such heading)`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every page is in its folder\'s meta.json navigation', () => {
  const missing = [];
  for (const f of pages(ROOT)) {
    const dir = join(f, '..');
    const meta = join(dir, 'meta.json');
    const name = relative(dir, f).replace(/\.mdx$/, '');
    if (!existsSync(meta)) continue;
    const listed = JSON.parse(readFileSync(meta, 'utf8')).pages ?? [];
    if (!listed.includes(name) && !(name === 'index' && dir === ROOT)) missing.push(slugOf(f) || 'index');
  }
  assert.deepEqual(missing, []);
});
