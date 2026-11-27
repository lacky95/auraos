// The zod golden (D62): every boundary schema of core gives the result zod 3
// gave — success, the parsed data (defaults included), and the issues with
// their messages and fields. The cases and how they were recorded:
// test/fixtures/zod-golden/generate.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../dist/index.js';
import { applyMutation, canonical, dataHash } from './fixtures/zod-golden/cases.mjs';

const golden = JSON.parse(readFileSync(new URL('./fixtures/zod-golden/golden.json', import.meta.url), 'utf8'));

function replay(c) {
  const input = c.seed === null ? applyMutation(undefined, c.mutation) : applyMutation(golden.seeds[c.schema][c.seed], c.mutation);
  const r = core[c.schema].safeParse(input);
  if (r.success) return 'data' in c.expect ? { success: true, data: canonical(r.data) } : { success: true, dataHash: dataHash(r.data) };
  return { success: false, issues: JSON.parse(JSON.stringify(r.error.issues.map(({ unionErrors: _u, ...i }) => i))) };
}

const label = (c) => `${c.schema}/${c.seed ?? '(root)'}${c.mutation ? ` ${c.mutation.path.join('.') || '(root)'}=${c.mutation.value ?? JSON.stringify(c.mutation.literal).slice(0, 60)}` : ''}`;

for (const schema of [...new Set(golden.cases.map((c) => c.schema))]) {
  test(`zod golden: ${schema} parses and refuses exactly as recorded (zod ${golden.recordedWith.zod})`, () => {
    const diffs = [];
    for (const c of golden.cases.filter((x) => x.schema === schema)) {
      const got = replay(c);
      try { assert.deepEqual(got, c.expect); } catch { diffs.push(`${label(c)}\n  want ${JSON.stringify(c.expect).slice(0, 600)}\n  got  ${JSON.stringify(got).slice(0, 600)}`); }
    }
    assert.equal(diffs.length, 0, `${diffs.length} case(s) differ:\n${diffs.slice(0, 15).join('\n')}`);
  });
}
