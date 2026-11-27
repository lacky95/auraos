// D108 P7: the setup component library (@aura/ui/setup) and the one
// schema-form renderer, moved from Settings into packages/ui (decision W2).
// @aura/ui has no test runner of its own, so its DOM tests live here, beside
// the other runtime-rendered components (happy-dom). Covered: field rendering
// per type, `when` visibility, no secret value in the DOM, unavailable
// profiles not selectable, every added privilege in the approval summary,
// and Settings → Runtimes' form byte-identical to the renderer it replaced.
//
//   node tools/run-tests.mjs --only=shell
import { dom, resetDom } from './dom.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionHolds, setupApplyClass } from '@aura/core';
import type { ConfigField, FieldCondition, FieldView, ProfileOption, SetupApplyPayload, SetupErrorBody } from '@aura/core';

const ui = await import('../../ui/src/setup/index.ts');
const { renderRuntimes } = await import('../../../apps/com.aura.settings/src/components/runtimesView.ts');
// Every import before the first test: the DOM closes when the file's top level is done.

const doc = dom.document as unknown as Document;
const root = (): HTMLElement => { resetDom('<div id="r"></div>'); return doc.getElementById('r') as HTMLElement; };

// ── Settings → Runtimes: unchanged ──────────────────────────────────────────

// The old Settings renderer's output (apps/…settings/src/components/schemaForm.ts at d0ce09a0), captured with happy-dom.
const RUNTIME_SCHEMA = { type: 'object' as const, properties: {
  placement: { type: 'string' as const, title: 'Placement', enum: ['master', 'pool'], enumTitles: { pool: 'Worker pool' }, default: 'master', description: 'Where it runs.' },
  gpu: { type: 'boolean' as const, title: 'GPU', default: false },
  cpus: { type: 'integer' as const, title: 'CPUs', minimum: 1, maximum: 8 },
  label: { type: 'string' as const, title: 'Label' },
  groups: { type: 'array' as const, items: { type: 'string' as const }, title: 'Groups', default: [] },
  useProot: { type: 'boolean' as const, title: 'AURA_USE_PROOT', readOnlySource: 'env' as const },
} };
const ENV_NOTE = '<span class="sf-desc">Set in the environment of the AuraOS container: read-only here.</span>';
const GOLDEN_VALUES = '<label class="sf-row"><span class="sf-title">Placement</span><select class="sf-select" data-setting="placement"><option value="master">master</option><option value="pool">Worker pool</option></select><span class="sf-desc">Where it runs.</span></label>'
  + '<label class="sf-row"><span class="sf-title">GPU</span><input type="checkbox" data-setting="gpu"></label>'
  + '<label class="sf-row"><span class="sf-title">CPUs</span><input class="sf-input" data-setting="cpus" type="number" step="1" min="1" max="8"></label>'
  + '<label class="sf-row"><span class="sf-title">Label</span><input class="sf-input" data-setting="label" type="text"></label>'
  + '<label class="sf-row"><span class="sf-title">Groups</span><input class="sf-input" data-setting="groups" type="text" placeholder="comma-separated"></label>'
  + `<label class="sf-row"><span class="sf-title">AURA_USE_PROOT</span><input type="checkbox" data-setting="useProot" disabled="" data-read-only-source="env">${ENV_NOTE}</label>`;
const GOLDEN_DISABLED = '<label class="sf-row"><span class="sf-title">Placement</span><select class="sf-select" data-setting="placement" disabled=""><option value="master">master</option><option value="pool">Worker pool</option></select><span class="sf-desc">Where it runs.</span></label>'
  + '<label class="sf-row"><span class="sf-title">GPU</span><input type="checkbox" data-setting="gpu" disabled=""></label>'
  + '<label class="sf-row"><span class="sf-title">CPUs</span><input class="sf-input" data-setting="cpus" type="number" step="1" min="1" max="8" disabled=""></label>'
  + '<label class="sf-row"><span class="sf-title">Label</span><input class="sf-input" data-setting="label" type="text" disabled=""></label>'
  + '<label class="sf-row"><span class="sf-title">Groups</span><input class="sf-input" data-setting="groups" type="text" placeholder="comma-separated" disabled=""></label>'
  + `<label class="sf-row"><span class="sf-title">AURA_USE_PROOT</span><input type="checkbox" data-setting="useProot" disabled="" data-read-only-source="env">${ENV_NOTE}</label>`;

