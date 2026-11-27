#!/usr/bin/env node
// The error-answer ratchet (D105 Pass B, error-messages review §6.3).
//
//   node tools/error-lint.mjs [--json] [--update] [--root=<dir>]
//
// New server code answers a failure with the one structured body
// (`errorResponse(status, {error: <code>, message, hint?, …})`) or, for an
// unexpected error, `failureResponse(ctx, err)`, which words it for its
// reader (whole to the owner, without host paths, container names, env
// names or credentials to anyone else). This counts, per file, what predates
// that:
//
//   old-form   errorResponse('<sentence>', status) and legacyErrorBody(…):
//              `error` carries a sentence instead of a code
//   raw-error  a response built from an error's raw text (err.message,
//              String(err)): host paths and docker or git output reach the caller
//   ad-hoc     new Response(JSON.stringify({ error …: past the builder
//              (no no-store, no nosniff)
//
// Today's debt is tools/error-baseline.json (per file and rule). A count
// above it, or any count in a file the baseline does not list, fails; a count
// below it is paid off: shrink the baseline (`--update` rewrites it to the
// current counts, which a reviewer sees in the diff). Single-line patterns:
// a response spread over several lines is not seen, so the baseline is a
// floor, not an inventory.
//
// Exit: 0 clean, 1 new debt, 2 tool error. Also run as the `errors` check of
// tools/security-check.mjs (pnpm security; run-tests --with-security).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_FILE = 'tools/error-baseline.json';
const SCOPES = ['packages/shell/src/pages/api', 'packages/shell/src/lib', 'packages/shell/server', 'packages/shell/src/middleware.ts'];
const BUILDER = 'packages/shell/src/lib/appResponse.ts';

const ERR = '(?:err|e|error|ex|cause)';
const RAW = new RegExp(`\\(${ERR}\\s+as\\s+\\w+\\)\\.message|\\b${ERR}\\.message\\b|String\\(${ERR}\\)`);
const RESPONSE = /\b(?:errorResponse|jsonResponse|jsonError|json|Response)\(/;
export const RULES = {
  'old-form': (line, file) => {
    let n = (line.match(/\berrorResponse\(\s*(?:['"`]|String\(|\(\w+ as \w+\)|[A-Za-z_$][\w$.]*\s*,\s*\d)/g) ?? []).length;
    if (file !== BUILDER) n += (line.match(/\blegacyErrorBody\(/g) ?? []).length;
    return n;
  },
  'raw-error': (line) => (RESPONSE.test(line) && RAW.test(line) ? 1 : 0),
  'ad-hoc': (line, file) => (file !== BUILDER && /new Response\(\s*JSON\.stringify\(\s*\{\s*error\b/.test(line) ? 1 : 0),
};

function walk(root, rel, out) {
  const full = join(root, rel);
  if (!existsSync(full)) return out;
  if (statSync(full).isFile()) { out.push(rel); return out; }
  for (const name of readdirSync(full)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name.startsWith('.')) continue;
    walk(root, join(rel, name), out);
  }
  return out;
}

/** `{ <file>: { <rule>: count } }`, only nonzero counts. */
export function scanErrors(root) {
  const files = SCOPES.flatMap((s) => walk(root, s, []))
    .filter((f) => /\.(?:ts|mjs)$/.test(f) && !/\.test\.|\.d\.ts$/.test(f))
    .map((f) => f.split(sep).join('/'))
    .sort();
  const counts = {};
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      for (const [rule, count] of Object.entries(RULES)) {
        const n = count(line, file);
        if (n) ((counts[file] ??= {})[rule] = (counts[file][rule] ?? 0) + n);
      }
    }
  }
  return counts;
}

/** What is above the baseline (new debt) and what is below it (paid off). */
export function ratchet(counts, baseline) {
  const over = [];
  const under = [];
  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, n] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (n > allowed) over.push({ file, rule, count: n, allowed });
    }
  }
  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, allowed] of Object.entries(rules)) {
      const n = counts[file]?.[rule] ?? 0;
      if (n < allowed) under.push({ file, rule, count: n, allowed });
    }
  }
  return { over, under };
}

export function loadBaseline(root) {
  const file = join(root, BASELINE_FILE);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed.files ?? {};
}

const total = (counts) => Object.values(counts).reduce((s, r) => s + Object.values(r).reduce((a, b) => a + b, 0), 0);

const MESSAGE = {
  'old-form': 'answer errorResponse(status, { error: <code>, message, hint? }) instead of a sentence in `error`',
  'raw-error': 'answer failureResponse(ctx, err) instead of the raw error text (it is redacted for anyone but the owner)',
  'ad-hoc': 'build error answers with errorResponse(status, body) (lib/appResponse.ts)',
};

/** One finding per rule a file exceeds (for tools/security-check.mjs). */
export function errorFindings(root) {
  const counts = scanErrors(root);
  const { over, under } = ratchet(counts, loadBaseline(root));
  return {
    findings: over.map((o) => ({ check: `errors/${o.rule}`, file: o.file, id: o.rule, message: `${o.rule}: ${o.count} (baseline ${o.allowed}): ${MESSAGE[o.rule]}` })),
    warnings: under.map((u) => `error baseline: ${u.file} ${u.rule} is down to ${u.count} (baseline ${u.allowed}): node tools/error-lint.mjs --update`),
    info: `error debt ${total(counts)}`,
  };
}

function main(argv) {
  const opts = { json: argv.includes('--json'), update: argv.includes('--update') };
  const rootArg = argv.find((a) => a.startsWith('--root='));
  const root = rootArg ? resolve(rootArg.slice(7)) : resolve(HERE, '..');
  const counts = scanErrors(root);
  if (opts.update) {
    writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify({
      note: 'D105 Pass B error-answer debt per file and rule (tools/error-lint.mjs). It only shrinks: new code uses errorResponse(status, body) / failureResponse.',
      files: counts,
    }, null, 2)}\n`);
    process.stdout.write(`error baseline written: ${total(counts)} sites in ${Object.keys(counts).length} files\n`);
    return 0;
  }
  const { over, under } = ratchet(counts, loadBaseline(root));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ exit: over.length ? 1 : 0, debt: total(counts), over, under })}\n`);
  } else {
    process.stdout.write(`ERRORS ${over.length ? 'FAIL' : 'PASS'} ${over.length} new · debt ${total(counts)} in ${Object.keys(counts).length} files${under.length ? ` · ${under.length} paid off (--update)` : ''}\n`);
    for (const o of over) process.stdout.write(`${o.file} ${o.rule} ${o.count} > ${o.allowed}: ${MESSAGE[o.rule]}\n`);
  }
  return over.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`error-lint: ${e.message}\n`); process.exitCode = 2; }
}
