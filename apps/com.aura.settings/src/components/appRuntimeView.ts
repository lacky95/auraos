/**
 * Settings → Apps → Runtime (Phase 5b stream S, ARI-3): one app's effective
 * runtime and where it came from, and the owner override. Renders into the
 * app row's `[data-app-runtime]` slot from `GET /api/admin/runtimes` (the
 * same state as Settings → Runtimes, components/runtimesView.ts):
 *
 *   Runtime: container · named by the app          [RUNTIME…]
 *   (open)   <select enabled runtimes>  ok | missing …; it could run on: …
 *            [SET OVERRIDE…] [REMOVE OVERRIDE…]
 *
 * Picking a runtime runs the read-only dry run (`POST /api/admin/runtimes/check
 * {runtime, appId}`, `actions.check`) before anything is asked; SET is
 * offered only when it passes. The change itself is the owner's at `fresh`
 * (`PUT /api/admin/runtimes/overrides/:installationId`), checked again when
 * written and at every start. Nothing is auto-picked (Q17): `suggest` only
 * names the runtimes that could run it. DOM only; the page wires `actions`.
 */
import { checkText, type RuntimeCheck } from '@aura/ui/setup';
import { SOURCE_TEXT, type RuntimesState } from './runtimesView';

// The dry run's shape and wording are the setup runtime selector's (@aura/ui/setup): one text for both.
export { checkText, type RuntimeCheck };

export interface AppRuntimeActions {
  check(appId: string, runtime: string): Promise<RuntimeCheck>;
  /** `expected`: the override's runtime the owner saw (null: none), for the compare-and-set. */
  setOverride(installationId: string, appId: string, runtime: string, expected: string | null): void;
  removeOverride(installationId: string, appId: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Render `appId`'s runtime line (and its closed editor) into `slot`. */
export function renderAppRuntime(slot: HTMLElement, appId: string, s: RuntimesState, actions: AppRuntimeActions): void {
  const doc = slot.ownerDocument;
  slot.replaceChildren();
  const inst = s.installations.find((i) => i.appId === appId);
  if (!inst) return;
  const override = inst.installationId ? s.overrides.find((o) => o.installationId === inst.installationId) : undefined;

  const line = el(doc, 'div', 'ar-line');
  const label = inst.error
    ? `Runtime: ${inst.runtime ?? '?'} · does not start: ${inst.error.message}`
    : `Runtime: ${inst.runtime} · ${SOURCE_TEXT[inst.source ?? ''] ?? inst.source ?? ''}`;
  const text = el(doc, 'span', inst.error ? 'ar-text ar-no' : 'ar-text', label);
  text.dataset['runtimeLabel'] = '';
  line.append(text);
  const toggle = el(doc, 'button', 'btn ar-toggle', 'RUNTIME…');
  toggle.type = 'button';
  toggle.dataset['runtimeToggle'] = '';
  line.append(toggle);
  slot.append(line);

  const panel = el(doc, 'div', 'ar-panel');
  panel.dataset['runtimePanel'] = '';
  panel.hidden = true;
  const pending = inst.installationId ? s.pending.find((p) => p.installationId === inst.installationId) : undefined;
  if (pending || !inst.installationId) {
    panel.append(el(doc, 'p', 'ar-note', pending
      ? 'A runtime migration decision is open for this app: decide it in Settings → Runtimes first.'
      : 'Its installation is not recorded yet: try again shortly.'));
  } else {
    const select = el(doc, 'select', 'sf-select');
    select.dataset['runtimeSelect'] = '';
    for (const r of s.runtimes.filter((x) => x.enabled)) {
      const o = el(doc, 'option', undefined, `${r.title} (${r.id})${r.isDefault ? ' · default' : ''}`);
      o.value = r.id;
      o.selected = r.id === inst.runtime;
      select.append(o);
    }
    const result = el(doc, 'span', 'ar-note');
    result.dataset['checkResult'] = '';
    const set = el(doc, 'button', 'btn', 'SET OVERRIDE…');
    set.type = 'button';
    set.dataset['setOverride'] = '';
    set.disabled = true;
    let checked: string | null = null;
    const run = async () => {
      const runtime = select.value;
      checked = null;
      set.disabled = true;
      result.textContent = 'checking…';
      try {
        const c = await actions.check(appId, runtime);
        if (select.value !== runtime) return; // a newer pick won
        result.textContent = checkText(c);
        result.classList.toggle('ar-no', !c.ok);
        checked = c.ok ? runtime : null;
        // Offered only when it passes and changes something (same runtime as an owner override: nothing to set).
        set.disabled = !c.ok || (override?.source === 'override' && override.runtime === runtime);
      } catch (err) {
        result.textContent = `could not check: ${(err as Error).message}`;
      }
    };
    select.addEventListener('change', () => { void run(); });
    set.addEventListener('click', () => {
      if (checked) actions.setOverride(inst.installationId!, appId, checked, override?.runtime ?? null);
    });
    const row = el(doc, 'div', 'ar-row');
    row.append(select, set);
    if (override) {
      const rm = el(doc, 'button', 'btn danger', 'REMOVE OVERRIDE…');
      rm.type = 'button';
      rm.dataset['removeOverride'] = '';
      rm.addEventListener('click', () => actions.removeOverride(inst.installationId!, appId));
      row.append(rm);
    }
    panel.append(row, result);
    panel.append(el(doc, 'p', 'ar-note', override
      ? `${SOURCE_TEXT[override.source] ?? override.source}: ${override.runtime}. An override wins over the app's manifest and the default, and is checked at every start.`
      : 'An override wins over the app\'s manifest and the default, and is checked at every start. Applies at the next start.'));
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && checked === null) void run();
    });
  }
  if (pending || !inst.installationId) toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  slot.append(panel);
}
