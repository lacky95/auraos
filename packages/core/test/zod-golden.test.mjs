// The zod golden (D62): every boundary schema of core, parsed the way the
// boundaries parse (safeParse3), gives the result zod 3 gave — success, the
// parsed data (defaults included), and the issues with their messages and
// fields. The cases and how they were recorded:
// test/fixtures/zod-golden/generate.mjs. The few results zod 4 changes on
// purpose are listed, with the reason, in fixtures/zod-golden/intended.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../dist/index.js';
import { applyMutation, canonical, caseLabel, dataHash } from './fixtures/zod-golden/cases.mjs';

const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/zod-golden/${f}`, import.meta.url), 'utf8'));
const golden = fixture('golden.json');
const intended = fixture('intended.json');

function replay(c) {
  const input = c.seed === null ? applyMutation(undefined, c.mutation) : applyMutation(golden.seeds[c.schema][c.seed], c.mutation);
  const r = core.safeParse3(core[c.schema], input);
  if (r.success) return 'data' in c.expect ? { success: true, data: canonical(r.data) } : { success: true, dataHash: dataHash(r.data) };
  return { success: false, issues: JSON.parse(JSON.stringify(r.issues)) };
}

test('zod golden: every intended change names a recorded case and a reason', () => {
  const labels = new Set(golden.cases.map(caseLabel));
  for (const [label, v] of Object.entries(intended.cases)) {
    assert.ok(labels.has(label), `no recorded case ${label}`);
    assert.ok(intended.reasons[v.reason], `${label}: unknown reason ${v.reason}`);
  }
});

for (const schema of [...new Set(golden.cases.map((c) => c.schema))]) {
  test(`zod golden: ${schema} parses and refuses as zod ${golden.recordedWith.zod} did`, () => {
    const diffs = [];
    for (const c of golden.cases.filter((x) => x.schema === schema)) {
      const label = caseLabel(c);
      const want = intended.cases[label]?.expect ?? c.expect;
      const got = replay(c);
      try { assert.deepEqual(got, want); } catch { diffs.push(`${label}\n  want ${JSON.stringify(want).slice(0, 600)}\n  got  ${JSON.stringify(got).slice(0, 600)}`); }
    }
    assert.equal(diffs.length, 0, `${diffs.length} case(s) differ:\n${diffs.slice(0, 15).join('\n')}`);
  });
}

test('every boundary parse of a schema goes through safeParse3 (or passes ZOD3)', () => {
  const packages = fileURLToPath(new URL('../../', import.meta.url));
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? (e.name === 'node_modules' ? [] : files(join(dir, e.name)))
    : /\.(ts|tsx|astro|mjs)$/.test(e.name) ? [join(dir, e.name)] : []));
  const bad = [];
  for (const pkg of ['core', 'shell', 'aura-cli']) {
    for (const f of files(join(packages, pkg, 'src'))) {
      if (f.endsWith('zodCompat.ts')) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/Schema\.safeParse(Async)?\(/.test(line) || (/Schema\.parse(Async)?\(/.test(line) && !line.includes('ZOD3'))) bad.push(`${f.slice(packages.length)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(bad, [], 'zod 4 messages would leak; use safeParse3(schema, input)');
});
