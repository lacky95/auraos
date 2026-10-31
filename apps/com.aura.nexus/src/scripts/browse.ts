/**
 * Instant search, filters, sort and grid/list view for a store list — runs in
 * the browser on the server-rendered cards, so nothing is re-fetched.
 *
 * Markup contract (Browse + Installed pages):
 *   [data-browse]                       root, data-key = localStorage namespace
 *     input[data-q]                     search box ("/" focuses it)
 *     [data-chips=<group>] button[data-chip=<facet|''>]   one active per group
 *     select[data-filter]               value = a facet ('' = all)
 *     select[data-sort]                 default | name | source
 *     button[data-view=grid|list]
 *     [data-list]                       holds the [data-card]s
 *     [data-count]  [data-noresults] (with button[data-reset])
 *     [data-hide-when-filtered]         e.g. Featured
 *   [data-card]  data-facets="installed update src:x cat:y" data-search data-name data-source data-index
 *
 * State lives in the URL (?q=&status=&cat=&src=&sort=&view=) so Back and
 * links restore it; view + sort are also remembered per list.
 */
import { navigate } from 'astro:transitions/client';

interface Filters { q: string; chips: Record<string, string>; selects: Record<string, string>; sort: string; view: string }

let abort: AbortController | null = null;

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private mode / blocked storage */ }
  return null;
}

