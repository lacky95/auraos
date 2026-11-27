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
// Every import before the first test: the DOM closes when the file's top level is done.
const { renderAppRuntime, checkText } = await import('../../../apps/com.aura.settings/src/components/appRuntimeView.ts');

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
    { id: 'proot', hostSwitches: { AURA_USE_PROOT: 'true' }, title: 'PRoot', description: 'ptrace.', builtIn: true, alwaysEnabled: false, enabled: true, isDefault: false,
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

// ── 5b S: grown Runtimes page, Apps → Runtime ──────────────────────────────

/** Settle the view's async dry run (microtasks only: happy-dom owns the timers). */
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const grown = (): RuntimesState => {
  const s = state();
  const proot = s.runtimes[1]!;
  Object.assign(proot, {
    version: '1.0.0', ari: 1, settingsVersion: 1,
    capabilities: { ...CAPS, network: 'shell-netns', appHome: true, hostFilesystem: true, idmappedMounts: false, usage: false, gpu: false, userNamespaces: false },
    health: { status: 'ok', checks: [{ id: 'rootfs', ok: true }, { id: 'use-proot', ok: true, detail: 'AURA_USE_PROOT=true' }] },
    features: [
      { id: 'mount.attach', support: 'unsupported' },
      { id: 'tools.liveRevoke', support: 'conditional', applyMode: 'live', constraints: { enforcement: 'advisory' } },
    ],
    restartToApply: 1,
    instances: [{ instanceId: 'io.ex.kept-1', appId: 'io.ex.kept', state: 'resumed', source: 'migration', restartToApply: true }],
  });
  s.installations[0]!.needs = ['mounts'];
  s.report = {
    features: { proot: [{ id: 'mount.attach', support: 'unsupported' }, { id: 'execution.command', support: 'supported' }] },
    d75: '2026-11-26T12:00:00.000Z', reports: [{ file: '/data/aura/runtime-migration/x.json', recordedAt: 'x', installations: 2, counts: {} }],
    installations: [
      { appId: 'io.ex.kept', installationId: 'i-kept', sandbox: 'omitted', legacy: 'proot-master', decision: 'override', reason: '',
        override: { runtime: 'proot', source: 'migration' }, pending: null, current: { runtime: 'proot', source: 'migration' } },
      { appId: 'io.ex.direct', installationId: 'i-direct', sandbox: 'omitted', legacy: 'master-direct', decision: 'incompatible', reason: '',
        override: null, pending: { reason: 'master-direct' }, current: { runtime: null, source: null, error: { code: 'runtime-decision-needed', message: 'm' } } },
    ],
  };
  return s;
};

test('runtimes view (5b): version and ARI, health checks, every capability, features, restart to apply, needs, the migration report', () => {
  resetDom('<div id="r"></div>');
  const root = doc.getElementById('r') as HTMLElement;
  renderRuntimes(root, grown(), 'proot', actions().a);
  assert.equal(root.querySelector('[data-fact-version]')!.textContent, '1.0.0 · ARI 1 · settings v1');
  assert.deepEqual([...root.querySelectorAll('[data-health-checks] li')].map((l) => (l as HTMLElement).dataset['check']), ['rootfs', 'use-proot']);
  for (const k of ['network', 'appHome', 'hostFilesystem', 'idmappedMounts', 'usage', 'gpu']) assert.ok(root.querySelector(`tr[data-capability="${k}"]`), k);
  assert.equal(root.querySelector('tr[data-capability="idmappedMounts"] td')!.textContent, 'no, fails closed');
  assert.equal(root.querySelector('tr[data-capability="survivesShellRestart"] td')!.textContent, 'no', 'a fact, not a need');
  assert.equal(root.querySelector('tr[data-feature="tools.liveRevoke"] td')!.textContent, 'conditional, live, enforcement: advisory', 'advisory, never enforced');
  assert.match(root.textContent ?? '', /both must hold/);
  const applies = root.querySelector('[data-restart-to-apply]') as HTMLElement;
  assert.equal(applies.dataset['restartToApply'], '1');
  assert.match(applies.textContent ?? '', /1 instance\(s\) run on the old settings or another runtime: restart to apply/);
  assert.match(root.querySelector('li[data-app="io.ex.kept"]')!.textContent ?? '', /needs mounts/);
  const report = root.querySelector('[data-migration-report]')!;
  assert.match(report.querySelector('tr[data-report-row="io.ex.kept"]')!.textContent ?? '', /proot-master.*kept by the runtime migration: proot.*proot \(kept by the runtime migration\)/);
  assert.match(report.querySelector('tr[data-report-row="io.ex.direct"]')!.textContent ?? '', /decision needed \(master-direct\).*not started: runtime-decision-needed/);
  assert.equal(report.querySelector('[data-report-features="proot"]')!.textContent, 'proot: mount.attach unsupported');
});

test('schema form: an env-sourced value is read-only and never sent', () => {
  resetDom('<div id="f"></div>');
  const root = doc.getElementById('f') as HTMLElement;
  const form = renderSchemaForm(root, { type: 'object', properties: {
    useProot: { type: 'boolean', title: 'AURA_USE_PROOT', readOnlySource: 'env' },
    placement: { type: 'string', title: 'Placement', enum: ['master'] },
  } }, { useProot: true, placement: 'master' });
  const env = root.querySelector('input[data-setting="useProot"]') as HTMLInputElement;
  assert.deepEqual([env.disabled, env.dataset['readOnlySource']], [true, 'env']);
  assert.match(root.textContent ?? '', /environment of the AuraOS container/);
  assert.deepEqual(form.read(), { placement: 'master' });
});

test('apps → runtime: the effective runtime and source; a live dry run before SET; Remove for an override; nothing auto-picked', async () => {
  resetDom('<div id="a"></div><div id="b"></div><div id="c"></div>');
  const calls: unknown[][] = [];
  const checks: Record<string, { ok: boolean; missing: string[]; suggest?: string[] }> = {
    container: { ok: true, missing: [] }, proot: { ok: false, missing: ['readOnlyBinds'], suggest: ['container'] },
  };
  const actionsA = {
    check: async (appId: string, runtime: string) => { calls.push(['check', appId, runtime]); return checks[runtime]!; },
    setOverride: (...a: unknown[]) => { calls.push(['set', ...a]); },
    removeOverride: (...a: unknown[]) => { calls.push(['rm', ...a]); },
  };
  const s = state();
  const box = doc.getElementById('a') as HTMLElement;
  renderAppRuntime(box, 'io.ex.box', s, actionsA);
  assert.equal(box.querySelector('[data-runtime-label]')!.textContent, 'Runtime: container · named by the app');
  assert.equal((box.querySelector('[data-runtime-panel]') as HTMLElement).hidden, true);
  assert.equal(box.querySelector('[data-remove-override]'), null, 'no override, nothing to remove');
  (box.querySelector('[data-runtime-toggle]') as HTMLButtonElement).click();
  await flush();
  const select = box.querySelector('[data-runtime-select]') as HTMLSelectElement;
  assert.deepEqual([...select.querySelectorAll('option')].map((o) => o.value), ['container', 'proot']);
  select.value = 'proot';
  select.dispatchEvent(new dom.Event('change') as unknown as Event);
  await flush();
  assert.equal(box.querySelector('[data-check-result]')!.textContent, 'no: missing readOnlyBinds; it could run on: container');
  assert.equal((box.querySelector('[data-set-override]') as HTMLButtonElement).disabled, true, 'a refused runtime cannot be set');
  select.value = 'container';
  select.dispatchEvent(new dom.Event('change') as unknown as Event);
  await flush();
  const set = box.querySelector('[data-set-override]') as HTMLButtonElement;
  assert.equal(set.disabled, false);
  set.click();
  assert.deepEqual(calls.filter((c) => c[0] === 'set'), [['set', 'i-box', 'io.ex.box', 'container', null]]);
  assert.equal(select.value, 'container', 'the select never moves by itself');

  const kept = doc.getElementById('b') as HTMLElement;
  renderAppRuntime(kept, 'io.ex.kept', s, actionsA);
  assert.match(kept.querySelector('[data-runtime-label]')!.textContent ?? '', /proot · kept by the runtime migration/);
  (kept.querySelector('[data-remove-override]') as HTMLButtonElement).click();
  assert.deepEqual(calls.at(-1), ['rm', 'i-kept', 'io.ex.kept']);

  // An open D75 decision: no editor, a pointer to Settings → Runtimes.
  const s2 = state();
  s2.installations.push({ appId: 'io.ex.direct', installationId: 'i-direct', sandbox: 'omitted', runtime: 'proot', source: null, error: { code: 'runtime-decision-needed', message: 'decision needed' } });
  const direct = doc.getElementById('c') as HTMLElement;
  renderAppRuntime(direct, 'io.ex.direct', s2, actionsA);
  assert.match(direct.querySelector('[data-runtime-label]')!.textContent ?? '', /does not start: decision needed/);
  assert.equal(direct.querySelector('[data-runtime-select]'), null);
  assert.match(direct.textContent ?? '', /decide it in Settings → Runtimes first/);
  assert.equal(checkText({ ok: false, missing: ['sidecars'], suggest: [] }), 'no: missing sidecars; no installed runtime can run it');
});