test('schema form: a runtime settings schema renders exactly as the Settings renderer it replaced', () => {
  const r = root();
  const form = ui.renderSchemaForm(r, RUNTIME_SCHEMA, { placement: 'pool', cpus: 2, groups: ['a', 'b'], useProot: true });
  assert.equal(r.innerHTML, GOLDEN_VALUES);
  assert.equal((r.querySelector('select[data-setting="placement"]') as HTMLSelectElement).value, 'pool');
  assert.equal((r.querySelector('input[data-setting="useProot"]') as HTMLInputElement).checked, true);
  assert.equal((r.querySelector('input[data-setting="groups"]') as HTMLInputElement).value, 'a, b');
  assert.deepEqual(form.read(), { placement: 'pool', gpu: false, cpus: 2, label: '', groups: ['a', 'b'] }, 'env value never sent; empty text kept');
  assert.deepEqual(form.secrets(), {});
  ui.renderSchemaForm(r, RUNTIME_SCHEMA, {}, { disabled: true });
  assert.equal(r.innerHTML, GOLDEN_DISABLED);
  ui.renderSchemaForm(r, { type: 'object', properties: {} }, {}, { emptyText: 'This runtime has no settings.' });
  assert.equal(r.innerHTML, '<p class="sf-empty">This runtime has no settings.</p>');
});

test('schema form: the Settings runtimes view still says "This runtime has no settings."', () => {
  const r = root();
  const noop = () => {};
  renderRuntimes(r, {
    default: 'container', trusted: true, useProotEnv: null, runtimes: [{
      id: 'container', title: 'Container', description: 'Docker.', builtIn: true, alwaysEnabled: true, enabled: true, isDefault: true,
      settingsSchema: { type: 'object', properties: {} }, settings: {}, capabilities: {} as never, health: { status: 'ok' }, instances: [],
    }], installations: [], overrides: [], pending: [], migration: { d75: null },
  } as never, 'container', { select: noop, saveSettings: noop, setEnabled: noop, makeDefault: noop, removeOverride: noop, decide: noop });
  assert.equal(r.querySelector('[data-settings-form]')!.innerHTML, '<p class="sf-empty">This runtime has no settings.</p>');
});

// ── setup fields (ConfigField) ──────────────────────────────────────────────

const view = (name: string, field: ConfigField, extra: Partial<FieldView> = {}): FieldView => ({ name, field, ...extra });

test('field form: one control per ConfigField type, required marker, pattern, field error; values read back typed', () => {
  const r = root();
  const form = ui.renderFieldViews(r, [
    view('enabled', { type: 'boolean', title: 'Enabled', default: true }),
    view('port', { type: 'integer', title: 'Port', minimum: 1, maximum: 65535, required: true }, { value: 587 }),
    view('host', { type: 'string', title: 'Host', pattern: '[a-z.]+', required: true }, { error: 'invalid value (text matching the field\'s pattern)' }),
    view('auth', { type: 'string', title: 'Sign-in', enum: ['native', 'aura'], default: 'native' }),
    view('tags', { type: 'array', title: 'Tags' }, { value: ['x', 'y'] }),
    view('note', { type: 'string', title: 'Note' }),
  ]);
  assert.ok(r.classList.contains('su-form'));
  assert.equal(r.querySelectorAll('.sf-row').length, 6);
  assert.equal((r.querySelector('input[data-setting="enabled"]') as HTMLInputElement).type, 'checkbox');
  assert.equal((r.querySelector('input[data-setting="port"]') as HTMLInputElement).type, 'number');
  assert.equal((r.querySelector('input[data-setting="host"]') as HTMLInputElement).pattern, '[a-z.]+');
  assert.equal(r.querySelectorAll('select[data-setting="auth"] option').length, 2);
  assert.equal((r.querySelector('input[data-setting="tags"]') as HTMLInputElement).placeholder, 'comma-separated');
  assert.deepEqual([...r.querySelectorAll('.sf-row[data-required]')].map((e) => e.querySelector('[data-setting]')!.getAttribute('data-setting')), ['port', 'host']);
  assert.equal(r.querySelector('[data-field-error="host"]')!.textContent, 'invalid value (text matching the field\'s pattern)');
  assert.ok(r.querySelector('.sf-row[data-invalid] input[data-setting="host"]'));
  assert.deepEqual(form.read(), { enabled: true, port: 587, auth: 'native', tags: ['x', 'y'] }, 'empty optional text is left out');
  assert.equal(form.dirty(), false);
  (r.querySelector('input[data-setting="host"]') as HTMLInputElement).value = 'mail.example';
  assert.equal(form.dirty(), true);
  assert.equal(form.read()['host'], 'mail.example');
});

