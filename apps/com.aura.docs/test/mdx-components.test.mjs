// The docs build is MDX: a `<Name>` in prose outside code is a JSX component. One that is not registered
// (fumadocs-ui's defaults, mdx-components.tsx) fails `next build`, and Docs then does not start at all
// (5-main: the D101 page text "the last window of <App>" left Docs and its MCP down, 503).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../fumadocs-site/content/docs', import.meta.url));
// The components the pages may use (fumadocs-ui/mdx defaults).
const KNOWN = new Set(['Callout', 'Card', 'Cards', 'Tab', 'Tabs', 'Step', 'Steps', 'Accordion', 'Accordions', 'File', 'Folder', 'Files', 'TypeTable', 'ImageZoom']);

function pages(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : p.endsWith('.mdx') ? [p] : [];
  });
}

/** The page's prose: frontmatter (YAML, not MDX), fenced code blocks and inline code (also wrapped over lines) removed. */
export function prose(text) {
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1/gm, '')
    .replace(/`[^`]*`/g, '');
}

test('prose() drops frontmatter, fenced and inline code (also an inline span wrapped over two lines)', () => {
  assert.equal(prose('---\ndescription: /api/data/<authority>\n---\na `<App>` b\n```\n<Icon>\n```\nc `x\ny <app>` d').includes('<'), false);
});

test('every capitalized tag in the docs prose is a registered MDX component', () => {
  const bad = [];
  for (const file of pages(ROOT)) {
    for (const m of prose(readFileSync(file, 'utf8')).matchAll(/<\/?([A-Z][A-Za-z0-9.]*)/g)) {
      if (!KNOWN.has(m[1])) bad.push(`${file.slice(ROOT.length + 1)}: <${m[1]}> (escape it as &lt;${m[1]}&gt; or put it in code)`);
    }
  }
  assert.deepEqual(bad, []);
});

// A lowercase tag in prose is JSX too: `<app>` with no closing tag fails the MDX compile just as
// `<App>` did (7c: app-contract.mdx). The pages use no raw HTML; components are capitalized.
const LOWER_TAG = /<\/?([a-z][A-Za-z0-9.:-]*)/g;

test('the lowercase-tag rule catches the 7c app-contract text and passes it escaped', () => {
  assert.equal([...prose('one message: "<app> is built for Aura contract N"').matchAll(LOWER_TAG)].length, 1);
  assert.equal([...prose('one message: "`<app>` is built" or &lt;app&gt;').matchAll(LOWER_TAG)].length, 0);
});

test('no lowercase tag in the docs prose (placeholders like <app> go in code or as &lt;app&gt;)', () => {
  const bad = [];
  for (const file of pages(ROOT)) {
    for (const m of prose(readFileSync(file, 'utf8')).matchAll(LOWER_TAG)) {
      bad.push(`${file.slice(ROOT.length + 1)}: <${m[1]}> (escape it as &lt;${m[1]}&gt; or put it in code)`);
    }
  }
  assert.deepEqual(bad, []);
});
