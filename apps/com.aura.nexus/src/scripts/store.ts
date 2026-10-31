/**
 * Install controls on every store page. All markup is server-rendered
 * (InstallControl.astro, the id dialog in Layout.astro); this script only:
 *   - applies an InstallState to a control (labels, which items are hidden),
 *     with the same rules as the server (lib/catalog.ts),
 *   - keeps them current from /api/nexus/status,
 *   - runs the actions behind the buttons,
 *   - places an open menu next to its ▾ on desktop (phones: CSS bottom sheet).
 *
 * Bundled once and kept across ClientRouter page swaps: the poller and the
 * delegated handlers live for the whole session and always work on the
 * current page's DOM.
 */
import {
  MAIN_LABEL, mainActionOf, statusLineOf, visibleItems, type InstallState, type MenuAction,
} from '../lib/catalog';

type Action = 'install' | 'open' | 'update' | 'install-as' | 'install-copy' | 'uninstall';
type Result = { ok?: boolean; record?: { id: string; version: string; scope?: string }; cancelled?: boolean; error?: string };

declare global {
  interface Window {
    auraInstall?: (ref: string, opts?: Record<string, unknown>) => Promise<Result>;
    auraUpdate?: (id: string, opts?: Record<string, unknown>) => Promise<Result>;
    __nexusStore?: boolean;
    __nexusNavDepth?: number;
  }
}

const APP_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const POLL_MS = 2500;
const STATE_FACETS = new Set(['available', 'installed', 'id-taken', 'installing', 'update']);
const compact = window.matchMedia('(max-width: 819px)');

// ─── State → control ───────────────────────────────────────────────────────

function stateOf(ic: HTMLElement): InstallState {
  try { return JSON.parse(ic.dataset.state || '{}') as InstallState; }
  catch { return { status: 'available' } as InstallState; }
}

function optsOf(ic: HTMLElement) {
  return {
    catalog: !!ic.dataset.app,
    localUpdate: ic.hasAttribute('data-local-update'),
    onDetail: ic.hasAttribute('data-on-detail'),
  };
}

/** Apply a state to one control and its card. Only toggles and text. */
function render(ic: HTMLElement, st: InstallState): void {
  ic.dataset.state = JSON.stringify(st);
  ic.dataset.status = st.status;
  const busy = ic.dataset.busy === '1';
  const action = mainActionOf(st);
  const v = st.availableVersion ?? ic.dataset.version;
  if (v) ic.dataset.version = v;

  const main = ic.querySelector<HTMLButtonElement>('.ic-main');
  if (main && !busy) {
    const label = action ? MAIN_LABEL[action] : 'Installing…';
    if (main.textContent !== label) main.textContent = label;
    main.disabled = !action;
    main.dataset.action = action ?? '';
    main.classList.toggle('is-update', action === 'update');
    main.classList.toggle('is-open', action === 'open');
  }

  const items = visibleItems(st, optsOf(ic));
  ic.querySelectorAll<HTMLElement>('[data-item]').forEach((el) => {
    el.hidden = !items.has(el.dataset.item as MenuAction);
  });
  const more = ic.querySelector<HTMLButtonElement>('.ic-more');
  if (more) more.hidden = items.size === 0;
  const upd = ic.querySelector<HTMLElement>('[data-update-label]');
  if (upd) upd.textContent = v ? `Update to v${v}` : 'Update';

  const line = statusLineOf(st, ic.dataset.app, ic.dataset.version);
  const menuStatus = ic.querySelector<HTMLElement>('[data-ic-menu-status]');
  if (menuStatus && menuStatus.textContent !== line) menuStatus.textContent = line;

  const card = ic.closest<HTMLElement>('[data-card]') ?? ic.closest<HTMLElement>('[data-ic-scope]');
  const status = card?.querySelector<HTMLElement>('[data-ic-status]');
  if (status) {
    if (status.textContent !== line) status.textContent = line;
    status.classList.toggle('is-update', st.updateAvailable);
  }
  const vBadge = card?.querySelector<HTMLElement>('[data-ic-version]');
  if (vBadge && v && vBadge.textContent !== `v${v}`) vBadge.textContent = `v${v}`;
  if (card?.dataset.facets !== undefined) {
    // Replace only the tags this state owns; keep the page's own (src:, cat:, store …).
    const keep = card.dataset.facets.split(' ').filter((f) => f && !STATE_FACETS.has(f));
    const s = st.status === 'installing' ? 'installed' : st.status;
    const next = [s, st.updateAvailable ? 'update' : '', ...keep].filter(Boolean).join(' ');
    if (next !== card.dataset.facets) {
      card.dataset.facets = next;
      document.dispatchEvent(new CustomEvent('nexus:facets'));
    }
  }
}

