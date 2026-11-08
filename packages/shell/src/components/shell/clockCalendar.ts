/**
 * clockCalendar — tap / click the top-bar clock for a small month calendar
 * dropping down under it.
 *
 * Plain DOM (no framework, no Radix): the clock becomes a button, the panel is
 * <button>s in a grid, so mouse, finger, Apple Pencil and keyboard all work.
 * "Today" and the week layout follow the clock's own prefs on #clock
 * (data-locale, data-time-zone — the same ones the clock ticks with).
 *
 *   ‹ / ›          previous / next month      TODAY   back to this month
 *   Esc · outside tap · clock again           close
 *
 * While it is open the auto-hidden top bar stays up (auraPinBar); if the bar
 * hides anyway (the edge badge's peek ran out), the calendar closes with it.
 */

const PANEL_ID = 'clock-calendar';
const PIN_KEY = 'clock-calendar';

interface Ymd { y: number; m: number; d: number } // m: 0–11

function clockPrefs(clock: HTMLElement): { locale?: string; timeZone?: string } {
  return {
    locale: clock.dataset['locale'] || 'en-GB', // the clock's own fallback (StatusBar readClockPrefs)
    timeZone: clock.dataset['timeZone'] || undefined,
  };
}

/** Today's date in the clock's time zone (falls back to the device zone). */
function today(timeZone?: string): Ymd {
  const parts = (tz?: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
  let p: Intl.DateTimeFormatPart[];
  try { p = parts(timeZone); } catch { p = parts(undefined); }
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get('year'), m: get('month') - 1, d: get('day') };
}

/** First day of the week for the locale: 1 = Monday … 7 = Sunday (Intl weekInfo, else Monday; Sunday for US-like regions). */
function firstDayOfWeek(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay;
    if (['US', 'CA', 'JP', 'BR', 'IL', 'MX', 'PH'].includes(loc.maximize().region ?? '')) return 7;
  } catch {}
  return 1;
}

