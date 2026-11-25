// Address bar + bookmarks for the Browser page: search-or-URL resolution,
// a suggestion dropdown over history and bookmarks with inline completion,
// the ☆ button and the bookmarks bar. Also the engine policy hand-over and
// the notice for addresses that do not load in the engine. index.astro's
// inline script owns the engine (iframe / native window) and hands us
// `window.__browser`.
//
// Page titles / URLs are untrusted: always textContent, never innerHTML.
import { OsClient, appHostRuntime, postToShell } from '@aura/app-sdk';
import {
  resolveInput, classifyInput, searchUrl, rankEntries, inlineCompletion,
  displayUrl, SEARCH_ENGINE, type Entry,
} from '../lib/omnibox';
import {
  BLANK_SANDBOX, classifyEngineUrl, readableLoadAllowed, sandboxFor,
  type EngineContext, type EngineKind, type EngineTarget,
} from '../lib/engine-policy';

interface Host {
  navigate(url: string): void;
  currentUrl(): string;
  currentTitle(): string;
  onUrlChange(cb: (url: string, title: string) => void): void;
  coverEngine(reason: string, covered: boolean): void;
  closeSettingsMenu(): void;
  usePolicy(policy: EnginePolicy): void;
  onNotice(cb: (n: EngineNotice) => void): void;
}
interface EnginePolicy {
  classify(url: string): EngineTarget;
  sandboxFor(kind: EngineKind): string | null;
  readableLoadAllowed(href: string): boolean;
  blankSandbox: string;
}
interface EngineNotice { kind: EngineKind | 'reset' | 'slow' | 'needs-top-level' | 'loaded'; url: string; user: boolean }
interface Bookmark { id: string; title: string; url: string }
interface HistoryEntry { url: string; title: string; visitCount: number; lastVisit: number }

const BAR_PREF_KEY = 'aura.browser.bookmarksBar';