test('field form: `when` hides a field from the current values (and the profile) and leaves it out of read()', () => {
  const r = root();
  const changes: unknown[] = [];
  const form = ui.renderFieldViews(r, [
    view('auth', { type: 'string', title: 'Sign-in', enum: ['native', 'aura'], default: 'native' }),
    view('admin', { type: 'string', title: 'Admin', when: { field: 'auth', in: ['native'] } }, { value: 'root' }),
    view('team', { type: 'boolean', title: 'Team only', when: { profile: ['team'] } }),
    view('adminPassword', { type: 'secret', title: 'Admin password', secret: { source: 'generate' }, when: { field: 'auth', equals: 'native' } }),
  ], { profile: 'personal', onChange: (v) => changes.push(v), secrets: { handles: [{ handle: 'h-1' }] } });
  const row = (k: string) => (r.querySelector(`[data-setting="${k}"]`) ?? r.querySelector(`[data-secret="${k}"]`))!.closest('.sf-row') as HTMLElement;
  assert.equal(row('admin').hidden, false);
  assert.equal(row('team').hidden, true, 'profile condition false');
  assert.equal(row('adminPassword').hidden, false);
  (r.querySelector('select[data-secret="adminPassword"]') as HTMLSelectElement).value = 'h-1';
  assert.deepEqual(form.secrets(), { adminPassword: 'h-1' });
  const auth = r.querySelector('select[data-setting="auth"]') as HTMLSelectElement;
  auth.value = 'aura';
  auth.dispatchEvent(new dom.Event('change') as unknown as Event);
  assert.equal(row('admin').hidden, true);
  assert.equal(row('adminPassword').hidden, true);
  assert.deepEqual(form.read(), { auth: 'aura' });
  assert.deepEqual(form.secrets(), {}, 'a hidden secret field is not sent');
  assert.deepEqual(changes, [{ auth: 'aura' }]);
  auth.value = 'native';
  auth.dispatchEvent(new dom.Event('change') as unknown as Event);
  assert.equal(row('admin').hidden, false);
  assert.deepEqual(form.read(), { auth: 'native', admin: 'root' });
});

test('field form: whenHolds agrees with core conditionHolds', () => {
  const conds: FieldCondition[] = [
    { field: 'a', equals: 'x' }, { field: 'a', in: ['x', 1, true] }, { field: 'n', equals: 3 }, { field: 'b', equals: true }, { profile: ['p1', 'p2'] },
  ];
  const valueSets = [{}, { a: 'x' }, { a: 'y' }, { a: 1 }, { a: true }, { n: 3 }, { n: '3' }, { b: true }, { a: ['x'] }, { a: null }];
  for (const c of conds) for (const v of valueSets) for (const p of [null, 'p1', 'p3']) {
    assert.equal(ui.whenHolds(c, v, p), conditionHolds(c, v, p), JSON.stringify([c, v, p]));
  }
  assert.equal(ui.whenHolds(undefined, {}, null), true);
});