/** ISO-8601 week number. */
function isoWeek(y: number, m: number, d: number): number {
  const t = new Date(Date.UTC(y, m, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

const STYLE = `
#${PANEL_ID} {
  position: fixed; z-index: 1040; width: 252px; padding: 10px 10px 8px;
  background: var(--aura-color-surface); color: var(--aura-color-text);
  border: 1px solid var(--aura-color-primary); box-shadow: 0 10px 28px rgba(0,0,0,0.5);
  font-family: var(--aura-font-mono); font-size: 0.68rem; user-select: none;
}
#${PANEL_ID} .cc-head { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
#${PANEL_ID} .cc-title { flex: 1; text-align: center; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--aura-color-primary); }
#${PANEL_ID} button { appearance: none; font: inherit; color: inherit; background: transparent; border: 1px solid transparent; cursor: pointer; outline: none; }
#${PANEL_ID} button:focus-visible { border-color: var(--aura-color-primary); }
#${PANEL_ID} .cc-nav { width: 26px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-color: var(--aura-color-border); }
#${PANEL_ID} .cc-nav:hover, #${PANEL_ID} .cc-today:hover { color: var(--aura-color-primary); border-color: var(--aura-color-primary); }
#${PANEL_ID} .cc-today { height: 24px; padding: 0 8px; border-color: var(--aura-color-border); font-size: 0.6rem; letter-spacing: 0.12em; }
#${PANEL_ID} .cc-grid { display: grid; grid-template-columns: 22px repeat(7, 1fr); gap: 1px; }
#${PANEL_ID} .cc-wd, #${PANEL_ID} .cc-wk { display: flex; align-items: center; justify-content: center; height: 22px; font-size: 0.56rem; letter-spacing: 0.06em; color: var(--aura-color-text-dim); text-transform: uppercase; }
#${PANEL_ID} .cc-wk { color: color-mix(in srgb, var(--aura-color-text-dim) 70%, transparent); }
#${PANEL_ID} .cc-day { height: 26px; display: flex; align-items: center; justify-content: center; }
#${PANEL_ID} .cc-day[data-out] { color: color-mix(in srgb, var(--aura-color-text) 35%, transparent); }
#${PANEL_ID} .cc-day[data-weekend]:not([data-out]) { color: color-mix(in srgb, var(--aura-color-text) 70%, var(--aura-color-primary)); }
#${PANEL_ID} .cc-day[data-today] { background: var(--aura-color-primary); color: var(--aura-color-bg); font-weight: 700; }
#${PANEL_ID} .cc-foot { margin-top: 8px; padding-top: 7px; border-top: 1px solid var(--aura-color-border); color: var(--aura-color-text-dim); font-size: 0.6rem; line-height: 1.4; }
#${PANEL_ID} .cc-foot b { color: var(--aura-color-text); font-weight: 600; }
.clock[data-calendar] { cursor: pointer; }
.clock[aria-expanded="true"] { color: var(--aura-color-primary); }
`;

const CHEVRON = (d: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

export function installClockCalendar(): void {
  const clock = document.getElementById('clock');
  if (!clock || clock.dataset['calendar'] === 'on') return;
  clock.dataset['calendar'] = 'on';
  clock.setAttribute('role', 'button');
  clock.setAttribute('tabindex', '0');
  clock.setAttribute('aria-haspopup', 'dialog');
  clock.setAttribute('aria-expanded', 'false');
  clock.setAttribute('aria-controls', PANEL_ID);
  clock.title = 'Calendar';
  if (!document.getElementById(`${PANEL_ID}-style`)) {
    const st = document.createElement('style');
    st.id = `${PANEL_ID}-style`;
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  let panel: HTMLDivElement | null = null;
  let view: { y: number; m: number } = { y: 0, m: 0 };
  let barWatch: MutationObserver | null = null;
  const pin = (on: boolean) =>
    (window as unknown as { auraPinBar?: (w: 'top' | 'bottom', k: string, p: boolean) => void }).auraPinBar?.('top', PIN_KEY, on);

  function render(): void {
    if (!panel) return;
    const { locale, timeZone } = clockPrefs(clock!);
    const now = today(timeZone);
    const first = firstDayOfWeek(locale); // 1..7
    const fmtMonth = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const fmtWd = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    const fmtLong = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const fmtDay = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

    // Grid start: the week day `first` on or before the 1st of the month.
    const firstOfMonth = new Date(Date.UTC(view.y, view.m, 1));
    const wd = firstOfMonth.getUTCDay() || 7; // 1..7, Monday = 1
    const lead = (wd - first + 7) % 7;
    const start = new Date(Date.UTC(view.y, view.m, 1 - lead));

    let html = `<div class="cc-head">
      <button type="button" class="cc-nav" data-cc="prev" aria-label="Previous month">${CHEVRON('m15 18-6-6 6-6')}</button>
      <div class="cc-title" aria-live="polite">${fmtMonth.format(firstOfMonth)}</div>
      <button type="button" class="cc-nav" data-cc="next" aria-label="Next month">${CHEVRON('m9 18 6-6-6-6')}</button>
      <button type="button" class="cc-today" data-cc="today" title="Back to this month">TODAY</button>
    </div><div class="cc-grid" role="grid" aria-label="${fmtMonth.format(firstOfMonth)}">`;
    html += `<div class="cc-wk" title="Week">#</div>`;
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(2024, 0, 1 + ((first - 1 + i) % 7))); // 2024-01-01 is a Monday
      html += `<div class="cc-wd">${fmtWd.format(d).replace(/\.$/, '')}</div>`;
    }
    for (let w = 0; w < 6; w++) {
      const rowStart = new Date(start.getTime() + w * 7 * 86_400_000);
      // ISO week of the row's Thursday-ish middle (the Monday-based week it mostly covers).
      const mid = new Date(rowStart.getTime() + 3 * 86_400_000);
      html += `<div class="cc-wk">${isoWeek(mid.getUTCFullYear(), mid.getUTCMonth(), mid.getUTCDate())}</div>`;
      for (let i = 0; i < 7; i++) {
        const day = new Date(rowStart.getTime() + i * 86_400_000);
        const y = day.getUTCFullYear(), m = day.getUTCMonth(), d = day.getUTCDate();
        const out = m !== view.m;
        const isToday = y === now.y && m === now.m && d === now.d;
        const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
        html += `<div class="cc-day" role="gridcell"${out ? ' data-out' : ''}${isToday ? ' data-today aria-current="date"' : ''}${weekend ? ' data-weekend' : ''} aria-label="${fmtDay.format(day)}">${d}</div>`;
      }
    }
    const todayDate = new Date(Date.UTC(now.y, now.m, now.d));
    html += `</div><div class="cc-foot"><b>${fmtLong.format(todayDate)}</b><br>Week ${isoWeek(now.y, now.m, now.d)}${timeZone ? ` · ${timeZone}` : ''}</div>`;
    panel.innerHTML = html;
    place();
  }

  // Under the clock, centred and clamped to the screen, in <body>'s own
  // (unscaled) coordinates — a viewport profile may scale and offset <body>.
  function place(): void {
    if (!panel) return;
    const body = document.body.getBoundingClientRect();
    const scale = body.width / Math.max(1, document.body.offsetWidth) || 1;
    const r = clock!.getBoundingClientRect();
    const w = panel.offsetWidth;
    const centre = (r.left + r.width / 2 - body.left) / scale;
    const left = Math.min(Math.max(8, centre - w / 2), document.body.offsetWidth - w - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${(r.bottom - body.top) / scale + 4}px`;
  }

  function open(): void {
    if (panel) return;
    const { timeZone } = clockPrefs(clock!);
    const t = today(timeZone);
    view = { y: t.y, m: t.m };
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Calendar');
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('keydown', onPanelKey);
    document.body.appendChild(panel);
    clock!.setAttribute('aria-expanded', 'true');
    pin(true);
    render();
    document.addEventListener('pointerdown', onAway, true);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', place);
    // Taps inside an app window (iframe) never reach this document: the shell's
    // injected focus script relays them as `aura.pointerdown`. (Not `blur` — the
    // shell hands focus back to the active app right after a tap on the bar.)
    window.addEventListener('message', onAppPointer);
    // The top bar hid anyway (badge peek ended): close with it.
    barWatch = new MutationObserver(() => {
      if (document.body.dataset['autohideBars'] === 'on' && document.body.dataset['showTop'] === 'false') close(false);
    });
    barWatch.observe(document.body, { attributes: true, attributeFilter: ['data-show-top', 'data-autohide-bars'] });
  }

  function close(refocus: boolean): void {
    if (!panel) return;
    panel.remove();
    panel = null;
    clock!.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onAway, true);
    document.removeEventListener('keydown', onEsc);
    window.removeEventListener('resize', place);
    window.removeEventListener('message', onAppPointer);
    barWatch?.disconnect();
    barWatch = null;
    pin(false);
    if (refocus) clock!.focus();
  }

  function shift(months: number): void {
    const d = new Date(Date.UTC(view.y, view.m + months, 1));
    view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    render();
  }

  function onPanelClick(e: MouseEvent): void {
    const action = (e.target as Element | null)?.closest<HTMLElement>('[data-cc]')?.dataset['cc'];
    if (action === 'prev') shift(-1);
    else if (action === 'next') shift(1);
    else if (action === 'today') {
      const t = today(clockPrefs(clock!).timeZone);
      view = { y: t.y, m: t.m };
      render();
    }
  }
  function onPanelKey(e: KeyboardEvent): void {
    if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && e.altKey)) { e.preventDefault(); shift(-1); }
    if (e.key === 'PageDown' || (e.key === 'ArrowRight' && e.altKey)) { e.preventDefault(); shift(1); }
  }
  function onAway(e: PointerEvent): void {
    const t = e.target as Node | null;
    if (t instanceof Node && (panel?.contains(t) || clock!.contains(t))) return;
    close(false);
  }
  function onAppPointer(e: MessageEvent): void {
    if ((e.data as { type?: string } | null)?.type === 'aura.pointerdown') close(false);
  }
  function onEsc(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); close(true); }
  }

  clock.addEventListener('click', () => (panel ? close(false) : open()));
  clock.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); panel ? close(true) : open(); }
  });
}