function note(ic: HTMLElement, text: string, kind: '' | 'ok' | 'err' = ''): void {
  const card = ic.closest<HTMLElement>('[data-card]') ?? ic.closest<HTMLElement>('[data-ic-scope]');
  const el = card?.querySelector<HTMLElement>('[data-ic-note]');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.className = 'ic-note' + (kind ? ` ${kind}` : '');
}

/** The sticky toolbar sits under the header, whose height depends on the width. */
function measureBar(): void {
  const bar = document.querySelector<HTMLElement>('.nexus-bar');
  if (bar) document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
}

function renderAll(): void {
  document.querySelectorAll<HTMLElement>('[data-ic]').forEach((ic) => render(ic, stateOf(ic)));
}

// ─── Poller ────────────────────────────────────────────────────────────────

let updates = 0;

async function syncNow(): Promise<void> {
  const controls = [...document.querySelectorAll<HTMLElement>('[data-ic][data-app]')];
  const badge = document.querySelector<HTMLElement>('[data-updates-badge]');
  if (!controls.length && !badge) return;
  try {
    const res = await fetch('/api/nexus/status', { cache: 'no-store' });
    const st = await res.json() as { apps?: Record<string, InstallState> };
    const apps = st.apps ?? {};
    for (const ic of controls) {
      if (ic.dataset.busy === '1') continue;
      const s = apps[ic.dataset.app!];
      if (s && JSON.stringify(s) !== ic.dataset.state) render(ic, s);
    }
    updates = Object.values(apps).filter((s) => s.updateAvailable).length;
    showUpdates();
  } catch { /* transient — next tick */ }
}

function showUpdates(): void {
  document.querySelectorAll<HTMLElement>('[data-updates-badge]').forEach((b) => {
    b.textContent = updates ? String(updates) : '';
    b.hidden = !updates;
  });
}

function pollLoop(): void {
  if (!document.hidden) void syncNow();
  setTimeout(pollLoop, POLL_MS);
}

// ─── Actions ───────────────────────────────────────────────────────────────

async function postJson(url: string, body?: unknown): Promise<{ res: Response; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { res, json };
}

/** Open the app's window the way the launcher does; falls back to starting it. */
async function openApp(appId: string): Promise<void> {
  const { res } = await postJson('/api/os/ui/command', { action: 'launchApp', params: { appId } });
  if (res.ok) return;
  const r2 = await postJson(`/api/apps/${encodeURIComponent(appId)}/start`);
  if (!r2.res.ok) throw new Error(String(r2.json['error'] ?? `HTTP ${r2.res.status}`));
}

