/**
 * `node ownershipApplyWorker.js <journal>` with the rows as JSON on stdin:
 * the worker of `runOwnershipApply` (ownershipApply.ts), so a long walk never
 * blocks the shell's event loop. Prints the per-row result as JSON.
 */
import { readFileSync } from 'node:fs';
import { applyOwnershipRows, type ApplyRow } from './ownershipApply.js';

const journal = process.argv[2];
if (!journal) {
  process.stderr.write('usage: ownershipApplyWorker.js <journal> < rows.json\n');
  process.exit(64);
}
const rows = JSON.parse(readFileSync(0, 'utf-8')) as ApplyRow[];
process.stdout.write(JSON.stringify(applyOwnershipRows(rows, journal)));
