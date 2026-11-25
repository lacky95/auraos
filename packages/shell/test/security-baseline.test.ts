// The security gate's baseline mode (tools/security-check.mjs): known debt in
// tools/security-baseline.json does not fail the gate, a new finding does, the
// summary prints the debt, and a fixed entry is reported for removal. Runs the
// gate's own main() against a throwaway root, patterns check only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../tools/security-check.mjs';

const STAR = "window.parent.postMessage({ type: 'x' }, '*');";

function fixture(files: Record<string, string>, entries: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'aura-sec-baseline-'));
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools/security-expected.json'), '{}');
  writeFileSync(join(root, 'tools/security-baseline.json'), JSON.stringify({ entries }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

const entry = (source: string, file = 'a.js') => ({
  check: 'patterns/postmessage-star', file, source,
  reason: 'A fixture entry for the baseline test.', owner: 'test',
});

async function run(root: string, json = true): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const out = (s: string): boolean => { lines.push(s); return true; };
  const code = await main([`--root=${root}`, '--only=patterns', ...(json ? ['--json'] : [])], out);
  return { code, lines };
}

test('a baselined finding passes and counts as debt, even after its line moves', async () => {
  const root = fixture({ 'a.js': `// moved down\n\n${STAR}\n` }, [entry(STAR)]);
  try {
    const { code, lines } = await run(root);
    const r = JSON.parse(lines[0]!);
    assert.equal(code, 0);
    assert.equal(r.findings.length, 0);
    assert.equal(r.baseline.length, 1);
    assert.equal(r.baseline[0].line, 3);
    const text = await run(root, false);
    assert.match(text.lines[0]!, /^SECURITY PASS 0 findings .* debt 1 baselined/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a new finding fails the gate; one entry covers one occurrence', async () => {
  const root = fixture({ 'a.js': `${STAR}\n${STAR}\n`, 'b.js': `${STAR}\n` }, [entry(STAR)]);
  try {
    const { code, lines } = await run(root);
    const r = JSON.parse(lines[0]!);
    assert.equal(code, 1);
    assert.equal(r.baseline.length, 1);
    assert.deepEqual(r.findings.map((f: { file: string; line: number }) => `${f.file}:${f.line}`).sort(), ['a.js:2', 'b.js:1']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an edited line is a new finding, and its stale entry asks to be removed', async () => {
  const edited = "window.parent.postMessage({ type: 'y' }, '*');";
  const root = fixture({ 'a.js': `${edited}\n` }, [entry(STAR)]);
  try {
    const { code, lines } = await run(root);
    const r = JSON.parse(lines[0]!);
    assert.equal(code, 1);
    assert.equal(r.findings.length, 1);
    assert.ok(r.warnings.some((w: string) => /^baseline: fixed, remove the entry/.test(w)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an entry without a reason or owner is a tool error', async () => {
  const root = fixture({ 'a.js': `${STAR}\n` }, [{ check: 'patterns/postmessage-star', file: 'a.js', source: STAR, reason: 'A fixture entry for the baseline test.' }]);
  try {
    const { code, lines } = await run(root, false);
    assert.equal(code, 2);
    assert.ok(lines.some((l) => /needs an "owner"/.test(l)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
