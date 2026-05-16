// Canonical-combo serialization tests.
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/keymap-canonical.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { comboFromEvent, canonicalize, isModifierCode } from '../dist/keymap/canonical.js';
import { KeymapRegistry } from '../dist/keymap/KeymapRegistry.js';

function ev(code, mods = {}) {
  return {
    code,
    key: code,
    ctrlKey:  !!mods.ctrl,
    altKey:   !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey:  !!mods.meta,
  };
}

test('comboFromEvent: bare key', () => {
  assert.equal(comboFromEvent(ev('Escape')), 'Escape');
  assert.equal(comboFromEvent(ev('KeyJ')),   'KeyJ');
});

test('comboFromEvent: modifier order Ctrl→Alt→Shift→Super', () => {
  const out = comboFromEvent(ev('ArrowUp', { meta: true, shift: true, alt: true, ctrl: true }));
  assert.equal(out, 'Ctrl+Alt+Shift+Super+ArrowUp');
});

test('comboFromEvent: subset of modifiers preserves order', () => {
  assert.equal(comboFromEvent(ev('KeyM', { ctrl: true, alt: true })),   'Ctrl+Alt+KeyM');
  assert.equal(comboFromEvent(ev('KeyS', { ctrl: true, shift: true })), 'Ctrl+Shift+KeyS');
  assert.equal(comboFromEvent(ev('Space', { meta: true })),             'Super+Space');
});

test('comboFromEvent: lone modifier press returns null', () => {
  for (const c of ['ControlLeft', 'ControlRight', 'AltLeft', 'ShiftLeft', 'MetaLeft', 'OSRight']) {
    assert.equal(comboFromEvent(ev(c, { ctrl: true })), null, c);
  }
});

test('isModifierCode: identifies left/right Ctrl/Alt/Shift/Meta/OS', () => {
  assert.ok(isModifierCode('ControlLeft'));
  assert.ok(isModifierCode('OSRight'));
  assert.ok(!isModifierCode('KeyA'));
  assert.ok(!isModifierCode('Escape'));
});

test('canonicalize: accepts synonyms and case', () => {
  assert.equal(canonicalize('ctrl+alt+KeyM'),        'Ctrl+Alt+KeyM');
  assert.equal(canonicalize('Control+Shift+KeyS'),   'Ctrl+Shift+KeyS');
  assert.equal(canonicalize('Cmd+Space'),            'Super+Space');
  assert.equal(canonicalize('meta+Home'),            'Super+Home');
  assert.equal(canonicalize('win+KeyL'),             'Super+KeyL');
  assert.equal(canonicalize('option+KeyA'),          'Alt+KeyA');
});

test('canonicalize: re-orders modifiers to canonical Ctrl→Alt→Shift→Super', () => {
  assert.equal(canonicalize('shift+ctrl+alt+meta+ArrowUp'), 'Ctrl+Alt+Shift+Super+ArrowUp');
});

test('canonicalize: round-trip of comboFromEvent output is stable', () => {
  const a = comboFromEvent(ev('KeyM', { ctrl: true, alt: true }));
  assert.equal(canonicalize(a), a);
  const b = comboFromEvent(ev('ArrowUp', { ctrl: true, shift: true, alt: true, meta: true }));
  assert.equal(canonicalize(b), b);
});

test('canonicalize: empty or malformed input throws', () => {
  assert.throws(() => canonicalize(''));
  assert.throws(() => canonicalize('  '));
  assert.throws(() => canonicalize('Foo+Bar+KeyA'));
});

test('KeymapRegistry: seeds defaults, listByCategory groups them', () => {
  const r = new KeymapRegistry();
  const cats = r.listCategories();
  assert.ok(cats.includes('Basic Navigation'));
  assert.ok(cats.includes('Workspaces'));
  const wsActions = r.listByCategory('Workspaces');
  assert.ok(wsActions.length >= 9);
  for (const a of wsActions) assert.ok(a.id.startsWith('aura.workspace.'));
});

test('KeymapRegistry.reloadFromManifests: app actions prefixed and canonicalised', () => {
  const r = new KeymapRegistry();
  r.reloadFromManifests([
    {
      id: 'com.aura.notepad',
      keymapActions: [
        { id: 'save', label: 'Save', category: 'File', defaultCombo: 'ctrl+s', scope: 'app' },
        { id: 'find', label: 'Find', category: 'Edit', defaultCombo: 'ctrl+f', scope: 'app' },
      ],
    },
  ]);
  const save = r.get('app.com.aura.notepad.save');
  assert.ok(save);
  assert.equal(save.defaultCombo, 'Ctrl+KeyS');
  assert.equal(save.scope, 'app');
  const find = r.get('app.com.aura.notepad.find');
  assert.equal(find.defaultCombo, 'Ctrl+KeyF');
});

test('KeymapRegistry.reloadFromManifests: replaces app.* on each call, preserves OS actions', () => {
  const r = new KeymapRegistry();
  const osCountBefore = r.list().filter((a) => !a.id.startsWith('app.')).length;
  r.reloadFromManifests([
    { id: 'com.aura.notepad', keymapActions: [{ id: 'save', label: 'Save', category: 'App', defaultCombo: null, scope: 'app' }] },
  ]);
  assert.ok(r.get('app.com.aura.notepad.save'));
  r.reloadFromManifests([
    { id: 'com.aura.terminal', keymapActions: [{ id: 'clear', label: 'Clear', category: 'App', defaultCombo: null, scope: 'app' }] },
  ]);
  // notepad's save is gone, terminal's clear is present, OS actions still all there.
  assert.equal(r.get('app.com.aura.notepad.save'), undefined);
  assert.ok(r.get('app.com.aura.terminal.clear'));
  const osCountAfter = r.list().filter((a) => !a.id.startsWith('app.')).length;
  assert.equal(osCountAfter, osCountBefore);
});

test('KeymapRegistry.resolveDefault: scope-gated by mode', () => {
  const r = new KeymapRegistry();
  // os-nav: should resolve in nav mode but not in app mode
  const arrowUpNav = r.resolveDefault('ArrowUp', 'nav');
  assert.ok(arrowUpNav.some((a) => a.id === 'aura.nav.up'));
  const arrowUpApp = r.resolveDefault('ArrowUp', 'app');
  assert.equal(arrowUpApp.length, 0);
  // os-always: should resolve in both modes
  const escNav = r.resolveDefault('Escape', 'nav');
  const escApp = r.resolveDefault('Escape', 'app');
  assert.ok(escNav.some((a) => a.id === 'aura.nav.back'));
  assert.ok(escApp.some((a) => a.id === 'aura.nav.back'));
});