test('secrets: no value ever reaches the DOM, whatever the props carry; ask hands off to the credential dialog', () => {
  const r = root();
  const MARKER = 'plain-marker-of-a-value'; // stands for a value the API must never send
  const asked: string[] = [];
  const form = ui.renderFieldViews(r, [
    view('apiKey', { type: 'secret', title: 'API key', secret: { source: 'ask' } }, { hasSecret: true, value: MARKER as never }),
    view('sessionKey', { type: 'secret', title: 'Session key', secret: { source: 'generate', length: 32 } }),
    view('dbPass', { type: 'secret', title: 'DB password', secret: { source: 'vault' } }),
  ], { secrets: { handles: [{ handle: 'vault-h1', label: 'openai' }, { handle: 'vault-h2' }], bound: { apiKey: 'vault-h0' }, onAsk: (f) => asked.push(f) } },
  );
  const html = r.innerHTML;
  assert.ok(!html.includes(MARKER), 'the value is never rendered');
  assert.equal(r.querySelectorAll('input[type="password"]').length, 0);
  assert.equal(r.querySelectorAll('input:not([type="checkbox"]):not([type="radio"])').length, 0, 'no text input for a secret');
  assert.deepEqual(form.read(), {}, 'secrets are never read as values');
  assert.deepEqual(form.secrets(), { apiKey: 'vault-h0' }, 'the bound handle');
  const apiOpts = [...r.querySelectorAll('select[data-secret="apiKey"] option')].map((o) => (o as HTMLOptionElement).value);
  assert.deepEqual(apiOpts, ['', 'vault-h0', 'vault-h1', 'vault-h2']);
  assert.match(r.querySelector('select[data-secret="sessionKey"] option')!.textContent ?? '', /Generate/);
  assert.equal(r.querySelector('[data-action="ask-secret"][data-field="sessionKey"]'), null, 'generate: no ask');
  (r.querySelector('[data-action="ask-secret"][data-field="apiKey"]') as HTMLButtonElement).click();
  (r.querySelector('[data-action="ask-secret"][data-field="dbPass"]') as HTMLButtonElement).click();
  assert.deepEqual(asked, ['apiKey', 'dbPass']);
  // The standalone picker neither.
  const p = root();
  const picker = ui.renderSecretPicker(p, { name: 'k', title: 'Key', field: { type: 'secret', title: 'Key', secret: { source: 'vault' } }, handles: [{ handle: 'h' }] });
  assert.equal(picker.selected(), null);
  assert.equal(p.querySelectorAll('input').length, 0);
});

test('secrets: without picker options a secret field is shown disabled (read-only views)', () => {
  const r = root();
  ui.renderFieldViews(r, [view('k', { type: 'secret', title: 'Key', secret: { source: 'ask' } }, { hasSecret: true })]);
  assert.equal((r.querySelector('select[data-secret="k"]') as HTMLSelectElement).disabled, true);
  assert.equal(r.querySelector('[data-action="ask-secret"]'), null);
});

// ── profiles, runtime, home ─────────────────────────────────────────────────

const reason = (error: SetupErrorBody['error'], message: string, extra: Partial<SetupErrorBody> = {}): SetupErrorBody =>
  ({ error, category: 'unsupported-feature', message, ...extra });

const PROFILES: ProfileOption[] = [
  { id: 'personal', title: 'Personal', recommended: true, available: true, reasons: [] },
  { id: 'personal-private', title: 'Personal, my logins', recommended: false, available: true, reasons: [] },
  { id: 'team', title: 'Team', description: 'Shared for several users', recommended: false, available: false,
    reasons: [reason('profile-unavailable', 'Shared instances arrive with multi-user.', { missing: ['instanceScope.shared'], suggest: ['personal'] })] },
];

test('profile selector: recommended badged, nothing auto-picked, unavailable not selectable and gives its reasons', () => {
  const r = root();
  const picked: string[] = [];
  ui.renderProfileSelector(r, { profiles: PROFILES, selected: null }, { onSelect: (id) => picked.push(id) });
  const radio = (id: string) => r.querySelector(`[data-profile="${id}"] input`) as HTMLInputElement;
  assert.deepEqual(PROFILES.map((p) => radio(p.id).checked), [false, false, false], 'never auto-picked, recommended or not');
  assert.ok(r.querySelector('[data-profile="personal"] [data-recommended]'));
  assert.equal(r.querySelector('[data-profile="team"] [data-recommended]'), null);
  assert.equal(radio('team').disabled, true);
  assert.equal(r.querySelector('[data-profile="team"]')!.getAttribute('data-available'), 'false');
  const team = r.querySelector('[data-profile="team"]')!.textContent ?? '';
  assert.match(team, /Shared instances arrive with multi-user\./);
  assert.match(team, /Missing: instanceScope\.shared/);
  assert.match(team, /Could work instead: personal/);
  radio('team').checked = true;
  radio('team').dispatchEvent(new dom.Event('change') as unknown as Event);
  radio('personal-private').checked = true;
  radio('personal-private').dispatchEvent(new dom.Event('change') as unknown as Event);
  assert.deepEqual(picked, ['personal-private'], 'an unavailable profile never reaches onSelect');
  ui.renderProfileSelector(r, { profiles: PROFILES, selected: 'team' }, { onSelect: () => {} });
  assert.equal(radio('team').checked, false, 'not even when selected names it');
  ui.renderProfileSelector(r, { profiles: PROFILES, selected: 'personal' }, { onSelect: () => {} });
  assert.equal(radio('personal').checked, true);
});

