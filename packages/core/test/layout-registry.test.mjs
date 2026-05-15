// Tests for the LayoutStrategyRegistry. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/layout-registry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LayoutStrategyRegistry,
  DEFAULT_LAYOUT_STRATEGIES,
  layoutRegistry,
} from '../dist/layout/LayoutStrategyRegistry.js';

test('singleton seeds tiling, fullscreen, stack', () => {
  const ids = layoutRegistry.list().map((m) => m.id).sort();
  assert.deepEqual(ids, ['fullscreen', 'stack', 'tiling']);
});

test('get returns the matching meta, undefined for unknown', () => {
  assert.equal(layoutRegistry.get('tiling')?.name, 'Tiling');
  assert.equal(layoutRegistry.get('nope'), undefined);
});

test('has is true for seeded ids, false otherwise', () => {
  assert.equal(layoutRegistry.has('tiling'),     true);
  assert.equal(layoutRegistry.has('fullscreen'), true);
  assert.equal(layoutRegistry.has('stack'),      true);
  assert.equal(layoutRegistry.has('spiral'),     false);
});

test('register adds a new strategy', () => {
  const r = new LayoutStrategyRegistry(DEFAULT_LAYOUT_STRATEGIES);
  r.register({ id: 'spiral', name: 'Spiral', description: 'demo' });
  assert.equal(r.has('spiral'), true);
  assert.equal(r.get('spiral')?.name, 'Spiral');
});

test('register replaces an existing strategy by id', () => {
  const r = new LayoutStrategyRegistry(DEFAULT_LAYOUT_STRATEGIES);
  r.register({ id: 'tiling', name: 'CustomTiling', description: 'override' });
  assert.equal(r.get('tiling')?.name, 'CustomTiling');
  // Count unchanged — replace, not duplicate
  assert.equal(r.list().filter((m) => m.id === 'tiling').length, 1);
});

test('stack carries supportsManualPlacement flag', () => {
  const stack = layoutRegistry.get('stack');
  assert.equal(stack?.supportsManualPlacement, true);
  // Tiling does NOT — strategies that auto-arrange omit the flag.
  assert.equal(layoutRegistry.get('tiling')?.supportsManualPlacement, undefined);
});
