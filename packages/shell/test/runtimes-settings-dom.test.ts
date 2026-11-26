// Settings → Runtimes (Phase 5 stream R, ARI §9.8): the settings form is
// rendered from a runtime's schema (boolean, enum, integer, string,
// string[]), and the page view shows the dropdown, the read-only capability
// table ("no, fails closed"), the apps on the runtime, the overrides with
// Remove and the open D75 decisions. DOM only (happy-dom); the page script
// wires these callbacks to /api/admin/runtimes.
//
//   node tools/run-tests.mjs --only=shell
import { dom, resetDom } from './dom.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderSchemaForm } = await import('../../../apps/com.aura.settings/src/components/schemaForm.ts');
const { renderRuntimes } = await import('../../../apps/com.aura.settings/src/components/runtimesView.ts');
type RuntimesState = import('../../../apps/com.aura.settings/src/components/runtimesView.ts').RuntimesState;

const doc = dom.document as unknown as Document;

test('schema form: one control per field by type, values read back typed', () => {
  resetDom('<div id="f"></div>');
  const root = doc.getElementById('f') as HTMLElement;
  const form = renderSchemaForm(root, {
    type: 'object',
    properties: {
      placement: { type: 'string', title: 'Placement', enum: ['master', 'pool'], default: 'master', description: 'Where it runs.' },
      gpu: { type: 'boolean', title: 'GPU', default: false },
      cpus: { type: 'integer', title: 'CPUs', minimum: 1, maximum: 8 },
      label: { type: 'string', title: 'Label' },
      groups: { type: 'array', items: { type: 'string' }, title: 'Groups', default: [] },
    },
  }, { placement: 'master', cpus: 2, groups: ['a'] });
  assert.equal(root.querySelectorAll('.sf-row').length, 5);
  assert.equal(root.querySelector('select[data-setting="placement"]')!.querySelectorAll('option').length, 2);
  assert.equal((root.querySelector('input[data-setting="gpu"]') as HTMLInputElement).type, 'checkbox');
  assert.equal((root.querySelector('input[data-setting="cpus"]') as HTMLInputElement).type, 'number');
  assert.match(root.textContent ?? '', /Where it runs\./);
  assert.equal(form.dirty(), false);
  assert.deepEqual(form.read(), { placement: 'master', gpu: false, cpus: 2, label: '', groups: ['a'] });
  (root.querySelector('select[data-setting="placement"]') as HTMLSelectElement).value = 'pool';
  (root.querySelector('input[data-setting="gpu"]') as HTMLInputElement).checked = true;
  (root.querySelector('input[data-setting="groups"]') as HTMLInputElement).value = 'a, b ,';
  (root.querySelector('input[data-setting="cpus"]') as HTMLInputElement).value = '';
  assert.deepEqual(form.read(), { placement: 'pool', gpu: true, label: '', groups: ['a', 'b'] });
  assert.equal(form.dirty(), true);
});

test('schema form: no fields says so; disabled renders read-only', () => {
  resetDom('<div id="f"></div>');
  const root = doc.getElementById('f') as HTMLElement;
  renderSchemaForm(root, { type: 'object', properties: {} }, {});
  assert.match(root.textContent ?? '', /no settings/);
  renderSchemaForm(root, { type: 'object', properties: { gpu: { type: 'boolean', title: 'GPU' } } }, {}, { disabled: true });
  assert.equal((root.querySelector('input') as HTMLInputElement).disabled, true);
});