test('runtime selector: only runtimes the dry run accepts are selectable; the wording is Settings\' checkText', () => {
  const r = root();
  const picked: Array<string | null> = [];
  ui.renderRuntimeSelector(r, { selected: null, effective: 'container · named by the app', runtimes: [
    { id: 'container', isDefault: true, check: { ok: true, missing: [] } },
    { id: 'proot', check: { ok: false, missing: ['network.isolation'], suggest: ['container'] } },
  ] }, { onSelect: (id) => picked.push(id) });
  const proot = r.querySelector('[data-runtime="proot"]')!;
  assert.equal((proot.querySelector('input') as HTMLInputElement).disabled, true);
  assert.match(proot.textContent ?? '', /no: missing network\.isolation; it could run on: container/);
  assert.equal((r.querySelector('[data-runtime=""] input') as HTMLInputElement).checked, true, 'no override: the app\'s own runtime');
  assert.equal((r.querySelector('[data-runtime="container"] input') as HTMLInputElement).checked, false, 'no runtime picked for the owner');
  const c = r.querySelector('[data-runtime="container"] input') as HTMLInputElement;
  c.checked = true;
  c.dispatchEvent(new dom.Event('change') as unknown as Event);
  assert.deepEqual(picked, ['container']);
  assert.equal(ui.checkText({ ok: false, missing: [], enabled: false }), 'no: the runtime is disabled');
});

test('home selector (D107): App vs Private Home with the approval explanation; shared shown unavailable', () => {
  const r = root();
  const homes: string[] = [];
  const scopes: string[] = [];
  ui.renderHomeSelector(r, {
    declared: { supported: ['app', 'private'], recommended: 'private', reason: 'Uses your Claude login' },
    home: null, privateAvailable: true, privateAuthorized: false, instanceScope: null,
  }, { onHome: (h) => homes.push(h), onInstanceScope: (s) => scopes.push(s) });
  const priv = r.querySelector('[data-home="private"]')!;
  assert.match(priv.textContent ?? '', /needs your own approval with your password/);
  assert.equal(priv.querySelector('[data-private-authorized]')!.getAttribute('data-private-authorized'), 'false');
  assert.match(r.textContent ?? '', /The app says: Uses your Claude login/);
  assert.equal([...r.querySelectorAll('input[type="radio"]')].some((i) => (i as HTMLInputElement).checked), false, 'nothing preselected');
  const shared = r.querySelector('[data-instance-scope="shared"]')!;
  assert.equal((shared.querySelector('input') as HTMLInputElement).disabled, true);
  assert.match(shared.textContent ?? '', /with multi-user/);
  const pi = priv.querySelector('input') as HTMLInputElement;
  pi.checked = true;
  pi.dispatchEvent(new dom.Event('change') as unknown as Event);
  const si = shared.querySelector('input') as HTMLInputElement;
  si.checked = true;
  si.dispatchEvent(new dom.Event('change') as unknown as Event);
  assert.deepEqual([homes, scopes], [['private'], []]);
  // Private not available here: disabled with the D105 reason; App only when the app does not declare it.
  ui.renderHomeSelector(r, { declared: { supported: ['app', 'private'] }, home: 'private', privateAvailable: false,
    privateReasons: [reason('policy-refused', 'The owner turned off Private Home for apps.', { policy: 'app-private-home' })], instanceScope: 'per-user' },
  { onHome: () => {}, onInstanceScope: () => {} });
  const p2 = r.querySelector('[data-home="private"] input') as HTMLInputElement;
  assert.deepEqual([p2.disabled, p2.checked], [true, false], 'desired private is never shown as App Home either');
  assert.equal((r.querySelector('[data-home="app"] input') as HTMLInputElement).checked, false);
  assert.match(r.textContent ?? '', /turned off Private Home/);
  ui.renderHomeSelector(r, { home: 'app', privateAvailable: true, instanceScope: 'per-user' }, { onHome: () => {}, onInstanceScope: () => {} });
  assert.match(r.querySelector('[data-home="private"]')!.textContent ?? '', /does not support the Private Home/);
});

// ── capabilities, resources, storage, dependencies, test ───────────────────

