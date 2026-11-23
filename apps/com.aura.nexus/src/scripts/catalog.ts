/**
 * Loads the Browse content without blocking the page: the first load behind
 * skeleton cards, a refresh in place with the current apps still usable.
 * Fetches /partials/browse, swaps it in, then fires `nexus:catalog-swapped`
 * so browse.ts and store.ts wire the new cards.
 */
const SLOW_MS = 6000;
const IDLE_POLL_MS = 300;
const OPEN_UI = '.ic-menu:popover-open, .nxs-list:popover-open, .filter-sheet:popover-open, dialog[open]';

let current: AbortController | null = null;

/** Replacing the cards mid-install or under an open menu would lose it. */
async function whenIdle(signal: AbortSignal): Promise<void> {
  while (!signal.aborted && document.querySelector('[data-ic][data-busy="1"], ' + OPEN_UI)) {
    await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
  }
}

function swap(content: HTMLElement, html: string): void {
  const active = document.activeElement as HTMLInputElement | null;
  const typing = active?.matches('[data-q]') ? { value: active.value, at: active.selectionStart } : null;
  content.innerHTML = html;
  document.dispatchEvent(new CustomEvent('nexus:catalog-swapped'));
  if (!typing) return;
  const q = content.querySelector<HTMLInputElement>('[data-q]');
  if (!q) return;
  q.value = typing.value;
  q.focus();
  q.setSelectionRange(typing.at, typing.at);
  q.dispatchEvent(new Event('input', { bubbles: true }));
}

async function load(force: boolean): Promise<void> {
  const root = document.querySelector<HTMLElement>('[data-catalog]');
  if (!root) return;
  const content = root.querySelector<HTMLElement>('[data-catalog-content]')!;
  const status = root.querySelector<HTMLElement>('[data-catalog-status]')!;
  const msg = root.querySelector<HTMLElement>('[data-catalog-msg]')!;
  const retry = root.querySelector<HTMLElement>('[data-catalog-retry]')!;
  const hasApps = !!content.querySelector('[data-browse]');

  current?.abort();
  const ctl = new AbortController();
  current = ctl;
  root.dataset.state = hasApps ? 'refreshing' : 'loading';
  root.dataset.force = force ? '1' : '';
  status.hidden = false;
  retry.hidden = true;
  msg.textContent = force ? 'Refreshing sources…' : 'Loading apps…';
  const slow = setTimeout(() => { msg.textContent = 'Still checking your sources, this can take up to a minute…'; }, SLOW_MS);

  try {
    const res = await fetch(`/partials/browse${force ? '?refresh=1' : ''}`, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    await whenIdle(ctl.signal);
    if (ctl.signal.aborted) return;
    swap(content, html);
    root.dataset.state = 'ready';
    status.hidden = true;
  } catch {
    if (ctl.signal.aborted) return;
    root.dataset.state = hasApps ? 'ready' : 'error';
    msg.textContent = hasApps ? 'Refresh failed, showing the last known apps.' : 'Could not load the store.';
    retry.hidden = false;
  } finally {
    clearTimeout(slow);
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-catalog]');
  if (!root) return;
  if (root.dataset.refreshOnLoad) {
    delete root.dataset.refreshOnLoad;
    void load(true);
  } else if (root.dataset.state === 'loading') {
    void load(false);
  }
}

// Capture: must run before ClientRouter turns the link into a navigation.
document.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement | null;
  const root = t?.closest<HTMLElement>('[data-catalog]');
  if (!root) return;
  const refresh = t!.closest<HTMLElement>('[data-refresh]');
  if (refresh) {
    ev.preventDefault();
    refresh.closest<HTMLElement>('[popover]')?.hidePopover();
    void load(true);
  } else if (t!.closest('[data-catalog-retry]')) {
    void load(root.dataset.force === '1');
  }
}, true);
document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', () => { current?.abort(); current = null; });