const CAPS = {
  isolation: 'ptrace', privateHomeSession: false, sessionExec: false, identity: 'none', readOnlyBinds: false,
  mounts: false, portExpose: false, sidecars: false, warmPool: true, survivesShellRestart: false,
};
const state = (): RuntimesState => ({
  default: 'container', trusted: true, useProotEnv: 'true',
  runtimes: [
    { id: 'container', title: 'Container', description: 'Docker.', builtIn: true, alwaysEnabled: true, enabled: true, isDefault: true,
      settingsSchema: { type: 'object' as const, properties: {} }, settings: {}, capabilities: { ...CAPS, isolation: 'namespace', readOnlyBinds: true },
      health: { status: 'ok' as const }, instances: [] },
    { id: 'proot', title: 'PRoot', description: 'ptrace.', builtIn: true, alwaysEnabled: false, enabled: true, isDefault: false,
      settingsSchema: { type: 'object' as const, properties: { placement: { type: 'string' as const, title: 'Placement', enum: ['master', 'pool'], default: 'master' } } },
      settings: { placement: 'master' }, capabilities: CAPS, health: { status: 'ok' as const },
      instances: [{ instanceId: 'io.ex.kept-1', appId: 'io.ex.kept', state: 'resumed', source: 'migration' }] },
  ],
  installations: [
    { appId: 'io.ex.kept', installationId: 'i-kept', sandbox: 'omitted', runtime: 'proot', source: 'migration' },
    { appId: 'io.ex.box', installationId: 'i-box', sandbox: 'explicit', runtime: 'container', source: 'manifest' },
  ],
  overrides: [{ installationId: 'i-kept', appId: 'io.ex.kept', runtime: 'proot', source: 'migration', legacy: 'proot-master', recordedAt: '2026-11-26', settings: { placement: 'master' } }],
  pending: [{ installationId: 'i-direct', appId: 'io.ex.direct', legacy: 'master-direct', reason: 'master-direct', sandbox: 'omitted', recordedAt: '2026-11-26' }],
  migration: { d75: '2026-11-26' },
});

function actions() {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]) => { calls.push([name, ...a]); };
  return {
    calls,
    a: { select: rec('select'), saveSettings: rec('saveSettings'), setEnabled: rec('setEnabled'), makeDefault: rec('makeDefault'), removeOverride: rec('removeOverride'), decide: rec('decide') },
  };
}

test('runtimes view: dropdown of installed runtimes, the capability table, the schema form and the apps on it', () => {
  resetDom('<div id="r"></div>');
  const root = doc.getElementById('r') as HTMLElement;
  const { calls, a } = actions();
  renderRuntimes(root, state(), 'proot', a);
  const picker = root.querySelector('select[data-runtime-picker]') as HTMLSelectElement;
  assert.deepEqual([...picker.querySelectorAll('option')].map((o) => o.value), ['container', 'proot']);
  assert.equal(picker.value, 'proot');
  assert.equal(root.querySelector('tr[data-capability="privateHomeSession"] td')!.textContent, 'no, fails closed');
  assert.equal(root.querySelector('tr[data-capability="readOnlyBinds"] td')!.textContent, 'no, fails closed');
  assert.equal(root.querySelector('tr[data-capability="warmPool"] td')!.textContent, 'yes');
  assert.ok(root.querySelector('[data-settings-form] select[data-setting="placement"]'));
  assert.match(root.textContent ?? '', /AURA_USE_PROOT/);
  assert.match(root.textContent ?? '', /apply to new starts/);
  assert.ok(root.querySelector('li[data-app="io.ex.kept"]'));
  (root.querySelector('button[data-action="save-settings"]') as HTMLButtonElement).click();
  (root.querySelector('button[data-action="disable"]') as HTMLButtonElement).click();
  (root.querySelector('button[data-action="default"]') as HTMLButtonElement).click();
  assert.deepEqual(calls, [['saveSettings', 'proot', { placement: 'master' }], ['setEnabled', 'proot', false], ['makeDefault', 'proot']]);
});

test('runtimes view: container cannot be disabled; overrides have Remove; open decisions offer the default and, for master-direct, PRoot', () => {
  resetDom('<div id="r"></div>');
  const root = doc.getElementById('r') as HTMLElement;
  const { calls, a } = actions();
  renderRuntimes(root, state(), 'container', a);
  assert.equal(root.querySelector('button[data-action="disable"]'), null, 'container is always enabled');
  assert.equal(root.querySelector('button[data-action="default"]'), null, 'already the default');
  assert.match(root.querySelector('[data-settings-form]')!.textContent ?? '', /no settings/);
  const ov = root.querySelector('li[data-override="i-kept"]')!;
  assert.match(ov.textContent ?? '', /io\.ex\.kept → proot \(master\) · kept by the runtime migration \(was proot-master\)/);
  (ov.querySelector('button[data-remove-override]') as HTMLButtonElement).click();
  const pend = root.querySelector('li[data-pending="i-direct"]')!;
  const buttons = [...pend.querySelectorAll('button[data-decide]')] as HTMLButtonElement[];
  assert.deepEqual(buttons.map((b) => b.dataset['decide']), ['adopt-default', 'keep']);
  buttons[0]!.click();
  buttons[1]!.click();
  assert.deepEqual(calls, [['removeOverride', 'i-kept', 'io.ex.kept'], ['decide', 'io.ex.direct', 'adopt-default', undefined], ['decide', 'io.ex.direct', 'keep', 'proot']]);
});
