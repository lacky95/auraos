/**
 * barsPrefs — device preferences for the menu bars (top status bar + bottom
 * Dock) in auto-hide mode. Edited on the viewport dialog's MENU BARS page,
 * applied by StatusBar's auto-hide script. Persisted in device localStorage
 * (like the auto-hide switch itself, `aura.shell.autohide-bars`), so a TV and
 * a phone can keep different bar habits.
 *
 * Changes travel as a window event (same tab) and the `storage` event (other
 * tabs); StatusBar re-reads on both.
 */

export interface BarsPrefs {
  /** Auto-hide on: the top bar stays shown anyway (only the Dock hides). */
  keepTop: boolean;
  /** Auto-hide on: the Dock stays shown anyway (only the top bar hides). */
  keepBottom: boolean;
  /** How long a revealed bar stays after the pointer leaves it. */
  hideDelayMs: number;
  /** How long the pointer must rest at the screen edge before a bar appears. */
  revealDelayMs: number;
  /** Thickness of the screen-edge strip that reveals a bar. */
  hotZonePx: number;
  /** Reveal bars by moving the mouse to the screen edge. */
  edgeHover: boolean;
  /** Show the edge badge (tap → peek the bars; the touch way back). */
  showBadge: boolean;
  /** How long a badge tap shows the bars. */
  peekMs: number;
}

export const BARS_PREFS_DEFAULTS: BarsPrefs = {
  keepTop: false,
  keepBottom: false,
  hideDelayMs: 1800,
  revealDelayMs: 0,
  hotZonePx: 12,
  edgeHover: true,
  showBadge: true,
  peekMs: 6000,
};

export const BARS_PREFS_KEY = 'aura.shell.bars-prefs';
/** Same-tab change notification (detail: the new BarsPrefs). */
export const BARS_PREFS_EVENT = 'aura:bars-prefs';
/** StatusBar announces the auto-hide switch (detail: { on: boolean }). */
export const AUTOHIDE_EVENT = 'aura:autohide-bars';

const num = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt;
const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);

/** Unknown / broken values fall back to the defaults, field by field. */
export function normalizeBarsPrefs(raw: unknown): BarsPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof BarsPrefs, unknown>>;
  const d = BARS_PREFS_DEFAULTS;
  return {
    keepTop: bool(r.keepTop, d.keepTop),
    keepBottom: bool(r.keepBottom, d.keepBottom),
    hideDelayMs: num(r.hideDelayMs, 200, 60_000, d.hideDelayMs),
    revealDelayMs: num(r.revealDelayMs, 0, 5_000, d.revealDelayMs),
    hotZonePx: num(r.hotZonePx, 2, 80, d.hotZonePx),
    edgeHover: bool(r.edgeHover, d.edgeHover),
    showBadge: bool(r.showBadge, d.showBadge),
    peekMs: num(r.peekMs, 1_000, 120_000, d.peekMs),
  };
}

export function loadBarsPrefs(): BarsPrefs {
  try {
    return normalizeBarsPrefs(JSON.parse(localStorage.getItem(BARS_PREFS_KEY) ?? 'null'));
  } catch {
    return { ...BARS_PREFS_DEFAULTS };
  }
}

export function saveBarsPrefs(patch: Partial<BarsPrefs>): BarsPrefs {
  const next = normalizeBarsPrefs({ ...loadBarsPrefs(), ...patch });
  try {
    localStorage.setItem(BARS_PREFS_KEY, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new CustomEvent(BARS_PREFS_EVENT, { detail: next }));
  return next;
}

/** Calls `fn` with the current prefs on every change (this tab and others). */
export function onBarsPrefs(fn: (p: BarsPrefs) => void): () => void {
  const local = () => fn(loadBarsPrefs());
  const other = (e: StorageEvent) => { if (e.key === BARS_PREFS_KEY) fn(loadBarsPrefs()); };
  window.addEventListener(BARS_PREFS_EVENT, local);
  window.addEventListener('storage', other);
  return () => {
    window.removeEventListener(BARS_PREFS_EVENT, local);
    window.removeEventListener('storage', other);
  };
}