async function run(ic: HTMLElement, action: Action, appId?: string): Promise<void> {
  const st = stateOf(ic);
  const ref = ic.dataset.app;
  const name = ic.dataset.name || ref || st.localAppId || '';
  const local = st.localAppId;
  const busy = (on: boolean, label?: string) => {
    ic.dataset.busy = on ? '1' : '';
    const main = ic.querySelector<HTMLButtonElement>('.ic-main');
    if (main) { main.disabled = on; if (label) main.textContent = label; }
    if (!on) render(ic, stateOf(ic));
  };
  const done = (r: Result, verb: string) => {
    busy(false);
    if (r.cancelled) { note(ic, `cancelled — nothing was ${verb}`); return; }
    if (!r.ok) { note(ic, `error: ${r.error || `${verb} failed`}`, 'err'); return; }
    note(ic, `✓ ${verb}${r.record ? ` ${r.record.id} v${r.record.version}` : ''}`, 'ok');
    void syncNow();
  };

  try {
    switch (action) {
      case 'open': {
        if (!local) return;
        busy(true, 'Opening…');
        await openApp(local);
        busy(false);
        note(ic, '');
        return;
      }
      case 'install': {
        if (!ref || !window.auraInstall) return;
        busy(true, 'Checking…');
        note(ic, `checking what ${name} asks for…`);
        const r = await window.auraInstall(ref, { name, onApproved: () => { busy(true, 'Installing…'); note(ic, `installing ${name}…`); } });
        done(r, 'installed');
        return;
      }
      case 'install-as':
      case 'install-copy': {
        if (!ref || !window.auraInstall || !appId) return;
        busy(true, 'Checking…');
        note(ic, `checking what ${name} asks for…`);
        const r = await window.auraInstall(ref, {
          name, identity: { action, appId },
          onApproved: () => { busy(true, 'Installing…'); note(ic, `installing ${appId}…`); },
        });
        done(r, 'installed');
        return;
      }
      case 'update': {
        busy(true, 'Checking…');
        note(ic, 'checking what the update asks for…');
        const onApproved = () => { busy(true, 'Updating…'); note(ic, `updating ${name}…`); };
        // From its own source: a plain update. Otherwise installing from here
        // asks first (switch source / not verified) — the identity dialog.
        const plain = (st.fromThisSource && st.hasRecord && local) || (!ref && local);
        const r = plain
          ? await window.auraUpdate!(local!, { name, onApproved })
          : await window.auraInstall!(ref!, { name, onApproved });
        done(r, 'updated');
        return;
      }
      case 'uninstall': {
        if (!local) return;
        busy(true, 'Removing…');
        note(ic, `uninstalling ${local}…`);
        const { res, json } = await postJson(`/api/nexus/uninstall/${encodeURIComponent(local)}`);
        if (!res.ok || json['ok'] === false) throw new Error(String(json['error'] ?? `HTTP ${res.status}`));
        busy(false);
        note(ic, `✓ uninstalled ${local} — its data is kept`, 'ok');
        if (ic.hasAttribute('data-local-only')) ic.closest<HTMLElement>('[data-card]')?.remove();
        void syncNow();
        return;
      }
    }
  } catch (err) {
    busy(false);
    note(ic, `error: ${(err as Error).message ?? err}`, 'err');
  }
}

// ─── The id dialog (Layout.astro) for "install as" / "a fresh copy" ────────

let idFor: { ic: HTMLElement; action: 'install-as' | 'install-copy' } | null = null;

function askId(ic: HTMLElement, action: 'install-as' | 'install-copy'): void {
  const dlg = document.querySelector<HTMLDialogElement>('[data-id-form]');
  if (!dlg) return;
  const st = stateOf(ic);
  dlg.querySelectorAll<HTMLElement>('[data-idf-mode]').forEach((el) => { el.hidden = el.dataset.idfMode !== action; });
  const input = dlg.querySelector<HTMLInputElement>('[data-idf-input]')!;
  const base = action === 'install-copy' ? (st.localAppId ?? ic.dataset.app ?? 'app') : (ic.dataset.app ?? 'app');
  input.value = `${base}.copy`;
  idFor = { ic, action };
  checkId(dlg);
  dlg.showModal();
  input.focus();
  input.select();
}

function checkId(dlg: HTMLDialogElement): boolean {
  const input = dlg.querySelector<HTMLInputElement>('[data-idf-input]')!;
  const err = dlg.querySelector<HTMLElement>('[data-idf-err]')!;
  const ok = APP_ID.test(input.value.trim());
  err.textContent = ok ? '' : 'reverse-domain id, e.g. com.example.app';
  input.setAttribute('aria-invalid', String(!ok));
  dlg.querySelector<HTMLButtonElement>('[data-idf-ok]')!.disabled = !ok;
  return ok;
}

function wireIdDialog(): void {
  const dlg = document.querySelector<HTMLDialogElement>('[data-id-form]');
  if (!dlg || dlg.dataset.wired) return;
  dlg.dataset.wired = '1';
  dlg.querySelector('[data-idf-input]')!.addEventListener('input', () => checkId(dlg));
  dlg.addEventListener('close', () => {
    const target = idFor;
    idFor = null;
    if (dlg.returnValue !== 'ok' || !target || !checkId(dlg)) return;
    const id = dlg.querySelector<HTMLInputElement>('[data-idf-input]')!.value.trim();
    void run(target.ic, target.action, id);
  });
}

