/**
 * Provisioning — telling "installing dependencies" apart from "failing to boot".
 *
 * The bug these pin: a store app arrives as source, so its first launch ran
 * `npm install` inside the runner's health deadline. A heavy tree cannot
 * finish in 60s, so the container was killed mid-install and the app only
 * worked on the retry that found a warm node_modules — installed, but
 * unlaunchable until you happened to try twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProvisionWatch, nextHealthDeadline, needsProvisioning,
  PROVISION_BEGIN, PROVISION_END, PROVISION_SHELL, RAW_START_SHELL,
} from '../dist/app-manager/provisioning.js';

// ── ProvisionWatch ────────────────────────────────────────────────────────
test('watch is idle until the begin marker arrives', () => {
  const w = new ProvisionWatch();
  assert.equal(w.isProvisioning, false);
  w.observe('[app] some unrelated startup noise\n');
  assert.equal(w.isProvisioning, false);
  assert.equal(w.everProvisioned, false);
});

test('watch tracks begin → end', () => {
  const w = new ProvisionWatch();
  w.observe(`${PROVISION_BEGIN}\n`);
  assert.equal(w.isProvisioning, true);
  w.observe('npm warn deprecated node-domexception@1.0.0\n');
  assert.equal(w.isProvisioning, true, 'stays active across install output');
  w.observe(`${PROVISION_END}\n`);
  assert.equal(w.isProvisioning, false);
  assert.equal(w.everProvisioned, true, 'remembers it happened, for the error message');
});

test('both markers in one chunk settle on "ended"', () => {
  // Docker can hand us several lines in a single data event; a fast provision
  // must not leave the watch stuck active forever.
  const w = new ProvisionWatch();
  w.observe(`${PROVISION_BEGIN}\nnpm install...\n${PROVISION_END}\n`);
  assert.equal(w.isProvisioning, false);
  assert.equal(w.everProvisioned, true);
});

// ── the deadline rule ─────────────────────────────────────────────────────
const BOOT = 60_000;

test('a booting app keeps its ordinary budget', () => {
  const now = 1_000_000;
  const deadline = now + 10_000;
  assert.equal(
    nextHealthDeadline({ now, deadline, hardDeadline: now + 900_000, isProvisioning: false, bootBudgetMs: BOOT }),
    deadline,
    'not provisioning → untouched, so a genuinely broken app still fails at 60s',
  );
});

test('provisioning pushes the boot budget back', () => {
  const now = 1_000_000;
  const deadline = now + 1_000;             // about to expire
  const out = nextHealthDeadline({ now, deadline, hardDeadline: now + 900_000, isProvisioning: true, bootBudgetMs: BOOT });
  assert.equal(out, now + BOOT, 'the app has not been asked to start yet');
});

test('the budget only starts counting when provisioning ends', () => {
  // Simulate a 5-minute install polled every 200ms, then a boot.
  let now = 0;
  let deadline = BOOT;
  const hardDeadline = 900_000;
  for (; now < 300_000; now += 200) {
    deadline = nextHealthDeadline({ now, deadline, hardDeadline, isProvisioning: true, bootBudgetMs: BOOT });
    assert.ok(now < deadline, `killed at ${now}ms mid-install — the original bug`);
  }
  // Provisioning done: the app now gets a full, ordinary boot budget.
  assert.equal(deadline, now - 200 + BOOT);
  const stillOk = nextHealthDeadline({ now, deadline, hardDeadline, isProvisioning: false, bootBudgetMs: BOOT });
  assert.equal(stillOk, deadline, 'no further extension once it is really booting');
});

test('the hard ceiling still ends a wedged install', () => {
  const hardDeadline = 900_000;
  const out = nextHealthDeadline({ now: hardDeadline + 1, deadline: hardDeadline, hardDeadline, isProvisioning: true, bootBudgetMs: BOOT });
  assert.equal(out, hardDeadline, 'past the ceiling, provisioning buys nothing more');
  const clamped = nextHealthDeadline({ now: hardDeadline - 100, deadline: hardDeadline - 100, hardDeadline, isProvisioning: true, bootBudgetMs: BOOT });
  assert.equal(clamped, hardDeadline, 'an extension never overshoots the ceiling');
});

test('an extension never shortens a deadline', () => {
  const now = 1_000;
  const deadline = now + 500_000;           // already generous
  const out = nextHealthDeadline({ now, deadline, hardDeadline: now + 900_000, isProvisioning: true, bootBudgetMs: BOOT });
  assert.equal(out, deadline, 'Math.min alone would have pulled this in to now+60s');
});

// ── needsProvisioning ─────────────────────────────────────────────────────
function appDir(pkg, opts = {}) {
  const d = mkdtempSync(join(tmpdir(), 'aura-prov-'));
  if (pkg) writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  if (opts.astro) {
    mkdirSync(join(d, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(d, 'node_modules', '.bin', 'astro'), '#!/bin/sh\n', { mode: 0o755 });
  }
  if (opts.aura) mkdirSync(join(d, 'node_modules', '@aura', 'app-sdk'), { recursive: true });
  return d;
}

test('a directory with no package.json needs nothing', () => {
  assert.equal(needsProvisioning(appDir(null)), false);
});

test('missing astro needs provisioning', () => {
  assert.equal(needsProvisioning(appDir({ dependencies: { astro: '^6' } })), true);
});

test('astro present and no @aura/* referenced needs nothing', () => {
  assert.equal(needsProvisioning(appDir({ dependencies: { astro: '^6' } }, { astro: true })), false);
});

test('auraDependencies without node_modules/@aura still needs provisioning', () => {
  // The case that shipped CallGemini broken: npm install had run, so astro was
  // there, but @aura/app-sdk is resolved over OCI and had not been pulled.
  const d = appDir({ dependencies: { astro: '^6' }, auraDependencies: { '@aura/app-sdk': '^0.0.1' } }, { astro: true });
  assert.equal(needsProvisioning(d), true);
});

test('auraDependencies already materialised needs nothing', () => {
  const d = appDir(
    { dependencies: { astro: '^6' }, auraDependencies: { '@aura/app-sdk': '^0.0.1' } },
    { astro: true, aura: true },
  );
  assert.equal(needsProvisioning(d), false);
});

test('a legacy @aura/* in plain dependencies counts too', () => {
  const d = appDir({ dependencies: { astro: '^6', '@aura/app-sdk': '^0.0.1' } }, { astro: true });
  assert.equal(needsProvisioning(d), true);
});

// ── raw apps: same rule, but their own entrypoint starts them ─────────────
test('raw: any installed tree counts, astro is not required', () => {
  const pkg = { dependencies: { astro: '^6' }, auraDependencies: { '@aura/app-sdk': '^0.0.1' } };
  assert.equal(needsProvisioning(appDir(pkg), 'raw'), true, 'nothing installed yet');
  assert.equal(needsProvisioning(appDir(pkg, { aura: true }), 'raw'), false, 'a tree without astro is enough');
  assert.equal(needsProvisioning(appDir({ name: 'x' }), 'raw'), false, 'no dependencies, nothing to install');
  assert.equal(needsProvisioning(appDir({ auraDependencies: { '@aura/app-sdk': '^0.0.1' } }), 'raw'), true, '@aura/* still pulled');
});

test('raw start: provisions @aura/* through the same block, then runs the entrypoint', () => {
  // The Trilium case: a raw server that imports @aura/app-sdk, no npm deps of its own.
  const d = appDir({ name: 'raw', auraDependencies: { '@aura/app-sdk': '^0.0.1' } });
  const bin = mkdtempSync(join(tmpdir(), 'aura-prov-bin-'));
  writeFileSync(join(bin, 'aura'), '#!/bin/sh\necho "aura $*" >> calls.log\nmkdir -p node_modules/@aura/app-sdk\n');
  chmodSync(join(bin, 'aura'), 0o755);
  writeFileSync(join(d, 'entrypoint.sh'), 'echo "entry $(pwd)"\n');
  const start = () => execFileSync('bash', ['-c', RAW_START_SHELL, 'aura-raw', join(d, 'entrypoint.sh')],
    { cwd: d, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf-8' });
  const first = start();
  assert.ok(first.indexOf(PROVISION_BEGIN) < first.indexOf(PROVISION_END), 'bracketed for the runner');
  assert.ok(first.indexOf(PROVISION_END) < first.indexOf(`entry ${d}`), 'entrypoint runs after, in the app dir');
  assert.equal(readFileSync(join(d, 'calls.log'), 'utf-8'), 'aura sdk install --quiet\n');
  assert.ok(!existsSync(join(d, 'package-lock.json')), 'no npm install without dependencies');
  const second = start();
  assert.ok(!second.includes(PROVISION_BEGIN), 'a provisioned app boots straight away');
  assert.match(second, /^entry /m);
});

// ── the shell the entrypoint runs ─────────────────────────────────────────
test('the provisioning shell brackets its work in markers', () => {
  assert.ok(PROVISION_SHELL.includes(`echo "${PROVISION_BEGIN}"`));
  assert.ok(PROVISION_SHELL.includes(`echo "${PROVISION_END}"`));
  // Under `set -e`, `[ -x foo ] && VAR=1` exits the script when the test is
  // false. Every guard here must therefore be a real `if`.
  assert.ok(!/^\s*\[[^\]]*\]\s*&&/m.test(PROVISION_SHELL), 'no bare test && assignment');
});

test('an app without its own pnpm workspace does not install into the OS workspace', () => {
  assert.match(PROVISION_SHELL, /if \[ ! -f pnpm-workspace\.yaml \]; then PNPM_SCOPE="--ignore-workspace"; fi/);
  assert.match(PROVISION_SHELL, /\$PNPM install \$PNPM_SCOPE --frozen-lockfile 2>&1 \|\| \$PNPM install \$PNPM_SCOPE 2>&1/);
});
