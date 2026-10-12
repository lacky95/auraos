// sidecar-tools: what an OS sidecar with tools of its own may hold —
// (template ∪ runtime grants) ∩ the app's tools[], resolved to binaries on
// both sides (markers, helper binaries), so a sidecar never exceeds its app.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSidecarTools, SIDECAR_TOOL_RE } from '../dist/app-manager/sidecar-tools.js';

const installed = ['bash', 'codex', 'codex-code-mode-host', 'git', 'jq', 'node', 'rg'];
const helpers = { codex: ['codex-code-mode-host'] };

test('plain lists intersect; tools the app lacks are ignored', () => {
  const r = effectiveSidecarTools(['bash', 'node', 'jq', 'git'], ['jq', 'rg'], [], installed, helpers);
  assert.deepEqual(r.effective, ['jq']);
  assert.deepEqual(r.ignored, ['rg']);
});

test('runtime grants add to the template list', () => {
  const r = effectiveSidecarTools(['bash', 'node', 'jq', 'git'], ['jq'], ['git', 'jq'], installed, helpers);
  assert.deepEqual(r.effective, ['git', 'jq']);
  assert.deepEqual(r.ignored, []);
});

test("'*' on the sidecar side is exactly the app's set; '*' on the app side caps nothing", () => {
  assert.deepEqual(effectiveSidecarTools(['jq', 'git'], ['*'], [], installed, helpers).effective, ['git', 'jq']);
  assert.deepEqual(effectiveSidecarTools(['*'], ['rg'], [], installed, helpers).effective, ['rg']);
  assert.deepEqual(effectiveSidecarTools(['*'], ['*'], [], installed, helpers).effective, [...installed].sort());
});

test("'#' resolves per list: a template deny-list does not swallow runtime grants", () => {
  const app = ['*'];
  const r = effectiveSidecarTools(app, ['#', 'git', 'codex'], ['git'], installed, helpers);
  assert.deepEqual(r.effective, ['bash', 'git', 'jq', 'node', 'rg']);
  assert.deepEqual(r.ignored, [], 'named entries of a marker list are exceptions, not asks');
  // The app's own deny-list caps the sidecar.
  assert.deepEqual(effectiveSidecarTools(['#', 'git'], ['git', 'jq'], [], installed, helpers).effective, ['jq']);
});

test('helpers travel with their owner and never alone', () => {
  assert.deepEqual(effectiveSidecarTools(['codex'], ['codex'], [], installed, helpers).effective, ['codex', 'codex-code-mode-host']);
  assert.deepEqual(effectiveSidecarTools(['codex', 'jq'], ['codex-code-mode-host', 'jq'], [], installed, helpers).effective, ['jq']);
  // The app lacks codex → neither the owner nor its helper.
  const r = effectiveSidecarTools(['jq'], ['codex'], [], installed, helpers);
  assert.deepEqual(r.effective, []);
  assert.deepEqual(r.ignored, ['codex']);
});

test('claude-code is the claude binary; an empty request holds nothing', () => {
  assert.deepEqual(effectiveSidecarTools(['claude-code'], ['claude'], [], ['claude'], {}).effective, ['claude']);
  assert.deepEqual(effectiveSidecarTools(['jq'], [], [], installed, helpers), { effective: [], ignored: [] });
});

test('tool-name validation', () => {
  for (const ok of ['jq', '*', '#', 'claude-code', 'g++', 'python3.12']) assert.ok(SIDECAR_TOOL_RE.test(ok), ok);
  for (const bad of ['', '../x', 'a/b', '-x', 'a b', '.hidden']) assert.ok(!SIDECAR_TOOL_RE.test(bad), bad);
});
