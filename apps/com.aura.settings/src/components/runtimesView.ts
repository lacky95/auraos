/**
 * Settings → Runtimes, the view (Phase 5 stream R, ARI §5.1, D75): renders
 * `GET /api/admin/runtimes` into the page's skeleton. The page script
 * (pages/runtimes.astro) fetches, and calls back into `actions` for every
 * change; this module only builds DOM, so it is DOM-tested on its own.
 *
 * Hooks are `data-*` attributes; classes are styling (`is:global` styles in
 * the page, since these rows are built at runtime).
 */
import { renderSchemaForm, type SchemaForm, type SettingsSchemaLike } from './schemaForm';

export interface RuntimeEntry {
  id: string; title: string; description: string; builtIn: boolean; alwaysEnabled: boolean; enabled: boolean; isDefault: boolean;
  settingsSchema: SettingsSchemaLike; settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  health: { status: 'ok' | 'unavailable'; detail?: string };
  instances: Array<{ instanceId: string; appId: string; state: string; source?: string }>;
}
export interface RuntimesState {
  default: string; trusted: boolean; useProotEnv: string | null;
  runtimes: RuntimeEntry[];
  installations: Array<{ appId: string; installationId: string | null; sandbox: string; runtime: string | null; source: string | null; error?: { code: string; message: string } }>;
  overrides: Array<{ installationId: string; appId?: string; runtime: string; source: string; legacy?: string; recordedAt: string; settings?: Record<string, unknown> }>;
  pending: Array<{ installationId: string; appId: string; legacy: string; reason: string; sandbox: string; recordedAt: string }>;
  migration: { d75: string | null };
}

export interface RuntimesActions {
  select(id: string): void;
  saveSettings(id: string, settings: Record<string, unknown>): void;
  setEnabled(id: string, on: boolean): void;
  makeDefault(id: string): void;
  removeOverride(installationId: string, label: string): void;
  decide(appId: string, decision: 'adopt-default' | 'keep', runtime?: string): void;
}

/** What each capability means for people; a `false` on a fail-closed one says so. */
export const CAPABILITY_ROWS: Array<{ key: string; label: string; failsClosed?: boolean }> = [
  { key: 'isolation', label: 'Isolation' },
  { key: 'privateHomeSession', label: 'Private Home in jump', failsClosed: true },
  { key: 'sessionExec', label: 'Isolated jump session', failsClosed: true },
  { key: 'identity', label: 'Per-app identities' },
  { key: 'readOnlyBinds', label: 'Read-only binds (closed apps)', failsClosed: true },
  { key: 'mounts', label: 'Cross-app mounts' },
  { key: 'portExpose', label: 'Port expose' },
  { key: 'sidecars', label: 'Sidecars' },
  { key: 'warmPool', label: 'Warm pool' },
  { key: 'survivesShellRestart', label: 'Survives a shell restart' },
];

export function capabilityText(v: unknown, failsClosed = false): string {
  if (v === true) return 'yes';
  if (v === false) return failsClosed ? 'no, fails closed' : 'no';
  return String(v);
}

const SOURCE_TEXT: Record<string, string> = {
  manifest: 'named by the app', default: 'the default', override: 'owner override', migration: 'kept by the runtime migration',
};

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(doc: Document, label: string, data: Record<string, string>, cls = 'btn'): HTMLButtonElement {
  const b = el(doc, 'button', cls, label);
  b.type = 'button';
  for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  return b;
}

/**
 * Render the whole page body into `root` for `selected` (a runtime id). The
 * returned form is the selected runtime's settings form.
 */