test('capability offer: install/grant through callbacks only', () => {
  const r = root();
  const calls: string[] = [];
  ui.renderCapabilityOffers(r, { capabilities: [
    { name: 'git', level: 'required', installed: true, granted: true },
    { name: 'claude', level: 'optional', installed: false, granted: false, reason: 'For the terminal' },
    { name: 'codex', level: 'optional', installed: true, granted: false },
    { name: 'gpu-tool', level: 'required', installed: false, granted: false, installable: false },
  ] }, { onInstall: (n) => calls.push(`install:${n}`), onGrant: (n) => calls.push(`grant:${n}`) });
  assert.deepEqual([...r.querySelectorAll('[data-capability]')].map((e) => e.getAttribute('data-status')), ['ready', 'missing', 'not-granted', 'missing']);
  assert.equal(r.querySelector('[data-capability="git"] button'), null);
  assert.equal(r.querySelector('[data-capability="gpu-tool"] button'), null);
  (r.querySelector('[data-capability="claude"] [data-action="install-capability"]') as HTMLButtonElement).click();
  (r.querySelector('[data-capability="codex"] [data-action="grant-capability"]') as HTMLButtonElement).click();
  assert.deepEqual(calls, ['install:claude', 'grant:codex']);
  assert.match(r.textContent ?? '', /The app says: For the terminal/);
});

test('resources: an unenforced limit shows as refused, never as running without it', () => {
  const r = root();
  ui.renderResources(r, { requested: { memory: '2g', cpus: 2 }, unenforced: ['resources.limits.cpus'], runtime: 'proot' });
  assert.equal(r.querySelector('[data-limit="memory"]')!.getAttribute('data-status'), 'enforced');
  assert.equal(r.querySelector('[data-limit="cpus"]')!.getAttribute('data-status'), 'refused');
  assert.match(r.querySelector('[data-limit="cpus"]')!.textContent ?? '', /refused: proot cannot enforce/);
  ui.renderStorage(r, { volumes: [{ name: 'data', kind: 'app data', mountPath: '/data', sizeBytes: 2048 }], staysBehind: ['App Home'] });
  assert.match(r.querySelector('[data-volume="data"]')!.textContent ?? '', /at \/data · 2\.0 KiB/);
  assert.match(r.querySelector('[data-stays-behind]')!.textContent ?? '', /App Home/);
});

test('dependencies: met / unmet / degraded; inactive requirements are not shown', () => {
  const r = root();
  ui.renderDependencies(r, {
    dependencies: [{ id: 'com.aura.docs', version: '^1.0.0', status: 'installed', installedVersion: '1.2.0' }, { id: 'io.ex.db', version: '^2', status: 'missing' }],
    requirements: [
      { requirement: { feature: 'network.isolation', level: 'required' }, status: 'met' },
      { requirement: { grant: 'home.private', level: 'required' }, status: 'unmet', error: reason('requirement-unauthorized', 'Needs your Private Home approval.') },
      { requirement: { capability: 'claude', level: 'optional', reason: 'Agents' }, status: 'unmet' },
      { requirement: { feature: 'storage.privateHome', level: 'required', when: { profile: ['x'] } }, status: 'inactive' },
    ],
    degraded: [{ requirement: { capability: 'claude', level: 'optional' }, reason: 'claude is not installed' }],
  });
  assert.deepEqual([...r.querySelectorAll('[data-dependency]')].map((e) => e.getAttribute('data-status')), ['met', 'unmet']);
  assert.deepEqual([...r.querySelectorAll('[data-requirement]')].map((e) => e.getAttribute('data-status')), ['met', 'unmet', 'degraded']);
  assert.ok(!(r.textContent ?? '').includes('storage.privateHome'));
  assert.match(r.textContent ?? '', /Needs your Private Home approval\./);
  assert.match(r.textContent ?? '', /claude is not installed/);
});

test('connection test: renders ValidateResult checks as the app\'s words; the button only calls back', () => {
  const r = root();
  let tests = 0;
  ui.renderConnectionTest(r, { result: { ok: false, checks: [{ id: 'smtp', ok: false, message: 'login refused' }, { id: 'dns', ok: true }], fieldErrors: { smtpHost: 'unknown host' } } },
    { onTest: () => { tests += 1; } });
  assert.equal(r.querySelector('[data-test-ok]')!.getAttribute('data-test-ok'), 'false');
  assert.deepEqual([...r.querySelectorAll('[data-check]')].map((e) => [e.getAttribute('data-check'), e.getAttribute('data-status')]), [['smtp', 'unmet'], ['dns', 'met']]);
  assert.match(r.querySelector('[data-check="smtp"]')!.textContent ?? '', /The app says: login refused/);
  assert.ok(r.querySelector('[data-field-error="smtpHost"]'));
  (r.querySelector('[data-action="test-connection"]') as HTMLButtonElement).click();
  assert.equal(tests, 1);
  ui.renderConnectionTest(r, { result: null, running: true }, { onTest: () => { tests += 1; } });
  assert.equal((r.querySelector('[data-action="test-connection"]') as HTMLButtonElement).disabled, true);
});

