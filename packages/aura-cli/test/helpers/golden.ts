// Golden files of the human CLI (D109 Addendum: the byte-identity baseline).
// `AURA_UPDATE_GOLDEN=1` rewrites them; only with the owner's approval of a
// human-CLI change (packages/aura-cli/AGENTS.md).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** test/golden/, from the bundled test (.test-dist/*.cjs) or the source. */
export const GOLDEN_DIR = join(__dirname, '..', 'test', 'golden');

export function assertGolden(name: string, actual: Record<string, unknown>): void {
  const file = join(GOLDEN_DIR, name);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env['AURA_UPDATE_GOLDEN'] === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.ok(existsSync(file), `${name} is missing: create the baseline with AURA_UPDATE_GOLDEN=1`);
  const expected = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${name}: the set of entries changed`);
  for (const k of Object.keys(expected)) assert.equal(actual[k], expected[k], `${name}: ${k} changed (human CLI byte identity)`);
}
