/**
 * Install controls on every store page: render each `[data-ic]` from its
 * InstallState, keep them current from /api/nexus/status, and run the actions
 * behind the main button and the ▾ menu.
 *
 * Bundled once and kept across ClientRouter page swaps: the poller and the
 * delegated handlers live for the whole session and always work on the
 * current page's DOM.
 */
import { navigate } from 'astro:transitions/client';
import type { InstallState } from '../lib/catalog';

type Action = 'install' | 'open' | 'update' | 'install-as' | 'install-copy' | 'uninstall' | 'details';
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

// ─── State → control ───────────────────────────────────────────────────────

function stateOf(ic: HTMLElement): InstallState {
  try { return JSON.parse(ic.dataset.state || '{}') as InstallState; }
  catch { return { status: 'available' } as InstallState; }
}

function mainAction(st: InstallState): Action | null {
  if (st.status === 'installing') return null;
  if (st.status === 'id-taken') return 'install-as';
  if (st.status === 'installed') return st.updateAvailable ? 'update' : 'open';
  return 'install';
}

const MAIN_LABEL: Record<Action, string> = {
  install: 'Install', open: 'Open', update: 'Update', 'install-as': 'Install as…',
  'install-copy': 'Install a copy…', uninstall: 'Uninstall', details: 'Details',
};

/** The version the store offers: live from the poll, else as rendered. */
function storeVersion(ic: HTMLElement, st: InstallState): string | undefined {
  return st.availableVersion ?? ic.dataset.version;
}

function menuItems(ic: HTMLElement, st: InstallState): Array<{ action: Action; label: string; desc?: string; danger?: boolean }> {
  const v = storeVersion(ic, st);
  const items: Array<{ action: Action; label: string; desc?: string; danger?: boolean }> = [];
  const main = mainAction(st);
  if (st.status === 'available') {
    items.push({ action: 'install-as', label: 'Install under another id…', desc: 'Same app, a local id of your choice' });
  }
  if (st.status === 'installed') {
    if (main !== 'open') items.push({ action: 'open', label: 'Open' });
    const canUpdate = st.updateAvailable || ic.hasAttribute('data-local-update');
    if (main !== 'update' && canUpdate && !st.detached) {
      items.push({ action: 'update', label: v ? `Update to v${v}` : 'Update' });
    }
    if (!ic.hasAttribute('data-local-only')) {
      items.push({ action: 'install-copy', label: 'Install a fresh copy…', desc: 'New id + identity, no updates from the store' });
    }
    if (st.canUninstall) items.push({ action: 'uninstall', label: 'Uninstall', desc: 'App data is kept', danger: true });
  }
  if (ic.dataset.app && !location.pathname.endsWith('/app')) items.push({ action: 'details', label: 'Details' });
  return items;
}

function statusText(ic: HTMLElement, st: InstallState): string {
  if (st.status === 'installing') return 'installing…';
  if (st.status === 'id-taken') return `id taken by another app (${st.localAppId})`;
  if (st.status !== 'installed') return '';
  const parts = [`installed${st.installedVersion ? ` v${st.installedVersion}` : ''}`];
  const v = storeVersion(ic, st);
  if (st.updateAvailable && v) parts.push(`→ v${v}`);
  if (st.localAppId && ic.dataset.app && st.localAppId !== ic.dataset.app) parts.push(`as ${st.localAppId}`);
  if (st.detached) parts.push('copy');
  else if (!st.verified) parts.push('not verified');
  else if (st.scope === 'system') parts.push('system app');
  else if (!st.hasRecord) parts.push('built here');
  return parts.join(' · ');
}