function init(): void {
  abort?.abort();
  const root = document.querySelector<HTMLElement>('[data-browse]');
  if (!root) return;
  abort = new AbortController();
  const { signal } = abort;
  const key = `nexus.${root.dataset.key ?? 'browse'}`;
  const list = root.querySelector<HTMLElement>('[data-list]')!;
  const q = root.querySelector<HTMLInputElement>('[data-q]');
  const sortSel = root.querySelector<HTMLSelectElement>('[data-sort]');
  const groups = [...root.querySelectorAll<HTMLElement>('[data-chips]')];
  const selects = [...root.querySelectorAll<HTMLSelectElement>('select[data-filter]')];
  const url = new URL(location.href);

  // ── Initial state: URL first, then what this list remembered. ──
  const f: Filters = {
    q: url.searchParams.get('q') ?? '',
    chips: Object.fromEntries(groups.map((g) => [g.dataset.chips!, url.searchParams.get(g.dataset.chips!) ?? ''])),
    selects: Object.fromEntries(selects.map((s) => [s.dataset.filter!, url.searchParams.get(s.dataset.filter!) ?? ''])),
    sort: url.searchParams.get('sort') ?? store(`${key}.sort`) ?? 'default',
    view: url.searchParams.get('view') ?? store(`${key}.view`) ?? (root.dataset.defaultView || 'grid'),
  };
  // Older links: /?category=x
  const legacyCat = url.searchParams.get('category');
  if (legacyCat && 'cat' in f.chips && !f.chips['cat']) f.chips['cat'] = `cat:${legacyCat}`;

  if (q) q.value = f.q;
  if (sortSel) sortSel.value = f.sort;
  for (const s of selects) s.value = f.selects[s.dataset.filter!] ?? '';

  const cards = () => [...list.querySelectorAll<HTMLElement>('[data-card]')];

  function apply(push = true): void {
    const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const want = [...Object.values(f.chips), ...Object.values(f.selects)].filter(Boolean);
    let shown = 0;
    for (const c of cards()) {
      const facets = new Set((c.dataset.facets ?? '').split(' '));
      const text = c.dataset.search ?? '';
      const ok = want.every((w) => facets.has(w)) && words.every((w) => text.includes(w));
      c.hidden = !ok;
      if (ok) shown++;
    }
    // Chip counts reflect the search + the OTHER groups' choices.
    for (const g of groups) {
      for (const chip of g.querySelectorAll<HTMLElement>('[data-chip]')) {
        chip.classList.toggle('active', chip.dataset.chip === (f.chips[g.dataset.chips!] ?? ''));
        chip.setAttribute('aria-pressed', String(chip.dataset.chip === (f.chips[g.dataset.chips!] ?? '')));
        const n = chip.querySelector<HTMLElement>('[data-chip-count]');
        if (!n) continue;
        const others = [
          ...Object.entries(f.chips).filter(([k]) => k !== g.dataset.chips).map(([, v]) => v),
          ...Object.values(f.selects),
        ].filter(Boolean);
        const tok = chip.dataset.chip!;
        const count = cards().filter((c) => {
          const facets = new Set((c.dataset.facets ?? '').split(' '));
          return (!tok || facets.has(tok)) && others.every((w) => facets.has(w))
            && words.every((w) => (c.dataset.search ?? '').includes(w));
        }).length;
        n.textContent = String(count);
        chip.classList.toggle('is-empty', count === 0 && !!tok);
      }
    }
    root.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => { el.textContent = String(shown); });
    const filtered = words.length > 0 || want.length > 0;
    root.querySelectorAll<HTMLElement>('[data-noresults]').forEach((el) => { el.hidden = shown > 0; });
    document.querySelectorAll<HTMLElement>('[data-hide-when-filtered]').forEach((el) => { el.hidden = filtered; });
    root.querySelectorAll<HTMLElement>('[data-reset]').forEach((el) => { el.hidden = !filtered; });
    if (push) syncUrl();
  }

  function sort(): void {
    const by = f.sort;
    const sorted = cards().sort((a, b) => {
      if (by === 'name') return (a.dataset.name ?? '').localeCompare(b.dataset.name ?? '');
      if (by === 'source') return (a.dataset.source ?? '').localeCompare(b.dataset.source ?? '')
        || (a.dataset.name ?? '').localeCompare(b.dataset.name ?? '');
      return Number(a.dataset.index ?? 0) - Number(b.dataset.index ?? 0);
    });
    for (const c of sorted) list.append(c);
  }

  function view(v: string): void {
    f.view = v === 'list' ? 'list' : 'grid';
    list.classList.toggle('view-grid', f.view === 'grid');
    list.classList.toggle('view-list', f.view === 'list');
    root.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === f.view);
      b.setAttribute('aria-pressed', String(b.dataset.view === f.view));
    });
  }

  function syncUrl(): void {
    const u = new URL(location.href);
    u.searchParams.delete('category');
    u.searchParams.delete('refresh');
    const set = (k: string, v: string, dflt = '') => { if (v && v !== dflt) u.searchParams.set(k, v); else u.searchParams.delete(k); };
    set('q', f.q.trim());
    for (const [k, v] of Object.entries(f.chips)) set(k, v);
    for (const [k, v] of Object.entries(f.selects)) set(k, v);
    set('sort', f.sort, 'default');
    set('view', f.view, root.dataset.defaultView || 'grid');
    if (u.href !== location.href) history.replaceState(history.state, '', u.href);
  }

  // ── Events ──
  let t: ReturnType<typeof setTimeout> | undefined;
  q?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { f.q = q.value; apply(); }, 80);
  }, { signal });
  q?.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && q.value) { q.value = ''; f.q = ''; apply(); } }, { signal });
  for (const g of groups) {
    g.addEventListener('click', (ev) => {
      const chip = (ev.target as HTMLElement).closest<HTMLElement>('[data-chip]');
      if (!chip) return;
      const group = g.dataset.chips!;
      f.chips[group] = f.chips[group] === chip.dataset.chip ? '' : chip.dataset.chip!;
      apply();
    }, { signal });
  }
  for (const s of selects) s.addEventListener('change', () => { f.selects[s.dataset.filter!] = s.value; apply(); }, { signal });
  sortSel?.addEventListener('change', () => { f.sort = sortSel.value; store(`${key}.sort`, f.sort); sort(); syncUrl(); }, { signal });
  root.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.addEventListener('click', () => {
    view(b.dataset.view!); store(`${key}.view`, f.view); syncUrl();
  }, { signal }));
  root.querySelectorAll<HTMLElement>('[data-reset]').forEach((b) => b.addEventListener('click', () => {
    f.q = ''; if (q) q.value = '';
    for (const k of Object.keys(f.chips)) f.chips[k] = '';
    for (const s of selects) { s.value = ''; f.selects[s.dataset.filter!] = ''; }
    apply(); q?.focus();
  }, { signal }));
  // Refresh re-fetches every source but keeps what the user is looking at.
  root.querySelectorAll<HTMLAnchorElement>('[data-refresh]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    const u = new URL(location.href);
    u.searchParams.set('refresh', '1');
    void navigate(u.href);
  }, { signal }));
  // A card's install state changed (store.ts re-tags facets): re-filter.
  document.addEventListener('nexus:facets', () => apply(false), { signal });
  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (ev.key === '/' && q && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') { ev.preventDefault(); q.focus(); q.select(); }
  }, { signal });

  view(f.view);
  sort();
  apply();
  root.classList.add('is-ready');
}

document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', () => abort?.abort());
