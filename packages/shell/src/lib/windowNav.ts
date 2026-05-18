/**
 * Pure window-navigation helpers used by the dispatcher's Nav mode.
 *
 * Inputs are minimal (an ordered viewId list + the optional bbox rects for
 * stack-style layouts) so this module stays trivially testable. The shell
 * layer wires these into the keymap dispatcher's `aura.nav.up/down/left/
 * right` handlers — see `pages/index.astro`.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export interface ViewRect {
  viewId: string;
  /** Center-x of the slot in CSS pixels. */
  cx: number;
  /** Center-y of the slot. */
  cy: number;
  /** Slot width. */
  w:  number;
  /** Slot height. */
  h:  number;
}

/**
 * Compute the next view to focus given the current one + a direction.
 *
 * For the tiling layout the geometry collapses to a grid (cols = ceil(sqrt(n)))
 * and we step by row/column. For stack/windowed layouts we pick the closest
 * neighbour whose center lies in the requested half-plane (and slightly off
 * the centerline so a strictly-aligned column still resolves).
 *
 * Returns `currentViewId` (a no-op) when no neighbour exists in that direction —
 * keeping the focus where it is so the user notices the wall.
 */
export function nextInDirection(
  rects: readonly ViewRect[],
  currentViewId: string,
  dir: NavDirection,
): string {
  if (rects.length === 0) return currentViewId;
  const current = rects.find((r) => r.viewId === currentViewId);
  if (!current) return rects[0]!.viewId;

  // Distance helper — lower is better.
  // Penalise off-axis movement so straight steps win over diagonals.
  const score = (cand: ViewRect): number | null => {
    const dx = cand.cx - current.cx;
    const dy = cand.cy - current.cy;
    if (dir === 'up'    && dy >= -1) return null;
    if (dir === 'down'  && dy <=  1) return null;
    if (dir === 'left'  && dx >= -1) return null;
    if (dir === 'right' && dx <=  1) return null;
    // Primary axis = the direction we're moving in; orthogonal axis is the
    // penalty multiplier.
    const along = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
    const off   = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    return along + off * 2;
  };

  let best: ViewRect | null = null;
  let bestScore = Infinity;
  for (const cand of rects) {
    if (cand.viewId === currentViewId) continue;
    const s = score(cand);
    if (s === null) continue;
    if (s < bestScore) { bestScore = s; best = cand; }
  }
  return best ? best.viewId : currentViewId;
}

/**
 * Derive `ViewRect`s for a tiling grid given the desktop dimensions and the
 * ordered viewIds visible in the active workspace. Uses the same
 * `cols = ceil(sqrt(n))` rule the `TilingLayout` component renders with so
 * navigation matches what the user sees.
 */
export function tilingRects(viewIds: readonly string[], desktopWidth: number, desktopHeight: number): ViewRect[] {
  const n = viewIds.length;
  if (n === 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = desktopWidth  / cols;
  const h = desktopHeight / rows;
  return viewIds.map((viewId, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      viewId,
      cx: col * w + w / 2,
      cy: row * h + h / 2,
      w,
      h,
    };
  });
}

/**
 * Read a `ViewRect` from a slot's DOM bounding box. Falls back to (0,0,0,0)
 * for slots that aren't laid out yet. Used by stack/windowed layouts where
 * slot positions come from the layout strategy at render time.
 */
export function rectFromSlot(slot: Element, viewId: string): ViewRect {
  const bb = (slot as HTMLElement).getBoundingClientRect();
  return {
    viewId,
    cx: bb.left + bb.width  / 2,
    cy: bb.top  + bb.height / 2,
    w:  bb.width,
    h:  bb.height,
  };
}

/**
 * Context passed to a layout strategy's per-window coordinate function.
 * Carries everything a strategy might need to compute logical positions
 * without depending on the live DOM (e.g. a future "carousel" or "ring"
 * layout that wants ordinal coords). Strategies that want the default
 * live-bbox behaviour simply don't register anything — see `getViewRects`.
 */
export interface LayoutNavContext {
  layoutId:      string;
  desktopWidth:  number;
  desktopHeight: number;
  /** Strategy-specific persisted state (e.g. `rects` for stack mode). */
  layoutState?:  Record<string, unknown>;
  /** Resolver from viewId to the live `.app-slot` element. Used by the
   *  default fallback path (live bboxes) and available to strategy
   *  overrides that still want DOM measurements. */
  slotFor:       (viewId: string) => Element | null;
}

export type GetViewRectsFn = (
  viewIds: readonly string[],
  ctx:     LayoutNavContext,
) => ViewRect[];

/**
 * Per-layoutId override map. A layout strategy that wants to declare
 * logical x/y positions per window (independent of the DOM) registers
 * itself once at module load:
 *
 *   import { registerLayoutRects } from '.../windowNav';
 *   registerLayoutRects('carousel', (viewIds, ctx) => …);
 *
 * No shipped strategy uses this today — tiling / rows / stack / fullscreen
 * all reduce to plain `getBoundingClientRect()` reads, which the default
 * path in `getViewRects` already handles.
 */
const layoutRectOverrides = new Map<string, GetViewRectsFn>();
export function registerLayoutRects(layoutId: string, fn: GetViewRectsFn): void {
  layoutRectOverrides.set(layoutId, fn);
}

/**
 * Resolve every view's rect under the active layout. Looks up a registered
 * override first; falls back to reading live DOM bounding boxes via
 * `rectFromSlot`. The fallback covers every currently-shipped strategy
 * (the CSS Grid + absolute-positioned layouts all produce sensible bboxes).
 *
 * Returns `(0,0,0,0)` rects for views whose slot can't be resolved — keeps
 * caller code straightforward without scattering null checks.
 */
export function getViewRects(
  viewIds: readonly string[],
  ctx:     LayoutNavContext,
): ViewRect[] {
  const override = layoutRectOverrides.get(ctx.layoutId);
  if (override) return override(viewIds, ctx);
  return viewIds.map((vid) => {
    const slot = ctx.slotFor(vid);
    return slot ? rectFromSlot(slot, vid) : { viewId: vid, cx: 0, cy: 0, w: 0, h: 0 };
  });
}
