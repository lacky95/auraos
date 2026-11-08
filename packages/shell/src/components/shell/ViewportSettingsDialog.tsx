/**
 * ViewportSettingsDialog — the ⚙ panel that manages VIEWPORT PROFILES.
 *
 * A profile is a named bundle of viewport settings (three zoom factors +
 * screen-edge margins + a light/dark theme pick) persisted in device
 * localStorage. The user keeps e.g. a "TV" and a "Mobile" profile and switches
 * between them in one click. By default there is exactly one profile
 * ("Default").
 *
 * All viewport state flows through lib/viewportClient (the single source of
 * truth + localStorage persistence + cross-tab `storage` sync). This
 * component is a pure UI layer over it.
 *
 * Layout is two-pane. A VERTICAL RAIL on the left selects the SETTINGS TOPIC —
 * "Profiles", "Menu Bars" or "⚙ Global". Under Profiles the right pane leads with a
 * HORIZONTAL tab bar of the individual profiles (selecting one switches the
 * live active profile) above that profile's settings (VIEWPORT/zoom first, then
 * margins, then theme). Under Global the right pane shows the NON-profile
 * settings.
 *
 * Non-profile / device-wide settings are deliberately separated under Global:
 * color mode (os/theme KV), fullscreen (the Fullscreen API) and the dev-only
 * auto-reload toggle (top-level ViewportState). They are NOT part of a profile.
 *
 * Menu Bars holds the device's auto-hide habits for the top bar and the Dock
 * (lib/barsPrefs, applied by StatusBar's auto-hide script): the auto-hide
 * switch, which bar stays shown anyway, delays, the edge strip and the badge.
 *
 * The dialog opens on the `aura.viewport.open` CustomEvent the StatusBar
 * dispatches when the user clicks the gear button.
 *
 * Everything is plain HTML — no Radix primitives: the frame, buttons and
 * checkbox come from ./nativeDialog (shared with AboutDialog), tabs are
 * <button>s, radio and dropdown are drawn in the page (Segmented, Dropdown
 * below) — no OS widget or OS picker popup.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { BTN_SHAPE, BTN_TONE, Btn, CheckBox, NativeDialog } from './nativeDialog';
import * as viewportClient from '../../lib/viewportClient';
import {
  type ViewportProfile,
  type ViewportMargins,
  type ViewportState,
  ZOOM_MIN,
  ZOOM_MAX,
  MARGIN_MAX,
  defaultProfile,
} from '../../lib/viewport';
// Narrow subpath, not the '@aura/core' barrel — this is a client:load island,
// so a barrel import would bundle the Node-only app-manager into the browser
// and crash the dialog. See the same note in lib/viewport.ts.
import { ThemeManager } from '@aura/core/theme';
import { onOpenRequest } from '../../lib/openRequest';
import {
  type BarsPrefs,
  BARS_PREFS_DEFAULTS,
  AUTOHIDE_EVENT,
  loadBarsPrefs,
  saveBarsPrefs,
  onBarsPrefs,
} from '../../lib/barsPrefs';

type ColorMode = 'light' | 'dark' | 'auto';

const ZOOM_STEP = 0.05;
const MARGIN_STEP = 2;

// Native tab buttons. Vertical rail (left border marks the active topic) and
// the horizontal profile row (bottom border marks the active profile).
const RAIL_LIST = 'flex flex-col items-stretch w-40 shrink-0 py-1 border-r border-[var(--border)] overflow-y-auto min-h-0';
const RAIL_TAB =
  'flex items-center gap-2 w-full text-left px-3 py-2 border-l-2 border-transparent cursor-pointer ' +
  'font-mono text-[0.7rem] tracking-wider uppercase text-[var(--text-muted)] hover:text-[var(--text-secondary)] ' +
  'aria-selected:border-l-[var(--color-green)] aria-selected:bg-[var(--surface-raised)] aria-selected:text-[var(--color-green)] ' +
  'outline-none focus-visible:bg-[var(--surface-raised)]';
const ROW_TAB =
  'inline-flex items-center px-4 py-2 -mb-px border-b-2 border-transparent cursor-pointer ' +
  'font-mono text-[0.7rem] font-medium uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--text-secondary)] ' +
  'aria-selected:text-[var(--color-green)] aria-selected:border-b-[var(--color-green)] outline-none focus-visible:text-[var(--text-secondary)]';
const RIGHT_PANE = 'flex-1 min-w-0 px-4 py-3 space-y-5 overflow-y-auto min-h-0';

type Section = 'global' | 'profiles' | 'bars';

// MENU BARS choices. A stored value outside the list (set elsewhere) still shows as its own option.
const BAR_MODE = [
  { value: 'auto', label: 'Auto-hide' },
  { value: 'keep', label: 'Always shown' },
];
const HIDE_DELAYS  = [500, 1000, 1800, 3000, 5000, 10_000, 30_000];
const REVEAL_DELAYS = [0, 150, 300, 500, 1000];
const PEEK_TIMES   = [3000, 6000, 10_000, 20_000, 30_000, 60_000];
const HOT_ZONES    = [4, 8, 12, 20, 32];
const secs = (ms: number) => (ms === 0 ? 'Instantly' : `${ms / 1000} s`);
const withDefault = (label: string, isDefault: boolean) => (isDefault ? `${label} (default)` : label);

// ── Controls drawn in the page ───────────────────────────────────────────
// Checkbox, radio and dropdown are plain elements styled here — no OS-drawn
// widget, no OS picker popup. They look the same on every device, follow the
// viewport zoom, and work with mouse, finger, pencil and keyboard.

/** Layer inside the dialog panel that open dropdown lists render into (the
 *  scrolling right pane would clip them). */