// ── approval summary, progress ──────────────────────────────────────────────

const PAYLOAD: SetupApplyPayload = {
  appId: 'io.lakner.openwebui', installationId: 'i-1', profile: 'personal-private', configDigest: 'c', grantDigest: 'g',
  adds: {
    permissions: ['sidecars.spawn', 'apps.port'], tools: ['git', 'docker'], context: ['OPENAI_KEY'],
    homePrivate: true, homePrivateSidecars: ['terminal'], instanceScope: 'per-user',
    networks: { webui: 'instance', terminal: 'instance' }, resources: { memory: '2g', cpus: 2 }, runAsRoot: true,
  },
};

test('approval summary: every added privilege is listed, high-risk first; the password note matches core setupApplyClass', () => {
  const r = root();
  ui.renderApprovalSummary(r, { payload: PAYLOAD, appName: 'Open WebUI' });
  const keys = [...r.querySelectorAll('[data-add]')].map((e) => e.getAttribute('data-add'));
  const expected = [
    'run-as:root', 'home:private', 'home-sidecar:terminal', 'tool:git', 'tool:docker', 'permission:sidecars.spawn', 'permission:apps.port',
    'context:OPENAI_KEY', 'instance-scope', 'network:webui', 'network:terminal', 'resources',
  ];
  assert.deepEqual([...keys].sort(), [...expected].sort(), 'one line per added privilege, nothing else');
  const risky = [...r.querySelectorAll('[data-high-risk] [data-add]')].map((e) => e.getAttribute('data-add'));
  assert.deepEqual(risky, ['run-as:root', 'home:private', 'home-sidecar:terminal', 'tool:docker', 'permission:apps.port', 'context:OPENAI_KEY']);
  assert.match(r.textContent ?? '', /Approve the setup of Open WebUI \(profile personal-private\)/);
  assert.match(r.textContent ?? '', /Controls the container runtime, which is root on the host\./, 'the install review\'s wording');
  assert.equal(r.querySelector('[data-needs-password]')!.getAttribute('data-needs-password'), 'true');
  const variants: SetupApplyPayload['adds'][] = [
    { permissions: [], tools: [], context: [], homePrivate: false, homePrivateSidecars: [] },
    { permissions: ['x'], tools: [], context: [], homePrivate: false, homePrivateSidecars: ['s'] },
    { permissions: [], tools: [], context: [], homePrivate: false, homePrivateSidecars: [], runAsRoot: true },
    { permissions: [], tools: ['docker'], context: ['K'], homePrivate: false, homePrivateSidecars: [] },
    PAYLOAD.adds,
  ];
  for (const adds of variants) {
    const p = { ...PAYLOAD, adds };
    assert.equal(ui.setupApprovalNeedsPassword(p), setupApplyClass(p) === 'forced', JSON.stringify(adds));
  }
  ui.renderApprovalSummary(r, { payload: null });
  assert.match(r.textContent ?? '', /adds no privileges: no approval is needed/);
  assert.equal(r.querySelectorAll('[data-add]').length, 0);
});

test('progress: the plan\'s steps with status and the current one', () => {
  const r = root();
  ui.renderProgress(r, { current: 'review', steps: [
    { step: 'profile', title: 'Profile', status: 'done' }, { step: 'values', title: 'Settings', status: 'done' },
    { step: 'requirements', title: 'Requirements', status: 'skipped' }, { step: 'review', title: 'Review', status: 'todo' },
    { step: 'approval', title: 'Approval', status: 'blocked' },
  ] });
  assert.deepEqual([...r.querySelectorAll('[data-step]')].map((e) => `${e.getAttribute('data-step')}:${e.getAttribute('data-status')}`),
    ['profile:done', 'values:done', 'requirements:skipped', 'review:todo', 'approval:blocked']);
  assert.equal(r.querySelector('[aria-current="step"]')!.getAttribute('data-step'), 'review');
});