/** Render one control (and its card) from a state. */
function render(ic: HTMLElement, st: InstallState): void {
  ic.dataset.state = JSON.stringify(st);
  const main = ic.querySelector<HTMLButtonElement>('.ic-main');
  const more = ic.querySelector<HTMLButtonElement>('.ic-more');
  const action = mainAction(st);
  if (main) {
    const label = action ? MAIN_LABEL[action] : 'Installing…';
    if (main.textContent !== label) main.textContent = label;
    main.disabled = !action || ic.dataset.busy === '1';
    main.dataset.action = action ?? '';
    main.classList.toggle('is-update', action === 'update');
    main.classList.toggle('is-open', action === 'open');
  }
  if (more) more.hidden = menuItems(ic, st).length === 0;
  ic.dataset.status = st.status;

  const card = ic.closest<HTMLElement>('[data-card]');
  const line = card?.querySelector<HTMLElement>('[data-ic-status]') ?? ic.parentElement?.querySelector<HTMLElement>('[data-ic-status]');
  if (line) {
    const t = statusText(ic, st);
    if (line.textContent !== t) line.textContent = t;
    line.classList.toggle('is-update', st.updateAvailable);
  }
  const vBadge = card?.querySelector<HTMLElement>('[data-ic-version]');
  const v = storeVersion(ic, st);
  if (vBadge && v && vBadge.textContent !== `v${v}`) vBadge.textContent = `v${v}`;
  if (v) ic.dataset.version = v;
  if (card?.dataset.facets !== undefined) {
    // Replace only the tags this state owns; keep the page's own (src:, cat:, store …).
    const keep = card.dataset.facets.split(' ').filter((f) => f && !STATE_FACETS.has(f));
    const status = st.status === 'installing' ? 'installed' : st.status;
    const next = [status, st.updateAvailable ? 'update' : '', ...keep].filter(Boolean).join(' ');
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

let pollTimer: ReturnType<typeof setTimeout> | null = null;
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
  pollTimer = setTimeout(pollLoop, POLL_MS);
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
      case 'details':
        if (ref) void navigate(withBase(`/app?id=${encodeURIComponent(ref)}`));
        return;
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
        note(ic, `checking what the update asks for…`);
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

/** A path inside this app, under the shell proxy prefix it is served at. */
function withBase(path: string): string {
  const base = (document.querySelector<HTMLAnchorElement>('a.nexus-brand')?.getAttribute('href') ?? '/').replace(/\/$/, '');
  return base + path;
}

// ─── The ▾ menu (popover on desktop, bottom sheet on phones) ───────────────

let menu: HTMLDivElement | null = null;
let backdrop: HTMLDivElement | null = null;
let menuFor: HTMLElement | null = null;
const sheetQuery = window.matchMedia('(max-width: 560px)');

function ensureMenu(): HTMLDivElement {
  if (menu && document.body.contains(menu)) return menu;
  backdrop = document.createElement('div');
  backdrop.className = 'ic-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', () => closeMenu());
  menu = document.createElement('div');
  menu.className = 'ic-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(backdrop, menu);
  return menu;
}

function closeMenu(focusBack = true): void {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (backdrop) backdrop.hidden = true;
  const more = menuFor?.querySelector<HTMLButtonElement>('.ic-more');
  more?.setAttribute('aria-expanded', 'false');
  if (focusBack) more?.focus();
  menuFor = null;
}

function place(anchor: HTMLElement): void {
  const m = ensureMenu();
  const sheet = sheetQuery.matches;
  m.classList.toggle('is-sheet', sheet);
  if (backdrop) backdrop.hidden = !sheet;
  if (sheet) { m.style.left = m.style.top = ''; return; }
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth || 260;
  const h = m.offsetHeight || 200;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 4 + h < window.innerHeight;
  m.style.left = `${left}px`;
  m.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
}

function openMenu(ic: HTMLElement): void {
  const m = ensureMenu();
  const st = stateOf(ic);
  m.textContent = '';
  const title = document.createElement('div');
  title.className = 'ic-menu-title';
  title.textContent = ic.dataset.name || st.localAppId || '';
  m.append(title);
  for (const it of menuItems(ic, st)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ic-item' + (it.danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.dataset.action = it.action;
    const l = document.createElement('span'); l.className = 'ic-item-label'; l.textContent = it.label;
    b.append(l);
    if (it.desc) { const d = document.createElement('span'); d.className = 'ic-item-desc'; d.textContent = it.desc; b.append(d); }
    b.addEventListener('click', () => onMenuItem(ic, it.action, b));
    m.append(b);
  }
  menuFor = ic;
  m.hidden = false;
  ic.querySelector('.ic-more')?.setAttribute('aria-expanded', 'true');
  place(ic.querySelector<HTMLElement>('.ic-more') ?? ic);
  m.querySelector<HTMLButtonElement>('.ic-item')?.focus();
}

/** The menu turns into a small id form for install-as / install-copy. */
function askId(ic: HTMLElement, action: 'install-as' | 'install-copy'): void {
  const m = ensureMenu();
  const st = stateOf(ic);
  const base = action === 'install-copy' ? (st.localAppId ?? ic.dataset.app ?? 'app') : (ic.dataset.app ?? 'app');
  m.textContent = '';
  const title = document.createElement('div');
  title.className = 'ic-menu-title';
  title.textContent = action === 'install-copy' ? 'Install a fresh copy' : 'Install under another id';
  const hint = document.createElement('p');
  hint.className = 'ic-form-hint';
  hint.textContent = action === 'install-copy'
    ? 'A separate app with its own id and identity. It does not get updates from the store.'
    : 'The same app under a local id of your choice. It keeps getting updates from this source.';
  const label = document.createElement('label');
  label.className = 'ic-form';
  label.textContent = 'Local app id';
  const input = document.createElement('input');
  input.type = 'text'; input.spellcheck = false; input.autocomplete = 'off';
  input.value = `${base}.copy`;
  const err = document.createElement('span'); err.className = 'ic-form-err';
  label.append(input, err);
  const row = document.createElement('div'); row.className = 'ic-form-row';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  const go = document.createElement('button'); go.type = 'button'; go.className = 'ic-go'; go.textContent = 'Install';
  row.append(cancel, go);
  m.append(title, hint, label, row);
  const check = () => {
    const ok = APP_ID.test(input.value.trim());
    err.textContent = ok ? '' : 'reverse-domain id, e.g. com.example.app';
    go.disabled = !ok;
    return ok;
  };
  input.addEventListener('input', check);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && check()) go.click(); });
  cancel.addEventListener('click', () => closeMenu());
  go.addEventListener('click', () => {
    if (!check()) return;
    const id = input.value.trim();
    closeMenu(false);
    void run(ic, action, id);
  });
  check();
  place(ic.querySelector<HTMLElement>('.ic-more') ?? ic);
  input.focus();
  input.select();
}