async function api(path: string, init?: { method?: string; json?: unknown }) {
  const r = await fetch(path, {
    method: init?.method,
    headers: init?.json !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function hostInitial(url: string) {
  try { return (new URL(url).hostname.replace(/^www\./, '')[0] || '•').toUpperCase(); } catch { return '•'; }
}

const isWeb = (url: string) => /^https?:/i.test(url);

function init(host: Host) {
  const urlInput = document.getElementById('url-input') as HTMLInputElement;
  const urlForm = document.getElementById('url-form') as HTMLFormElement;
  const goBtn = document.getElementById('go-btn')!;
  const lock = document.getElementById('url-lock')!;
  const list = document.getElementById('omnibox-list')!;
  const star = document.getElementById('star-btn')!;
  const bar = document.getElementById('bookmarks-bar')!;
  const bmMenu = document.getElementById('bookmark-menu')!;
  const menuBarBtn = document.getElementById('menu-bookmarks-btn')!;

  let bookmarks: Bookmark[] = [];
  let history: HistoryEntry[] = [];

  async function loadBookmarks() {
    try { bookmarks = (await api('api/bookmarks')).bookmarks; } catch (err) { console.warn('[browser] bookmarks', err); }
    renderBar();
    updateStar();
  }
  async function loadHistory() {
    try { history = (await api('api/history?limit=2000')).history; } catch (err) { console.warn('[browser] history', err); }
  }

  // ---- visits --------------------------------------------------------------
  // Every change of the current URL counts as a visit; a title that arrives
  // later for the same URL just updates the entry (the store dedupes a visit
  // to the URL already on top). Short debounce: redirects and SPA route
  // bursts collapse into the URL the page settled on.
  let visitTimer: ReturnType<typeof setTimeout> | undefined;
  function recordVisit(url: string, title: string) {
    clearTimeout(visitTimer);
    if (!isWeb(url)) return;
    visitTimer = setTimeout(() => {
      api('api/history', { method: 'POST', json: { url, title } }).catch((err) => console.warn('[browser] visit', err));
    }, 800);
  }

  function onUrl(url: string, title: string) {
    const secure = /^https:/i.test(url);
    lock.dataset.secure = String(secure);
    lock.title = secure ? 'Secure connection (https)' : 'Not secure';
    updateStar();
    recordVisit(url, title);
  }
  host.onUrlChange(onUrl);

  // ---- suggestions -----------------------------------------------------------
  type Row = { kind: 'go' | 'search' | 'entry'; url: string; label: string; sub?: string; bookmark?: boolean; history?: boolean };
  let rows: Row[] = [];
  let sel = 0;
  let typed = '';   // what the user actually typed (without the inline completion)

  function entries(): Entry[] {
    const bm = new Set(bookmarks.map((b) => b.url));
    const out: Entry[] = bookmarks.map((b) => {
      const h = history.find((x) => x.url === b.url);
      return { url: b.url, title: b.title, bookmark: true, visitCount: h?.visitCount ?? 1, lastVisit: h?.lastVisit };
    });
    for (const h of history) if (!bm.has(h.url)) out.push(h);
    return out;
  }

  function buildRows(q: string) {
    const c = classifyInput(q);
    const ranked = rankEntries(q, entries(), 8);
    rows = [];
    if (c?.kind === 'url') rows.push({ kind: 'go', url: c.url, label: q.trim(), sub: 'Go to address' });
    if (c) {
      const sq = c.kind === 'search' ? c.query : q.trim();
      rows.push({ kind: 'search', url: searchUrl(sq), label: sq, sub: `${SEARCH_ENGINE.name} search` });
    }
    const bm = new Set(bookmarks.map((b) => b.url));
    for (const e of ranked) {
      if (rows.some((r) => r.url === e.url)) continue;
      rows.push({ kind: 'entry', url: e.url, label: e.title || displayUrl(e.url), sub: displayUrl(e.url), bookmark: bm.has(e.url), history: !e.bookmark });
    }
    sel = 0;
    return ranked;
  }

  function setListOpen(open: boolean) {
    list.hidden = !open;
    urlInput.setAttribute('aria-expanded', String(open));
    host.coverEngine('omnibox', open);
  }

  function renderList() {
    list.replaceChildren();
    rows.forEach((r, i) => {
      const row = el('div', 'omni-row');
      row.setAttribute('role', 'option');
      row.dataset.i = String(i);
      row.setAttribute('aria-selected', String(i === sel));
      const glyph = r.kind === 'search' ? '⌕' : r.kind === 'go' ? '↗' : hostInitial(r.url);
      const text = el('span', 'omni-text');
      text.append(el('span', 'omni-title', r.label));
      if (r.sub) text.append(el('span', 'omni-sub', r.sub));
      row.append(el('span', 'omni-glyph', glyph), text);
      if (r.bookmark) row.append(el('span', 'omni-star', '★'));
      if (r.history) {
        const x = el('button', 'omni-del', '×');
        x.type = 'button';
        x.title = 'Remove from history (Shift+Del)';
        x.dataset.del = String(i);
        row.append(x);
      }
      list.append(row);
    });
    setListOpen(rows.length > 0);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function closeList() { rows = []; setListOpen(false); }

  function onType(e: Event) {
    typed = urlInput.value;
    if (!typed.trim()) { closeList(); return; }
    const ranked = buildRows(typed);
    // Inline completion only while appending, never while deleting.
    if ((e as InputEvent).inputType?.startsWith('insert')) {
      const comp = inlineCompletion(typed, ranked);
      if (comp && urlInput.selectionStart === typed.length) {
        urlInput.value = typed + comp.slice(typed.length);
        urlInput.setSelectionRange(typed.length, urlInput.value.length);
        const idx = rows.findIndex((r) => r.kind === 'entry' && displayUrl(r.url) === comp);
        if (idx >= 0) sel = idx;
      }
    }
    renderList();
  }

  function go(url: string) {
    closeList();
    urlInput.blur();
    urlInput.value = url;
    host.navigate(url);
  }

  async function removeRow(i: number) {
    const r = rows[i];
    if (!r?.history) return;
    history = history.filter((h) => h.url !== r.url);
    rows.splice(i, 1);
    if (sel >= rows.length) sel = rows.length - 1;
    renderList();
    try { await api(`api/history?url=${encodeURIComponent(r.url)}`, { method: 'DELETE' }); }
    catch (err) { console.warn('[browser] remove history', err); loadHistory(); }
  }

  // First click into the bar selects everything; later clicks place the caret.
  let justFocused = false;
  urlInput.addEventListener('focus', () => { justFocused = true; urlInput.select(); loadHistory(); });
  urlInput.addEventListener('mouseup', (e) => {
    if (!justFocused) return;
    justFocused = false;
    e.preventDefault();
    urlInput.select();
  });
  urlInput.addEventListener('input', onType);
  urlInput.addEventListener('blur', (e) => {
    justFocused = false;
    closeList();
    // Leaving the bar without going anywhere puts the page's URL back —
    // except when focus moves to GO, which submits what was typed.
    if ((e as FocusEvent).relatedTarget !== goBtn) urlInput.value = host.currentUrl();
  });
  urlInput.addEventListener('keydown', (e) => {
    const open = !list.hidden && rows.length > 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      urlInput.value = rows[sel].kind === 'entry' ? rows[sel].url : typed;
      renderList();
    } else if (e.key === 'Escape') {
      // Two steps: drop the list (and the completion), then the edit itself.
      e.preventDefault();
      if (open) { closeList(); urlInput.value = typed; }
      else urlInput.blur();
    } else if (e.key === 'Delete' && e.shiftKey && open) {
      e.preventDefault();
      removeRow(sel);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // A highlighted row wins only when the user moved to it; the default
      // first row means "resolve what's in the box" (incl. inline completion).
      if (open && sel > 0) { go(rows[sel].url); return; }
      const url = resolveInput(urlInput.value);
      if (url) go(url);
    }
  });
  // Tapping GO must not take focus from the input: the blur handler would
  // put the page's URL back before the submit reads the typed text.
  goBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  urlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = resolveInput(urlInput.value);
    if (url) go(url);
  });
  // mousedown (not click) so the input keeps focus until we act.
  list.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const t = e.target as HTMLElement;
    const del = t.closest<HTMLElement>('[data-del]');
    if (del) { removeRow(Number(del.dataset.del)); return; }
    const row = t.closest<HTMLElement>('[data-i]');
    if (row) go(rows[Number(row.dataset.i)].url);
  });

  // ---- bookmarks -------------------------------------------------------------
  const bookmarkFor = (url: string) => bookmarks.find((b) => b.url === url);

  function updateStar() {
    const url = host.currentUrl();
    const on = !!bookmarkFor(url);
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-pressed', String(on));
    star.toggleAttribute('disabled', !isWeb(url));
    star.title = on ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  }

  async function toggleBookmark() {
    const url = host.currentUrl();
    if (!isWeb(url)) return;
    const existing = bookmarkFor(url);
    try {
      if (existing) {
        bookmarks = bookmarks.filter((b) => b !== existing);
        renderBar(); updateStar();
        await api(`api/bookmarks?id=${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
      } else {
        const title = host.currentTitle() || displayUrl(url);
        bookmarks = [...bookmarks, { id: 'pending', url, title }];
        renderBar(); updateStar();
        await api('api/bookmarks', { method: 'POST', json: { url, title } });
      }
    } catch (err) { console.warn('[browser] bookmark', err); }
    loadBookmarks();
  }
  star.addEventListener('click', toggleBookmark);

  // Bar visibility is a per-device preference, like native mode.
  let barWanted = true;
  try { barWanted = localStorage.getItem(BAR_PREF_KEY) !== 'off'; } catch { /* storage blocked */ }
  function setBarWanted(on: boolean) {
    barWanted = on;
    try { localStorage.setItem(BAR_PREF_KEY, on ? 'on' : 'off'); } catch { /* storage blocked */ }
    renderBar();
  }
  menuBarBtn.addEventListener('click', () => { setBarWanted(!barWanted); host.closeSettingsMenu(); });

  let renamingId: string | null = null;
  function renderBar() {
    menuBarBtn.setAttribute('aria-checked', String(barWanted));
    menuBarBtn.textContent = 'Bookmarks bar: ' + (barWanted ? 'on' : 'off');
    bar.hidden = !barWanted;
    if (!barWanted) return;
    bar.replaceChildren();
    if (!bookmarks.length) { bar.append(el('span', 'bm-hint', 'Press ☆ to bookmark a page')); return; }
    for (const b of bookmarks) {
      if (b.id === renamingId) { bar.append(renameInput(b)); continue; }
      const chip = el('button', 'bm-chip');
      chip.type = 'button';
      chip.title = `${b.title}\n${b.url}`;
      chip.dataset.id = b.id;
      chip.append(el('span', 'bm-glyph', hostInitial(b.url)), el('span', 'bm-title', b.title || displayUrl(b.url)));
      bar.append(chip);
    }
  }

  function renameInput(b: Bookmark) {
    const input = el('input', 'bm-rename');
    input.value = b.title;
    input.setAttribute('aria-label', 'Bookmark name');
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      renamingId = null;
      const title = input.value.trim();
      if (save && title && title !== b.title) {
        b.title = title;
        renderBar();
        try { await api('api/bookmarks', { method: 'PUT', json: { id: b.id, title } }); }
        catch (err) { console.warn('[browser] rename', err); loadBookmarks(); }
      } else renderBar();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    queueMicrotask(() => { input.focus(); input.select(); });
    return input;
  }

  bar.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.bm-chip');
    const b = chip && bookmarks.find((x) => x.id === chip.dataset.id);
    if (b) host.navigate(b.url);
  });

  // Right-click (long-press on touch) → Rename / Delete.
  let menuFor: Bookmark | null = null;
  function closeBmMenu() {
    if (bmMenu.hidden) return;
    bmMenu.hidden = true;
    bar.querySelector('[aria-expanded="true"]')?.removeAttribute('aria-expanded');
    menuFor = null;
    host.coverEngine('bookmarkMenu', false);
  }
  bar.addEventListener('contextmenu', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.bm-chip');
    const b = chip && bookmarks.find((x) => x.id === chip.dataset.id);
    if (!chip || !b) return;
    e.preventDefault();
    closeBmMenu();
    menuFor = b;
    chip.setAttribute('aria-expanded', 'true');
    bmMenu.hidden = false;
    const w = bmMenu.offsetWidth;
    bmMenu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - w - 4)) + 'px';
    bmMenu.style.top = (chip.getBoundingClientRect().bottom + 4) + 'px';
    host.coverEngine('bookmarkMenu', true);
  });
  bmMenu.addEventListener('click', async (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-bm-action]')?.dataset.bmAction;
    const b = menuFor;
    closeBmMenu();
    if (!b || !action) return;
    if (action === 'rename') { renamingId = b.id; renderBar(); return; }
    bookmarks = bookmarks.filter((x) => x !== b);
    renderBar(); updateStar();
    try { await api(`api/bookmarks?id=${encodeURIComponent(b.id)}`, { method: 'DELETE' }); }
    catch (err) { console.warn('[browser] delete bookmark', err); loadBookmarks(); }
  });
  document.addEventListener('click', (e) => { if (!bmMenu.contains(e.target as Node)) closeBmMenu(); });
  window.addEventListener('blur', closeBmMenu);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBmMenu();
    if (e.ctrlKey && !e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); toggleBookmark(); }
    if (e.ctrlKey && e.shiftKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); setBarWanted(!barWanted); }
  });

  onUrl(host.currentUrl(), host.currentTitle());
  loadBookmarks();
  loadHistory();
}

// ---- engine policy and notice ----------------------------------------------

const VIEW_ACTION = 'aura.intent.action.VIEW';

function initEngine(host: Host) {
  const notice = document.getElementById('engine-notice')!;
  const text = document.getElementById('engine-notice-text')!;
  const appBtn = document.getElementById('engine-notice-app') as HTMLButtonElement;
  const launcherBtn = document.getElementById('engine-notice-launcher') as HTMLButtonElement;
  const external = document.getElementById('engine-notice-external') as HTMLAnchorElement;
  const closeBtn = document.getElementById('engine-notice-close')!;
  const menuExternal = document.getElementById('menu-external-btn') as HTMLAnchorElement;
  const toolExternal = document.getElementById('external-btn') as HTMLAnchorElement;

  // Without the runtime (opened outside AuraOS) the page knows its own origin only.
  const ctx: EngineContext = { selfOrigin: window.location.origin, shellOrigin: appHostRuntime()?.shellOrigin ?? null };
  const classify = (url: string) => classifyEngineUrl(url, ctx);

  let appUrl = '';
  let shownKind = '';
  function show(message: string, opts: { app?: string; launcher?: boolean; external?: string } = {}, kind = '') {
    shownKind = kind;
    text.textContent = message;
    appUrl = opts.app ?? '';
    appBtn.hidden = !opts.app;
    launcherBtn.hidden = !opts.launcher;
    external.hidden = !opts.external;
    if (opts.external) external.href = opts.external;
    else external.removeAttribute('href');
    notice.hidden = false;
    host.coverEngine('notice', true);
  }
  function hide() {
    if (notice.hidden) return;
    notice.hidden = true;
    host.coverEngine('notice', false);
  }
  closeBtn.addEventListener('click', hide);
  external.addEventListener('click', hide);
  launcherBtn.addEventListener('click', () => { hide(); postToShell({ type: 'aura.system.openLauncher' }); });

  // Another Aura app opens as its own Activity: a VIEW intent for its App Host
  // address, which the OS resolves to that app (never to the Browser).
  let opening = false;
  async function openApp(url: string) {
    if (opening) return;
    opening = true;
    appBtn.disabled = true;
    show('Opening this AuraOS app in its own window…');
    try {
      const r = await new OsClient().startIntent({
        action: VIEW_ACTION, uri: url, category: ['aura.intent.category.DEFAULT'],
      });
      if (r.kind === 'started' && r.appId !== 'com.aura.browser') {
        show('This AuraOS app opened in its own window.');
      } else if (r.kind === 'rejected') {
        show(`The app refused to open: ${r.message}`, { app: url, launcher: true });
      } else {
        show('No AuraOS app answers at this address. Open the app from the launcher.', { launcher: true });
      }
    } catch (err) {
      const why = err instanceof Error ? err.message.replace(/^startIntent: /, '') : String(err);
      show(`AuraOS did not open this app (${why}). Open it from the launcher.`, { app: url, launcher: true });
    } finally {
      opening = false;
      appBtn.disabled = false;
    }
  }
  appBtn.addEventListener('click', () => { if (appUrl) void openApp(appUrl); });

  host.onNotice((n) => {
    switch (n.kind) {
      case 'loaded':
        if (shownKind === 'slow') hide();
        return;
      case 'app':
        // Only what the user asked for opens by itself. An address that
        // arrived any other way (a VIEW intent, a link) waits for a click.
        if (n.user) void openApp(n.url);
        else show('This is an AuraOS app. It opens in its own window, not in here.', { app: n.url });
        return;
      case 'self':
        show('This is Aura Browser\'s own address. It does not open inside itself.');
        return;
      case 'shell':
        show('This is the AuraOS desktop\'s own address. It does not open inside Aura Browser.');
        return;
      case 'refused':
        show('Aura Browser opens http and https addresses only.');
        return;
      case 'reset':
        show('A page tried to load an AuraOS address inside Aura Browser, so it was stopped.');
        return;
      case 'slow':
      case 'needs-top-level':
      case 'external':
        show(n.kind === 'slow'
          ? 'This page is slow to load, or refuses to be shown inside another page.'
          : 'This page needs its own browser tab.', { external: n.url }, n.kind);
        return;
    }
  });

  // "Open in external browser" (↗ and the ⚙ menu) always follows the current page.
  host.onUrlChange((url) => {
    hide();
    const ok = classify(url).kind === 'external';
    for (const a of [menuExternal, toolExternal]) {
      if (ok) a.href = url; else a.removeAttribute('href');
      a.setAttribute('aria-disabled', String(!ok));
    }
  });
  menuExternal.addEventListener('click', () => host.closeSettingsMenu());

  // "Open site in external browser": in AuraOS the Shell opens the tab, so it
  // has no opener and none of this window's App Host sandbox, which a link
  // here would pass on to it. Outside AuraOS the link opens it itself.
  const os = new OsClient();
  for (const a of [external, menuExternal, toolExternal]) {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      if (!href || !appHostRuntime() || window.top === window) return;
      e.preventDefault();
      os.system.openExternal(href);
    });
  }

  host.usePolicy({ classify, sandboxFor, readableLoadAllowed, blankSandbox: BLANK_SANDBOX });
}

const host = (window as unknown as { __browser?: Host }).__browser;
if (host) { initEngine(host); init(host); }
else console.warn('[browser] page hook missing; address bar extras disabled');
