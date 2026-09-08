/**
 * Sidecars — keeping a multi-file tool whole across the `tools[]` boundary.
 *
 * The bug these pin: `aura cap install codex` copied one file. Codex spawns
 * `codex-code-mode-host` as a sibling of its own executable, so the install
 * reported success and Code Mode then failed closed on every run with "host
 * executable was not found". A capability is not always one binary, and the
 * allowlist has to grant a tool and its helpers as a single unit — including
 * the reverse: a helper must never be provisioned without its owner, because
 * a half-present tool reports a broken feature instead of being absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveToolBinaries, toolsGrant, sidecarNames,
} from '../dist/app-manager/tool-allowlist.js';
import {
  detectSidecars, readSidecarMap, writeSidecarMap, setSidecars,
  listToolchainBinaries, SIDECAR_MANIFEST,
} from '../dist/app-manager/tool-provision.js';

const CODEX = { codex: ['codex-code-mode-host'] };
const STORE = ['bash', 'codex', 'codex-code-mode-host', 'docker', 'git'];

// ── grant expansion ───────────────────────────────────────────────────────
test('granting a tool brings its helper', () => {
  const out = resolveToolBinaries(['bash', 'codex'], STORE, CODEX);
  assert.deepEqual(out.sort(), ['bash', 'codex', 'codex-code-mode-host']);
});

test('a helper is never provisioned on its own', () => {
  // Naming the helper directly (or a stale map entry) must not hand a tool's
  // private helper to an app that was not granted the tool.
  const out = resolveToolBinaries(['bash', 'codex-code-mode-host'], STORE, CODEX);
  assert.deepEqual(out, ['bash'], 'orphan helper dropped');
});

test('denying a tool denies its helper too', () => {
  const out = resolveToolBinaries(['codex', '#'], STORE, CODEX);
  assert.ok(!out.includes('codex'), 'owner denied');
  assert.ok(!out.includes('codex-code-mode-host'), 'helper follows the owner out');
  assert.ok(out.includes('git') && out.includes('bash'), 'everything else still granted');
});

test('the wildcard covers helpers', () => {
  assert.deepEqual(resolveToolBinaries(['*'], STORE, CODEX).sort(), [...STORE].sort());
});

test('granted-but-not-installed names are still reported', () => {
  // provisionAllowlist turns these into its `missing` warning, which is the
  // signal that sends someone to `aura cap install`.
  const out = resolveToolBinaries(['glab'], STORE, CODEX);
  assert.deepEqual(out, ['glab']);
});

test('no sidecar map behaves exactly as before', () => {
  assert.deepEqual(resolveToolBinaries(['bash', 'codex'], STORE).sort(), ['bash', 'codex']);
  assert.deepEqual(resolveToolBinaries(['*'], STORE).sort(), [...STORE].sort());
  assert.deepEqual(resolveToolBinaries(['docker', '#'], STORE).sort(),
    ['bash', 'codex', 'codex-code-mode-host', 'git']);
});

test('toolsGrant follows the owner, not the helper name', () => {
  assert.equal(toolsGrant(['codex'], 'codex-code-mode-host', CODEX), true);
  assert.equal(toolsGrant(['bash'], 'codex-code-mode-host', CODEX), false);
  assert.equal(toolsGrant(['codex', '#'], 'codex-code-mode-host', CODEX), false);
  assert.equal(toolsGrant(['*'], 'codex-code-mode-host', CODEX), true);
  // claude-code aliasing and plain tools keep working untouched.
  assert.equal(toolsGrant(['claude-code'], 'claude'), true);
  assert.equal(toolsGrant(['docker'], 'docker'), true);
});

test('sidecarNames lists every non-grantable name', () => {
  assert.deepEqual([...sidecarNames({ codex: ['a', 'b'], foo: ['c'] })].sort(), ['a', 'b', 'c']);
  assert.equal(sidecarNames({}).size, 0);
});

// ── the manifest on disk ──────────────────────────────────────────────────
const store = () => mkdtempSync(join(tmpdir(), 'aura-sidecar-'));

test('the map round-trips and stays out of the binary list', () => {
  const dir = store();
  writeFileSync(join(dir, 'codex'), '');
  writeSidecarMap(dir, CODEX);
  assert.deepEqual(readSidecarMap(dir), CODEX);
  assert.deepEqual(listToolchainBinaries(dir), ['codex'],
    `${SIDECAR_MANIFEST} is a dotfile so it is never mistaken for a tool`);
});

test('a missing or corrupt map degrades to "no sidecars"', () => {
  const dir = store();
  assert.deepEqual(readSidecarMap(dir), {}, 'absent');
  writeFileSync(join(dir, SIDECAR_MANIFEST), '{ not json');
  assert.deepEqual(readSidecarMap(dir), {}, 'corrupt must not break provisioning');
  writeFileSync(join(dir, SIDECAR_MANIFEST), '["wrong shape"]');
  assert.deepEqual(readSidecarMap(dir), {}, 'wrong shape');
});

test('setSidecars records, updates and clears across every store dir', () => {
  const a = store(), b = store();
  setSidecars([a, b], 'codex', ['codex-code-mode-host']);
  assert.deepEqual(readSidecarMap(a), CODEX);
  assert.deepEqual(readSidecarMap(b), CODEX, 'store and mirror agree');
  // An empty list CLEARS, so a tool that stopped shipping a helper does not
  // keep a stale entry that would then provision as `missing`.
  setSidecars([a, b], 'codex', []);
  assert.deepEqual(readSidecarMap(a), {});
});

// ── detection ─────────────────────────────────────────────────────────────
function pkg() {
  const root = store();
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const exe = (name) => { const p = join(bin, name); writeFileSync(p, ''); chmodSync(p, 0o755); return p; };
  return { bin, exe };
}

test('a <binary>-* helper in the tool\'s own dir is adopted automatically', () => {
  const { bin, exe } = pkg();
  const codex = exe('codex');
  exe('codex-code-mode-host');
  const found = detectSidecars({ binaryPath: codex, binaryName: 'codex' });
  assert.deepEqual(found.map((f) => f.name), ['codex-code-mode-host']);
  assert.equal(found[0].src, join(bin, 'codex-code-mode-host'));
});

test('detection ignores the tool itself, unrelated names and non-executables', () => {
  const { bin, exe } = pkg();
  const codex = exe('codex');
  exe('codex-helper');
  exe('unrelated-tool');
  writeFileSync(join(bin, 'codex-readme'), 'not executable');   // mode 0644
  const names = detectSidecars({ binaryPath: codex, binaryName: 'codex' }).map((f) => f.name);
  assert.deepEqual(names, ['codex-helper']);
});

test('system bin dirs are never scanned by prefix', () => {
  // /usr/bin holds thousands of unrelated programs — `git` would adopt
  // `git-lfs`, `apt` would adopt `apt-get`. Those must be declared instead.
  assert.deepEqual(detectSidecars({ binaryPath: '/usr/bin/git', binaryName: 'git' }), []);
});

test('a declared sidecar covers helpers the naming rule cannot see', () => {
  const { bin, exe } = pkg();
  const tool = exe('mytool');
  exe('unrelated-runtime');
  const found = detectSidecars({ binaryPath: tool, binaryName: 'mytool', declared: ['unrelated-runtime'] });
  assert.deepEqual(found.map((f) => f.name), ['unrelated-runtime']);
  assert.equal(found[0].src, join(bin, 'unrelated-runtime'));
});

test('a declared sidecar that is not there is skipped, not fatal', () => {
  const { exe } = pkg();
  const tool = exe('mytool');
  assert.deepEqual(detectSidecars({ binaryPath: tool, binaryName: 'mytool', declared: ['nope'] }), []);
});

test('declared and auto-detected helpers merge without duplicates', () => {
  const { exe } = pkg();
  const codex = exe('codex');
  exe('codex-code-mode-host');
  const found = detectSidecars({
    binaryPath: codex, binaryName: 'codex', declared: ['codex-code-mode-host'],
  });
  assert.deepEqual(found.map((f) => f.name), ['codex-code-mode-host']);
});