function onMenuItem(ic: HTMLElement, action: Action, item: HTMLButtonElement): void {
  if (action === 'install-as' || action === 'install-copy') { askId(ic, action); return; }
  if (action === 'uninstall' && item.dataset.armed !== '1') {
    // Two steps, inside the menu: native confirm() is suppressed in the OS iframe.
    item.dataset.armed = '1';
    item.querySelector('.ic-item-label')!.textContent = 'Click again to uninstall';
    return;
  }
  closeMenu(false);
  void run(ic, action);
}

// ─── Wiring (once per session) ─────────────────────────────────────────────

if (!window.__nexusStore) {
  window.__nexusStore = true;

  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement | null;
    const main = t?.closest<HTMLButtonElement>('.ic-main');
    const more = t?.closest<HTMLButtonElement>('.ic-more');
    if (main) {
      const ic = main.closest<HTMLElement>('[data-ic]')!;
      const action = main.dataset.action as Action | '';
      if (!action || main.disabled) return;
      if (action === 'install-as') { openMenu(ic); askId(ic, 'install-as'); return; }
      void run(ic, action);
      return;
    }
    if (more) {
      const ic = more.closest<HTMLElement>('[data-ic]')!;
      if (menuFor === ic && menu && !menu.hidden) { closeMenu(); return; }
      openMenu(ic);
      return;
    }
    if (menu && !menu.hidden && !menu.contains(t)) closeMenu(false);
  });

  document.addEventListener('keydown', (ev) => {
    if (!menu || menu.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('.ic-item')];
      if (!items.length) return;
      ev.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = ev.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next]!.focus();
    }
  });

  window.addEventListener('resize', () => { measureBar(); if (menuFor && menu && !menu.hidden) place(menuFor.querySelector('.ic-more') ?? menuFor); });
  document.addEventListener('scroll', (ev) => {
    if (!sheetQuery.matches && !(menu && menu.contains(ev.target as Node))) closeMenu(false);
  }, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncNow(); });
  document.addEventListener('astro:before-swap', () => closeMenu(false));
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
  document.addEventListener('astro:page-load', () => { measureBar(); renderAll(); showUpdates(); void syncNow(); });

  measureBar();
  renderAll();
  pollLoop();
}

export { syncNow };
