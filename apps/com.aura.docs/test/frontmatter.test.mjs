// Every docs page's frontmatter is plain YAML that fumadocs (fumaMatter) can parse. One unquoted value with
// `: ` in it ("… the owner's grant: apps.view …") failed the whole `next build`, and serve.mjs exits when the
// boot build fails, so Docs (and its MCP) was down until the page was fixed (D104, VM run 20261127-154357-vm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../fumadocs-site/content/docs', import.meta.url));
const pages = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.mdx')) pages.push(p); } };
walk(root);

/** Why a `key: value` line is not a safe plain YAML scalar, or null. */
export function frontmatterLineProblem(line) {
  const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
  if (!m) return line.trim() === '' || /^\s/.test(line) || line.startsWith('#') ? null : 'not a `key: value` line';
  const v = (m[2] ?? '').trim();
  if (!v || /^(["']).*\1$/.test(v) || /^[|>][-+]?$/.test(v) || /^\[.*\]$/.test(v) || /^\{.*\}$/.test(v)) return null;
  if (/: /.test(v) || / #/.test(v)) return `unquoted value with ": " or " #": quote it`;
  if (/^[&*!%@`>|{}[\],#?-]/.test(v)) return 'unquoted value starts with a YAML indicator: quote it';
  return null;
}

test('the rule: plain values pass, a colon-space in an unquoted value does not', () => {
  assert.equal(frontmatterLineProblem('title: App composition'), null);
  assert.equal(frontmatterLineProblem('description: "with the owner\'s grant: apps.view"'), null);
  assert.match(frontmatterLineProblem('description: with the owner\'s grant: apps.view') ?? '', /quote it/);
});

test('every docs page has parseable frontmatter', () => {
  assert.ok(pages.length > 10, 'the docs pages were found');
  const bad = [];
  for (const p of pages) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(p, 'utf8'));
    if (!fm) continue;
    for (const [i, line] of fm[1].split('\n').entries()) {
      const why = frontmatterLineProblem(line);
      if (why) bad.push(`${p.slice(root.length + 1)}:${i + 2}: ${why}`);
    }
  }
  assert.deepEqual(bad, []);
});