const ListLayer = React.createContext<React.RefObject<HTMLDivElement | null> | null>(null);

const CheckMark = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
  </svg>
);

/** Drawn radio group as a segmented row. */
function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={
              'group flex items-center gap-1.5 border px-2.5 py-1 cursor-pointer bg-transparent outline-none font-mono text-[0.65rem] tracking-widest uppercase ' +
              'focus-visible:shadow-[var(--glow-green)] ' +
              (on
                ? 'border-[var(--color-green)] text-[var(--color-green)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--color-green)]')
            }
          >
            <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current">
              {on && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Drawn dropdown (button + listbox). Keyboard: Enter / Space / ↓ open, ↑ ↓ Home End move, Enter picks, Esc closes. */
function Dropdown({ value, options, onChange, ariaLabel }: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  ariaLabel: string;
}): React.JSX.Element {
  const layer = React.useContext(ListLayer);
  const btn = React.useRef<HTMLButtonElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [pos, setPos] = React.useState<React.CSSProperties | null>(null);
  const uid = React.useId();
  const current = options.find((o) => o.value === value);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    close(true);
    if (o && o.value !== value) onChange(o.value);
  };
  const openList = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setPos(null);
    setOpen(true);
  };

  // Place under the button (above when there's no room), in the panel's own
  // (unscaled) coordinates: the viewport zoom scales the whole panel.
  React.useLayoutEffect(() => {
    if (!open) return;
    const host = layer?.current;
    const b = btn.current;
    if (!host || !b) return;
    const hr = host.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const scale = hr.width / Math.max(1, host.offsetWidth) || 1;
    const left = (br.left - hr.left) / scale;
    const width = br.width / scale;
    const below = (br.bottom - hr.top) / scale + 2;
    const above = (br.top - hr.top) / scale - 2;
    const h = list.current?.offsetHeight ?? 0;
    const room = host.offsetHeight - below - 8;
    setPos(h > room && above > room
      ? { left, minWidth: width, bottom: host.offsetHeight - above, maxHeight: above - 8 }
      : { left, minWidth: width, top: below, maxHeight: room });
  }, [open, layer]);
  // Focus the list once it is placed (it is hidden until then, and hidden elements can't take focus).
  React.useEffect(() => {
    if (open && pos) list.current?.focus({ preventScroll: true });
  }, [open, pos]);

  React.useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (!!list.current?.contains(t) || !!btn.current?.contains(t));
    const away = (e: PointerEvent) => { if (!inside(e.target)) close(false); };
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && list.current?.contains(e.target))) close(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // Keep the active option in view — scrolling the list only (scrollIntoView would
  // also scroll the panes behind it, which closes the list).
  React.useEffect(() => {
    const l = list.current;
    const o = l?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!open || !l || !o) return;
    if (o.offsetTop < l.scrollTop) l.scrollTop = o.offsetTop;
    else if (o.offsetTop + o.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = o.offsetTop + o.offsetHeight - l.clientHeight;
  }, [open, active, pos]);

  const onListKey = (e: React.KeyboardEvent) => {
    const n = options.length;
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((a) => Math.min(n - 1, a + 1)),
      ArrowUp: () => setActive((a) => Math.max(0, a - 1)),
      Home: () => setActive(0),
      End: () => setActive(n - 1),
      Enter: () => pick(active),
      ' ': () => pick(active),
      Escape: () => close(true),
      Tab: () => close(false),
    };
    const run = keys[e.key];
    if (!run) return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopPropagation(); // Esc closes the list, not the dialog
    run();
  };

  const listbox = open && layer?.current
    ? createPortal(
        <div
          ref={list}
          id={`${uid}-list`}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          aria-activedescendant={`${uid}-opt-${active}`}
          onKeyDown={onListKey}
          data-role="dropdown-list"
          className="pointer-events-auto absolute z-10 overflow-y-auto py-1 border border-[var(--color-green)] bg-[var(--surface-raised)] shadow-[0_8px_24px_rgba(0,0,0,0.45)] outline-none"
          style={pos ?? { visibility: 'hidden', top: 0, left: 0 }}
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <div
                key={o.value}
                id={`${uid}-opt-${i}`}
                role="option"
                aria-selected={selected}
                data-index={i}
                onPointerMove={(e) => e.pointerType === 'mouse' && setActive(i)}
                onClick={() => pick(i)}
                className={
                  'flex items-center justify-between gap-3 px-2.5 py-1.5 cursor-pointer font-mono text-[0.7rem] tracking-wider whitespace-nowrap ' +
                  (i === active ? 'bg-[var(--surface)] shadow-[inset_2px_0_0_var(--color-green)] ' : '') +
                  (selected ? 'text-[var(--color-green)]' : 'text-[var(--text-primary)]')
                }
              >
                {o.label}
                <span aria-hidden="true" className={selected ? '' : 'invisible'}><CheckMark /></span>
              </div>
            );
          })}
        </div>,
        layer.current,
      )
    : null;

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${uid}-list` : undefined}
        aria-label={`${ariaLabel}: ${current?.label ?? value}`}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openList(); }
        }}
        data-role="dropdown"
        className={
          'inline-flex items-center justify-between gap-3 min-w-[12rem] px-2 py-1 cursor-pointer border bg-[var(--surface)] outline-none ' +
          'font-mono text-[0.7rem] tracking-wider text-[var(--text-primary)] text-left ' +
          'hover:border-[var(--border-active,var(--color-green))] focus-visible:border-[var(--color-green)] ' +
          (open ? 'border-[var(--color-green)]' : 'border-[var(--border)]')
        }
      >
        <span className="truncate">{current?.label ?? value}</span>
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      {listbox}
    </>
  );
}

// Lucide minus / plus / rotate-ccw, inline (rotate-ccw isn't in the curated OS sprite).
const ICON_PATHS = {
  minus: ['M5 12h14'],
  plus: ['M5 12h14', 'M12 5v14'],
  reset: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
} as const;
function LineIcon({ name }: { name: keyof typeof ICON_PATHS }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {ICON_PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
/** Square icon-only button (outline look). */
function IconBtn({ icon, label, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: keyof typeof ICON_PATHS; label: string }): React.JSX.Element {
  return (
    <button type="button" aria-label={label} title={label} className={`${BTN_SHAPE} w-7 shrink-0 ${BTN_TONE.outline}`} {...rest}>
      <LineIcon name={icon} />
    </button>
  );
}

/** Slider row: label · range · value · − + reset (icon buttons, one step each way). */
function SliderRow({ label, value, min, max, step, defaultValue, format, onChange, labelClass = 'w-20' }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  labelClass?: string;
}): React.JSX.Element {
  // Snap to the step grid (no 1.0500000001 from float steps), clamped to the range.
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v / step) * step)));
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return (
    <div className="flex items-center gap-3">
      <span className={`text-[0.7rem] tracking-wider text-[var(--text-secondary)] ${labelClass}`}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 min-w-0 accent-[var(--color-green)]"
      />
      <span className="font-mono text-[0.7rem] text-[var(--color-green)] min-w-[5ch] text-right">{format(value)}</span>
      <div className="flex shrink-0 items-center gap-1">
        <IconBtn icon="minus" label={`${label}: less`} disabled={value <= min} onClick={() => set(round(value - step))} />
        <IconBtn icon="plus" label={`${label}: more`} disabled={value >= max} onClick={() => set(round(value + step))} />
        <IconBtn icon="reset" label={`${label}: reset to ${format(defaultValue)}`} disabled={value === defaultValue} onClick={() => onChange(defaultValue)} />
      </div>
    </div>
  );
}

/** Page title at the top of a topic (Profiles, Menu Bars, Global). */
function PageHead({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="pb-1">
      <h3 className="m-0 font-mono text-[0.95rem] font-bold tracking-[0.12em] uppercase text-[var(--color-green)]">{title}</h3>
      {children && <p className="m-0 mt-1 text-[0.65rem] leading-snug text-[var(--text-secondary)]">{children}</p>}
    </header>
  );
}

/** Section heading: accent bar · name · hairline to the edge, with an optional one-line hint. */
function SectionHead({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="mb-2.5 pt-5">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-3.5 w-[3px] shrink-0 bg-[var(--color-green)]" />
        <h4 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.14em] uppercase text-[var(--text-primary)]">{title}</h4>
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border)]" />
      </div>
      {hint && <p className="m-0 mt-1 pl-[11px] text-[0.6rem] leading-snug text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

function Choice({ label, hint, value, options, onChange }: {
  label: string;
  hint?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}): React.JSX.Element {
  // A stored value outside the list (set elsewhere) still shows as its own option.
  const opts = options.some((o) => o.value === value) ? options : [...options, { value, label: value }];
  return (
    <div className="flex items-center gap-3">
      <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-44 shrink-0">{label}</span>
      <Dropdown value={value} options={opts} onChange={onChange} ariaLabel={label} />
      {hint && <span className="text-[0.6rem] text-[var(--text-muted)]">{hint}</span>}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <CheckBox checked={checked} onChange={onChange} className="text-[0.7rem] tracking-wider text-[var(--text-secondary)]">
        {label}
      </CheckBox>
      {hint && <span className="text-[0.6rem] text-[var(--text-muted)] pt-0.5">{hint}</span>}
    </div>
  );
}

interface KvEnvelope<T> { value: T; updatedAt: number; }
interface ThemeKv { themeIdDark?: string; themeIdLight?: string; colorMode?: ColorMode; }

/** Read current color-mode preference from the OS KV (`os/theme`). */
async function fetchColorMode(): Promise<ColorMode> {
  try {
    const res = await fetch('/api/kv/os/theme');
    if (!res.ok) return 'dark';
    const body = await res.json() as KvEnvelope<ThemeKv>;
    return body.value?.colorMode ?? 'dark';
  } catch { return 'dark'; }
}
async function writeColorMode(mode: ColorMode): Promise<void> {
  try {
    // PUT to /api/kv/os/theme replaces the whole value — read-modify-write
    // so we don't blow away the user's theme picks while toggling mode.
    const current = await fetch('/api/kv/os/theme');
    const previous: ThemeKv = current.ok
      ? (await current.json() as KvEnvelope<ThemeKv>).value ?? {}
      : {};
    const r = await fetch('/api/kv/os/theme', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: { ...previous, colorMode: mode } }),
    });
    if (!r.ok) console.warn('[ViewportDialog] colorMode PUT not ok', r.status, await r.text());
  } catch (err) {
    console.warn('[ViewportDialog] set colorMode failed', err);
  }
}

function resolveMode(pref: ColorMode): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

export function ViewportSettingsDialog(): React.JSX.Element {
  const [open, setOpen]         = React.useState(false);
  const [vp, setVp]             = React.useState<ViewportState | null>(null);
  const [linkSides, setLinkSides] = React.useState(false);
  const [colorMode, setColorMode] = React.useState<ColorMode>('dark');
  const [resolvedMode, setResolvedMode] = React.useState<'light' | 'dark'>('dark');
  const [isFullscreen, setIsFullscreen] = React.useState<boolean>(false);
  // The profile-name input is decoupled from the profile's stored name: it
  // starts empty whenever the active profile changes so a freshly-created
  // profile doesn't make the user delete its auto-generated "Profile N"
  // before typing. The placeholder shows the current internal name as a hint;
  // the user's keystrokes overwrite it via renameProfile.
  const [nameDraft, setNameDraft] = React.useState('');
  // Which SETTINGS TOPIC the left rail is showing: per-profile settings
  // ('profiles') or the device-wide pane ('global'). Within 'profiles' the
  // specific profile is the live active one (the horizontal tabs switch it), so
  // it needs no separate state. Seeded to 'profiles' on open so VIEWPORT shows first.
  const [section, setSection] = React.useState<Section>('profiles');
  const listLayerRef = React.useRef<HTMLDivElement>(null);

  // MENU BARS: device prefs (lib/barsPrefs) + the auto-hide switch StatusBar owns.
  const [bars, setBars] = React.useState<BarsPrefs>(() => loadBarsPrefs());
  const [autohide, setAutohide] = React.useState<boolean>(false); // read from <body> on open (SSR-safe)
  React.useEffect(() => onBarsPrefs(setBars), []);
  React.useEffect(() => {
    const onSwitch = (e: Event) => setAutohide(!!(e as CustomEvent<{ on?: boolean }>).detail?.on);
    window.addEventListener(AUTOHIDE_EVENT, onSwitch);
    return () => window.removeEventListener(AUTOHIDE_EVENT, onSwitch);
  }, []);
  const patchBars = (patch: Partial<BarsPrefs>) => setBars(saveBarsPrefs(patch));
  const switchAutohide = (on: boolean) => {
    const set = (window as unknown as { auraSetAutohideBars?: (on: boolean) => void }).auraSetAutohideBars;
    set?.(on);
    setAutohide(document.body.dataset['autohideBars'] === 'on');
  };

  // Subscribe to viewport state for the island's lifetime. init() wires the
  // cross-tab `storage` sync (idempotent) and applies the active profile;
  // refresh() loads from localStorage if the StatusBar script hasn't yet;
  // subscribe() replays the current state immediately.
  React.useEffect(() => {
    viewportClient.init();
    const cached: ViewportState | null = viewportClient.getCached();
    if (cached) setVp(cached);
    else void viewportClient.refresh();
    return viewportClient.subscribe(setVp);
  }, []);

  // Open on custom event from the gear button. Refresh color-mode + fullscreen
  // (viewport state already streams in via the subscription above) and open on
  // the Profiles topic so the dialog always lands on VIEWPORT.
  React.useEffect(() => {
    const onOpen = () => {
      setLinkSides(false);
      void fetchColorMode().then((m) => {
        setColorMode(m);
        setResolvedMode(resolveMode(m));
      });
      setIsFullscreen(!!document.fullscreenElement);
      setBars(loadBarsPrefs());
      setAutohide(document.body.dataset['autohideBars'] === 'on');
      setSection('profiles');
      setOpen(true);
    };
    return onOpenRequest('aura.viewport.open', onOpen);
  }, []);

  // Track fullscreen + prefers-color-scheme externally so the dialog is honest
  // about state the user could have changed elsewhere.
  React.useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    const mql = window.matchMedia?.('(prefers-color-scheme: light)');
    const onMql = () => setResolvedMode(resolveMode(colorMode));
    mql?.addEventListener?.('change', onMql);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      mql?.removeEventListener?.('change', onMql);
    };
  }, [colorMode]);

  // Listen to live theme/mode broadcasts from the shell so the picker stays in
  // sync if the user changes it from Settings while the dialog is open.
  React.useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data?.colorMode as ColorMode | undefined;
      if (ev.data?.type === 'aura.mode.changed' && m) {
        setColorMode(m);
        setResolvedMode(resolveMode(m));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Derive the active profile + its values from the client state.
  const profiles: ViewportProfile[] = vp?.profiles ?? [defaultProfile()];
  const active: ViewportProfile =
    profiles.find((p) => p.id === vp?.activeProfileId) ?? profiles[0]!;
  const { zoom, shellZoom, appZoom, margins } = active;

  // Reset the name draft to empty whenever the active profile changes so the
  // input is blank for a "type a name" affordance — the internal name stays
  // as-is and shows through as the placeholder.
  React.useEffect(() => { setNameDraft(''); }, [active.id]);

  // ── Viewport mutations (all funnel through viewportClient) ──
  const applyZoom      = (n: number) => viewportClient.patchActive({ zoom: n });
  const applyShellZoom = (n: number) => viewportClient.patchActive({ shellZoom: n });
  const applyAppZoom   = (n: number) => viewportClient.patchActive({ appZoom: n });
  function applyMargin(side: keyof ViewportMargins, value: number) {
    if (linkSides) viewportClient.patchActive({ margins: { top: value, right: value, bottom: value, left: value } });
    else           viewportClient.patchActive({ margins: { [side]: value } });
  }
  const resetMargins   = () => viewportClient.patchActive({ margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  const resetAll       = () => viewportClient.patchActive({ zoom: 1, shellZoom: 1, appZoom: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 } });

  // Dev-only: device-wide auto-reload-on-source-change. Defaults ON; flipping
  // it OFF makes lib/devReload suppress Vite full reloads so OS state survives
  // edits. Top-level state (not per-profile) — read from `vp`, written here.
  const autoReload     = vp?.autoReload ?? true;
  const setAutoReload  = (on: boolean) => viewportClient.setAutoReload(on);

  // ── Profile management ──
  const switchProfile = (id: string) => viewportClient.setActive(id);
  const addProfile    = () => viewportClient.addProfile();
  const deleteActive  = () => viewportClient.deleteProfile(active.id);
  // Persist only non-empty typed values — clearing the field keeps the
  // profile's existing internal name (which the placeholder reveals).
  function onNameInput(v: string) {
    setNameDraft(v);
    if (v.trim()) viewportClient.renameProfile(active.id, v);
  }

  // Selecting a profile tab switches the LIVE active profile (applies
  // instantly); the horizontal tab highlight follows `active.id` derived above.
  const selectProfile = (id: string) => switchProfile(id);
  const showGlobal = section === 'global';
  const showBars = section === 'bars';

  async function pickColorMode(next: ColorMode) {
    setColorMode(next);
    setResolvedMode(resolveMode(next));
    await writeColorMode(next);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else                            await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn('[ViewportDialog] fullscreen toggle failed', err);
    }
  }

  const sectionLabel = (sec: Section, icon: string, label: string, title: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={section === sec}
      title={title}
      onClick={() => setSection(sec)}
      className={RAIL_TAB}
    >
      <span aria-hidden="true"><svg className="aura-icon" aria-hidden="true"><use href={`/api/os/icons.svg#lucide-${icon}`}/></svg></span>
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <NativeDialog
      open={open}
      onClose={() => setOpen(false)}
      title="VIEWPORT"
      icon="layout-grid"
      role="viewport-dialog"
      className="max-w-3xl h-[80%]"
      footer={
        <div className="flex justify-end gap-2">
          {section === 'profiles' && <Btn tone="ghost" onClick={resetAll}>RESET VIEWPORT</Btn>}
          {showBars && <Btn tone="ghost" onClick={() => patchBars(BARS_PREFS_DEFAULTS)}>RESET MENU BARS</Btn>}
          <Btn tone="exec" onClick={() => setOpen(false)}>DONE</Btn>
        </div>
      }
      extra={
        // Open dropdown lists render here (above the panes, not clipped by their scroll).
        <div ref={listLayerRef} className="pointer-events-none absolute inset-0 z-10" data-role="list-layer" />
      }
    >
      <ListLayer.Provider value={listLayerRef}>
        <div className="flex flex-row items-stretch flex-1 min-h-0">
          {/* Vertical TOPIC rail. */}
          <div role="tablist" aria-orientation="vertical" aria-label="Settings" className={RAIL_LIST}>
            <div className="px-3 pt-3 pb-1.5 font-mono text-[0.6rem] font-semibold tracking-[0.18em] uppercase text-[var(--text-secondary)]">Settings</div>
            {sectionLabel('profiles', 'layout-grid', 'PROFILES', 'Per-profile viewport settings')}
            {sectionLabel('bars', 'unfold-vertical', 'MENU BARS', 'Top bar and Dock: auto-hide, delays, edge badge')}
            {sectionLabel('global', 'settings', 'GLOBAL', 'Device-wide settings (all profiles)')}
          </div>

          {/* ── RIGHT PANE ── */}
          <div role="tabpanel" className={RIGHT_PANE}>
            {showBars ? (
              <>
                <PageHead title="Menu Bars">The top bar and the Dock on this device. Saved right away.</PageHead>

                <section className="space-y-2">
                  <SectionHead title="Auto-hide" />
                  <Toggle
                    label="Auto-hide menu bars"
                    hint="The desktop fills the screen; the bars slide in at the screen edge"
                    checked={autohide}
                    onChange={switchAutohide}
                  />
                  <Choice
                    label="Top bar"
                    value={bars.keepTop ? 'keep' : 'auto'}
                    options={BAR_MODE}
                    onChange={(v) => patchBars({ keepTop: v === 'keep' })}
                  />
                  <Choice
                    label="Bottom bar (Dock)"
                    value={bars.keepBottom ? 'keep' : 'auto'}
                    options={BAR_MODE}
                    onChange={(v) => patchBars({ keepBottom: v === 'keep' })}
                  />
                  {!autohide && (
                    <p className="text-[0.6rem] text-[var(--text-muted)]">Auto-hide is off: both bars are shown. These settings apply once it's on.</p>
                  )}
                </section>

                <section className="space-y-2">
                  <SectionHead title="Timing" />
                  <Choice
                    label="Hide after"
                    hint="once the pointer leaves the bar"
                    value={String(bars.hideDelayMs)}
                    options={HIDE_DELAYS.map((ms) => ({ value: String(ms), label: withDefault(secs(ms), ms === BARS_PREFS_DEFAULTS.hideDelayMs) }))}
                    onChange={(v) => patchBars({ hideDelayMs: Number(v) })}
                  />
                  <Choice
                    label="Show after resting at the edge"
                    hint="avoids bars popping up by accident"
                    value={String(bars.revealDelayMs)}
                    options={REVEAL_DELAYS.map((ms) => ({ value: String(ms), label: withDefault(secs(ms), ms === BARS_PREFS_DEFAULTS.revealDelayMs) }))}
                    onChange={(v) => patchBars({ revealDelayMs: Number(v) })}
                  />
                  <Choice
                    label="Badge tap shows bars for"
                    value={String(bars.peekMs)}
                    options={PEEK_TIMES.map((ms) => ({ value: String(ms), label: withDefault(secs(ms), ms === BARS_PREFS_DEFAULTS.peekMs) }))}
                    onChange={(v) => patchBars({ peekMs: Number(v) })}
                  />
                </section>

                <section className="space-y-2">
                  <SectionHead title="Bringing the bars back" />
                  <Toggle
                    label="Mouse at the screen edge shows the bar"
                    checked={bars.edgeHover}
                    onChange={(on) => patchBars({ edgeHover: on })}
                  />
                  <Choice
                    label="Edge strip"
                    hint="how close to the edge counts"
                    value={String(bars.hotZonePx)}
                    options={HOT_ZONES.map((px) => ({ value: String(px), label: withDefault(`${px} px`, px === BARS_PREFS_DEFAULTS.hotZonePx) }))}
                    onChange={(v) => patchBars({ hotZonePx: Number(v) })}
                  />
                  <Toggle
                    label="Edge badge"
                    hint="tap to show the bars, hold and drag to move it — the touch way back"
                    checked={bars.showBadge}
                    onChange={(on) => patchBars({ showBadge: on })}
                  />
                  {!bars.showBadge && !bars.edgeHover && !(bars.keepTop && bars.keepBottom) && (
                    <p className="text-[0.6rem] text-[var(--color-amber,var(--text-secondary))]">
                      Without the badge and edge hover, auto-hidden bars only come back with the keyboard (Ctrl+Alt+Space).
                    </p>
                  )}
                </section>
              </>
            ) : showGlobal ? (
              <>
                <PageHead title="Global">These apply to the whole device, across all profiles.</PageHead>

                {/* COLOR MODE */}
                <section>
                  <SectionHead title="Color mode" hint="Auto follows the device setting." />
                  <div className="flex items-center gap-3">
                    <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Mode</span>
                    <div className="flex-1">
                      <Segmented<ColorMode>
                        label="Color mode"
                        value={colorMode}
                        options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'Auto' }]}
                        onChange={(m) => void pickColorMode(m)}
                      />
                    </div>
                    <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-3 py-1">
                      {resolvedMode}
                    </span>
                  </div>
                </section>

                {/* FULLSCREEN */}
                <section>
                  <SectionHead title="Display" />
                  <div className="flex items-center gap-3">
                    <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Fullscreen</span>
                    <Btn onClick={() => void toggleFullscreen()}>{isFullscreen ? 'EXIT' : 'ENTER'}</Btn>
                    <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-3 py-1">
                      {isFullscreen ? 'ON' : 'OFF'}
                    </span>
                  </div>
                </section>

                {/* DEV — SOURCE RELOAD (dev server only; HMR doesn't exist in prod) */}
                {import.meta.env.DEV && (
                  <section>
                    <SectionHead title="Developer" hint="Dev server only." />
                    <div className="flex items-center gap-3">
                      <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Auto-reload</span>
                      <CheckBox checked={autoReload} onChange={setAutoReload} className="text-[0.65rem] tracking-widest text-[var(--text-secondary)] uppercase">
                        ON SOURCE CHANGE
                      </CheckBox>
                      <span className="flex-1" />
                      <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-3 py-1">
                        {autoReload ? 'ON' : 'OFF'}
                      </span>
                    </div>
                  </section>
                )}
              </>
            ) : (
              <>
                <PageHead title="Profiles">Switch between saved viewports — e.g. one for the TV, one for the phone. These settings belong to the selected profile only.</PageHead>

                {/* HORIZONTAL profile tab row — selecting a tab switches the
                    live active profile; "+ NEW" copies the current one and
                    switches to it. */}
                <div role="tablist" aria-label="Profiles" className="flex flex-wrap items-end w-full border-b border-[var(--border)]">
                  {profiles.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="tab"
                      aria-selected={p.id === active.id}
                      title={`Switch to "${p.name}"`}
                      onClick={() => selectProfile(p.id)}
                      className={ROW_TAB}
                    >
                      {p.name || p.id}
                    </button>
                  ))}
                  <Btn tone="ghost" className="ml-1 self-center" onClick={() => addProfile()} title="Add a profile (copies the current one)">
                    + NEW
                  </Btn>
                </div>

                {/* Profile name + delete. */}
                <div className="flex items-center gap-3">
                  <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Name</span>
                  <input
                    type="text"
                    value={nameDraft}
                    placeholder={active.name}
                    onChange={(e) => onNameInput(e.target.value)}
                    aria-label="Profile name"
                    className="flex-1 bg-transparent border border-[var(--border)] text-[var(--text-primary)] font-mono text-[0.7rem] tracking-wider px-2 py-1 outline-none focus:border-[var(--color-green)]"
                  />
                  <Btn
                    onClick={deleteActive}
                    disabled={profiles.length <= 1}
                    title={profiles.length <= 1 ? 'Keep at least one profile' : `Delete "${active.name}"`}
                  >
                    DELETE
                  </Btn>
                </div>

                {/* ZOOM — three composable layers. "Everything" scales the whole
                    surface; "Shell" scales only the OS chrome (bars, window frames +
                    buttons); "Apps" scales only app content (iframes). Net app
                    content = Everything × Apps, independent of the Shell zoom. */}
                <section>
                  <SectionHead title="Zoom" hint="Everything scales the whole screen, Shell only the OS chrome, Apps only app content." />
                  <div className="space-y-2">
                    {([
                      ['Everything', zoom, applyZoom],
                      ['Shell', shellZoom, applyShellZoom],
                      ['Apps', appZoom, applyAppZoom],
                    ] as const).map(([label, value, apply]) => (
                      <SliderRow
                        key={label}
                        label={label}
                        value={value}
                        min={ZOOM_MIN}
                        max={ZOOM_MAX}
                        step={ZOOM_STEP}
                        defaultValue={1}
                        format={(v) => `${Math.round(v * 100)}%`}
                        onChange={apply}
                      />
                    ))}
                  </div>
                </section>

                {/* MARGINS */}
                <section>
                  <SectionHead title="Screen margins" hint="Space between the screen edge and AuraOS — e.g. for TV overscan." />
                  <div className="space-y-2">
                    {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                      <SliderRow
                        key={side}
                        label={side.charAt(0).toUpperCase() + side.slice(1)}
                        labelClass="w-20"
                        value={margins[side]}
                        min={0}
                        max={MARGIN_MAX}
                        step={MARGIN_STEP}
                        defaultValue={0}
                        format={(v) => `${v}px`}
                        onChange={(v) => applyMargin(side, Math.round(v))}
                      />
                    ))}
                    <div className="flex items-center gap-3 pt-1">
                      <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-20">Uniform</span>
                      <CheckBox checked={linkSides} onChange={setLinkSides} className="text-[0.65rem] tracking-widest text-[var(--text-secondary)] uppercase">
                        LINK ALL SIDES
                      </CheckBox>
                      <span className="flex-1" />
                      <Btn onClick={resetMargins}>RESET MARGINS</Btn>
                    </div>
                  </div>
                </section>

                {/* THEME — each profile keeps its own favourite light + dark palette.
                    Clicking a swatch sets the active profile's pick AND pushes the
                    new pair to os/theme (so the rest of the OS picks it up through
                    the existing CSS/iframe broadcast path). */}
                <section>
                  <SectionHead title="Theme" hint="The palette this profile uses in dark and in light mode." />
                  <div className="space-y-2">
                    {(['dark', 'light'] as const).map((tone) => {
                      const picked = tone === 'dark' ? active.themeIdDark : active.themeIdLight;
                      return (
                        <div key={tone} className="flex items-start gap-3">
                          <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16 pt-1 capitalize">{tone}</span>
                          <div className="flex-1 flex flex-wrap gap-1.5">
                            {ThemeManager.getThemesByTone(tone).map((t) => (
                              <Btn
                                key={t.id}
                                tone={t.id === picked ? 'exec' : 'outline'}
                                aria-pressed={t.id === picked}
                                onClick={() => viewportClient.patchActive(tone === 'dark' ? { themeIdDark: t.id } : { themeIdLight: t.id })}
                                title={t.description ?? t.name}
                              >
                                {t.name}
                              </Btn>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </ListLayer.Provider>
    </NativeDialog>
  );
}

export default ViewportSettingsDialog;
