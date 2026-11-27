/**
 * `node ownershipApplyWorker.js <journal>` with the rows as JSON on stdin:
 * the worker of `runOwnershipApply` (ownershipApply.ts), so a long walk never
 * blocks the shell's event loop. Prints the per-row result as JSON (with a
 * `restore`: `{ rows, restored }`).
 */
import { readFileSync } from 'node:fs';
import { applyOwnershipRequest, applyOwnershipRows, type ApplyRequest, type ApplyRow } from './ownershipApply.js';

const journal = process.argv[2];
if (!journal) {
  process.stderr.write('usage: ownershipApplyWorker.js <journal> < rows.json\n');
  process.exit(64);
}
// The rows alone (the ownership apply), or with a journal to restore first (the run-as migration).
const input = JSON.parse(readFileSync(0, 'utf-8')) as ApplyRow[] | ApplyRequest;
if (Array.isArray(input)) process.stdout.write(JSON.stringify(applyOwnershipRows(input, journal)));
else process.stdout.write(JSON.stringify(applyOwnershipRequest(input, journal)));