export function renderRuntimes(root: HTMLElement, s: RuntimesState, selected: string, actions: RuntimesActions): SchemaForm | null {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const current = s.runtimes.find((r) => r.id === selected) ?? s.runtimes.find((r) => r.isDefault) ?? s.runtimes[0];
  if (!current) { root.append(el(doc, 'p', 'rt-note', 'No runtimes are installed.')); return null; }

  // ── the picker and the default ──
  const head = el(doc, 'section', 'rt-section');
  const pick = el(doc, 'div', 'rt-head');
  const label = el(doc, 'span', 'rt-title', 'Runtime');
  const select = el(doc, 'select', 'sf-select');
  select.dataset['runtimePicker'] = '';
  for (const r of s.runtimes) {
    const o = el(doc, 'option', undefined, `${r.title} (${r.id})${r.isDefault ? ' · default' : ''}${r.enabled ? '' : ' · disabled'}${r.health.status === 'ok' ? '' : ' · unavailable'}`);
    o.value = r.id;
    o.selected = r.id === current.id;
    select.append(o);
  }
  select.addEventListener('change', () => actions.select(select.value));
  pick.append(label, select);
  head.append(pick, el(doc, 'p', 'rt-note', current.description));

  const facts = el(doc, 'dl', 'rt-facts');
  const fact = (k: string, v: string, attr?: string) => {
    const dd = el(doc, 'dd', undefined, v);
    if (attr) dd.dataset[attr] = '';
    facts.append(el(doc, 'dt', undefined, k), dd);
  };
  fact('Enabled', current.enabled ? (current.alwaysEnabled ? 'yes (always)' : 'yes') : 'no', 'fact-enabled');
  fact('Default', current.isDefault ? 'yes: apps that name no runtime start on it' : 'no');
  fact('Health', current.health.status === 'ok' ? 'ok' : `unavailable: ${current.health.detail ?? ''}`, 'fact-health');
  if (current.id === 'proot') fact('AURA_USE_PROOT', `${s.useProotEnv ?? '(unset)'} (set on the container, read-only)`);
  head.append(facts);

  const acts = el(doc, 'div', 'rt-actions');
  if (!current.alwaysEnabled) {
    acts.append(button(doc, current.enabled ? 'DISABLE…' : 'ENABLE…', { action: current.enabled ? 'disable' : 'enable' }, current.enabled ? 'btn danger' : 'btn'));
  }
  if (!current.isDefault && current.enabled) acts.append(button(doc, 'MAKE DEFAULT…', { action: 'default' }));
  acts.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!b) return;
    if (b.dataset['action'] === 'default') actions.makeDefault(current.id);
    else actions.setEnabled(current.id, b.dataset['action'] === 'enable');
  });
  if (acts.childElementCount) head.append(acts);
  root.append(head);

  // ── capabilities (read-only) ──
  const caps = el(doc, 'section', 'rt-section');
  caps.append(el(doc, 'span', 'rt-title', 'Capabilities'));
  const table = el(doc, 'table', 'rt-table');
  table.dataset['capabilities'] = '';
  for (const row of CAPABILITY_ROWS) {
    if (!(row.key in current.capabilities)) continue;
    const tr = el(doc, 'tr');
    tr.dataset['capability'] = row.key;
    const v = current.capabilities[row.key];
    const td = el(doc, 'td', v === false && row.failsClosed ? 'rt-no' : undefined, capabilityText(v, row.failsClosed));
    tr.append(el(doc, 'th', undefined, row.label), td);
    table.append(tr);
  }
  caps.append(table);
  root.append(caps);

  // ── settings (from the schema) ──
  const set = el(doc, 'section', 'rt-section');
  set.append(el(doc, 'span', 'rt-title', 'Settings'));
  const formRoot = el(doc, 'div', 'sf-form');
  formRoot.dataset['settingsForm'] = '';
  const form = renderSchemaForm(formRoot, current.settingsSchema, current.settings);
  set.append(formRoot);
  if (Object.keys(current.settingsSchema.properties).length) {
    const save = button(doc, 'SAVE…', { action: 'save-settings' });
    save.addEventListener('click', () => actions.saveSettings(current.id, form.read()));
    set.append(el(doc, 'div', 'rt-actions'));
    set.lastElementChild!.append(save);
  }
  set.append(el(doc, 'p', 'rt-note', 'Changes apply to new starts: running instances keep their runtime and settings until they restart.'));
  root.append(set);

  // ── apps on it ──
  const apps = el(doc, 'section', 'rt-section');
  apps.append(el(doc, 'span', 'rt-title', 'Apps on this runtime'));
  const on = s.installations.filter((i) => i.runtime === current.id);
  if (!on.length) apps.append(el(doc, 'p', 'rt-note', 'None.'));
  const list = el(doc, 'ul', 'rt-list');
  for (const a of on) {
    const li = el(doc, 'li', undefined);
    li.dataset['app'] = a.appId;
    const running = current.instances.filter((i) => i.appId === a.appId).length;
    li.append(el(doc, 'code', undefined, a.appId), ` ${a.error ? `· ${a.error.message}` : `· ${SOURCE_TEXT[a.source ?? ''] ?? a.source ?? ''}`}${running ? ` · ${running} running` : ''}`);
    list.append(li);
  }
  if (on.length) apps.append(list);
  root.append(apps);

  // ── D75: open decisions, then the overrides ──
  if (s.pending.length) {
    const pend = el(doc, 'section', 'rt-section rt-warn');
    pend.append(el(doc, 'span', 'rt-title', 'Runtime migration: decision needed'));
    pend.append(el(doc, 'p', 'rt-note', 'These apps ran in a way that does not meet the security requirements of this release. They do not start until you decide. Nothing is lost either way: only the runtime changes.'));
    const ul = el(doc, 'ul', 'rt-list');
    for (const p of s.pending) {
      const li = el(doc, 'li');
      li.dataset['pending'] = p.installationId;
      const why = p.reason === 'master-direct' ? 'ran unwrapped in the AuraOS container' : 'a closed app on PRoot (no read-only binds)';
      li.append(el(doc, 'code', undefined, p.appId), ` · ${why} `);
      li.append(button(doc, `USE ${s.default.toUpperCase()} (RECOMMENDED)…`, { decide: 'adopt-default', app: p.appId }));
      if (p.reason === 'master-direct') li.append(' ', button(doc, 'KEEP ON PROOT…', { decide: 'keep', app: p.appId, runtime: 'proot' }));
      ul.append(li);
    }
    ul.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-decide]');
      if (b) actions.decide(b.dataset['app']!, b.dataset['decide'] as 'adopt-default' | 'keep', b.dataset['runtime']);
    });
    pend.append(ul);
    root.append(pend);
  }

  const ov = el(doc, 'section', 'rt-section');
  ov.append(el(doc, 'span', 'rt-title', 'Overrides'));
  ov.append(el(doc, 'p', 'rt-note', 'Per-installation runtimes that win over the app\'s manifest and the default. "Kept by the runtime migration" ones keep how an app ran before this release. Removing one applies at the app\'s next start, checked against the runtime it then gets.'));
  if (!s.overrides.length) ov.append(el(doc, 'p', 'rt-note', 'None.'));
  const ul = el(doc, 'ul', 'rt-list');
  for (const o of s.overrides) {
    const li = el(doc, 'li');
    li.dataset['override'] = o.installationId;
    const placement = o.settings?.['placement'] ? ` (${String(o.settings['placement'])})` : '';
    li.append(el(doc, 'code', undefined, o.appId ?? o.installationId), ` → ${o.runtime}${placement} · ${SOURCE_TEXT[o.source] ?? o.source}${o.legacy ? ` (was ${o.legacy})` : ''} `);
    li.append(button(doc, 'REMOVE…', { removeOverride: o.installationId, label: o.appId ?? o.installationId }, 'btn danger'));
    ul.append(li);
  }
  ul.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-remove-override]');
    if (b) actions.removeOverride(b.dataset['removeOverride']!, b.dataset['label']!);
  });
  if (s.overrides.length) ov.append(ul);
  root.append(ov);
  return form;
}
