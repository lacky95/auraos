#!/usr/bin/env node
/**
 * AuraOS read-only smoke test. See README.md for the safety model.
 *
 *   node tools/smoke/run.mjs --target <url> [--json <file>] [--tier live|test-instance]
 *
 * Exit codes: 0 no failures, 1 at least one check failed, 2 usage error.
 */
import { constants, closeSync, fchmodSync, openSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { createGuard } from './lib/guard.mjs';
import { createClient, normalizeTarget } from './lib/http.mjs';
import { runSmoke } from './lib/checks.mjs';
import { loadOperatorIdentity } from './lib/operator.mjs';

const USAGE = 'usage: node tools/smoke/run.mjs --target <url> [--json <file>] [--tier live|test-instance]';

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

/** Resolve the report path through symlinks, and refuse anything in /workspace. */
function reportPath(file) {
  const abs = resolve(file);
  let dir;
  try { dir = realpathSync(dirname(abs)); }
  catch { usageError('--json: the directory does not exist'); }
  const real = join(dir, basename(abs));
  if (real === '/workspace' || real.startsWith(`/workspace${sep}`)) usageError('--json must not point into /workspace');
  return real;
}

function writeReport(path, report) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        target: { type: 'string' },
        json: { type: 'string' },
        tier: { type: 'string', default: 'live' },
      },
    }));
  } catch (err) {
    usageError(err.message);
  }
  if (!values.target) usageError('--target is required');
  if (!['live', 'test-instance'].includes(values.tier)) usageError('--tier must be live or test-instance');
  try { normalizeTarget(values.target); }
  catch (err) { usageError(err.message); }
  const jsonPath = values.json ? reportPath(values.json) : null;

  const guard = createGuard();
  const { identity, why } = await loadOperatorIdentity(values.target);
  console.log(`identity: ${identity ? why : `anonymous (${why})`}`);
  const client = createClient({ target: values.target, guard, identity });
  const report = await runSmoke({ client, guard, tier: values.tier });

  for (const x of report.results) {
    console.log(`${x.status.toUpperCase().padEnd(4)} [${x.tier}] ${x.id}: ${x.detail}`);
  }
  const { pass, fail, skip } = report.summary;
  console.log(`\nsmoke: ${pass} passed, ${fail} failed, ${skip} skipped`);

  if (jsonPath) {
    writeReport(jsonPath, { generatedAt: new Date().toISOString(), target: new URL(values.target).origin, ...report });
    console.log(`report: ${jsonPath}`);
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`smoke: aborted: ${err?.name ?? 'error'}: ${err?.message ?? ''}`);
  process.exitCode = 1;
});