// ─── Menu placement (desktop) ──────────────────────────────────────────────

/** A popover opens centred by default; on desktop put it under its ▾. */
function place(menu: HTMLElement): void {
  if (compact.matches) { menu.style.left = menu.style.top = ''; return; }
  const anchor = menu.parentElement?.querySelector<HTMLElement>('.ic-more');
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth || 260;
  const h = menu.offsetHeight || 200;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 4 + h < window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
}

function disarm(menu: HTMLElement): void {
  const u = menu.querySelector<HTMLElement>('[data-item="uninstall"]');
  if (u?.dataset.armed) {
    delete u.dataset.armed;
    const l = u.querySelector('[data-uninstall-label]');
    if (l) l.textContent = 'Uninstall';
  }
}

// ─── Wiring (once per session) ─────────────────────────────────────────────

if (!window.__nexusStore) {
  window.__nexusStore = true;

  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement | null;
    const main = t?.closest<HTMLButtonElement>('.ic-main');
    if (main) {
      const ic = main.closest<HTMLElement>('[data-ic]')!;
      const action = main.dataset.action as Action | '';
      if (!action || main.disabled) return;
      if (action === 'install-as') { askId(ic, 'install-as'); return; }
      void run(ic, action);
      return;
    }
    const item = t?.closest<HTMLElement>('.ic-item[data-item]');
    if (!item || item.tagName === 'A') return;          // Details is a plain link
    const ic = item.closest<HTMLElement>('[data-ic]')!;
    const menu = item.closest<HTMLElement>('.ic-menu');
    const action = item.dataset.item as Action;
    if (action === 'uninstall' && !item.dataset.armed) {
      // Two steps inside the menu: native confirm() is suppressed in the OS iframe.
      item.dataset.armed = '1';
      const l = item.querySelector('[data-uninstall-label]');
      if (l) l.textContent = 'Tap again to uninstall';
      return;
    }
    menu?.hidePopover();
    if (action === 'install-as' || action === 'install-copy') { askId(ic, action); return; }
    void run(ic, action);
  });

  // Popovers: place on open, reset the two-step uninstall on close.
  document.addEventListener('toggle', (ev) => {
    const menu = ev.target as HTMLElement;
    if (!menu.classList?.contains('ic-menu')) return;
    const open = (ev as ToggleEvent).newState === 'open';
    menu.parentElement?.querySelector('.ic-more')?.setAttribute('aria-expanded', String(open));
    if (open) { place(menu); menu.querySelector<HTMLElement>('.ic-item:not([hidden])')?.focus(); }
    else disarm(menu);
  }, true);
  window.addEventListener('resize', () => {
    measureBar();
    document.querySelectorAll<HTMLElement>('.ic-menu:popover-open').forEach(place);
  });
  document.addEventListener('scroll', (ev) => {
    if (compact.matches) return;
    document.querySelectorAll<HTMLElement>('.ic-menu:popover-open').forEach((m) => {
      if (!m.contains(ev.target as Node)) m.hidePopover();
    });
  }, { passive: true, capture: true });
  document.addEventListener('keydown', (ev) => {
    const menu = document.querySelector<HTMLElement>('.ic-menu:popover-open');
    if (!menu || (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp')) return;
    const items = [...menu.querySelectorAll<HTMLElement>('.ic-item:not([hidden])')];
    if (!items.length) return;
    ev.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[ev.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length]!.focus();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncNow(); });
  // How many in-store pages deep we are — the detail page's Back goes back
  // in history (keeping search + filters) when there is somewhere to go.
  window.__nexusNavDepth = 0;
  document.addEventListener('astro:before-preparation', (ev) => {
    const e = ev as Event & { navigationType?: string; direction?: string };
    if (e.navigationType === 'push') window.__nexusNavDepth = (window.__nexusNavDepth ?? 0) + 1;
    else if (e.navigationType === 'traverse') {
      window.__nexusNavDepth = Math.max(0, (window.__nexusNavDepth ?? 0) + (e.direction === 'back' ? -1 : 1));
    }
  });
  document.addEventListener('astro:page-load', () => { measureBar(); wireIdDialog(); renderAll(); showUpdates(); void syncNow(); });

  measureBar();
  wireIdDialog();
  renderAll();
  pollLoop();
}

export { syncNow };
